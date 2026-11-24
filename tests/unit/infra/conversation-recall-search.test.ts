import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, type AsyncEventReadSurface, type LocalSqliteEventStore } from "../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE } from "../../../src/infra/conversation-fts.js"
import { countConversationRecall as count, searchConversationRecall as search, type RecallSearchQuery } from "../../../src/infra/conversation-recall-search.js"
import { DebugLog, type DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { buildFtsMatch } from "../../../src/orchestration/session/conversation-records/conversation-recall.js"

const CONVERSATION_ID = "conv-1"
const AGGREGATE = `conversation:${CONVERSATION_ID}`

let tmpDir: string
let dbPath: string
let store: LocalSqliteEventStore

function userEntry(id: string, parentId: string | null, text: string) {
  return { kind: "message", id, parentId, timestamp: new Date().toISOString(), message: { kind: "user", content: text } }
}

function appendEntries(type: "chat.entries.appended", entries: ReadonlyArray<{ [key: string]: unknown }>): void {
  store.append({
    aggregateId: AGGREGATE,
    type,
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: CONVERSATION_ID,
    payload: { conversationId: CONVERSATION_ID, entries },
  })
}

function appendChat(sessionId: string, entries: ReadonlyArray<{ [key: string]: unknown }>): void {
  store.append({
    aggregateId: `conversation:${sessionId}`,
    type: "chat.entries.appended",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { conversationId: sessionId, entries },
  })
}

function appendDeletion(sessionId: string): void {
  store.append({ aggregateId: `session:${sessionId}`, type: "session.deleted", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId, payload: {} })
}

function appendWorkflowDeletion(workflowId: string): void {
  store.append({ aggregateId: `workflow:${workflowId}`, type: "workflow.run.deleted", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: workflowId, payload: { lastUpdated: new Date().toISOString() } })
}

function indexedRows(db: Database) {
  return {
    fts: db.query(`select conversation_id, entry_id from ${CONVERSATION_FTS_TABLE} order by rowid`).all(),
    sessions: db.query("select distinct session_id from conversation_index_session_rows order by session_id").all(),
  }
}

function appendProvisional(entry: { [key: string]: unknown }): void {
  store.append({
    aggregateId: AGGREGATE,
    type: "chat.entry.provisional",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: CONVERSATION_ID,
    payload: { conversationId: CONVERSATION_ID, entry },
  })
}

/** Runs `read` against the production search index, caught up through every stored fact. */
async function withIndexedDb(read: (db: Database) => void): Promise<void> {
  const index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store), [])
  try {
    read(await index.through(store.currentPosition()))
  } finally {
    await index.dispose()
  }
}

function searchConversationRecall(db: Database, query: Omit<RecallSearchQuery, "upperPosition">) {
  return search(db, { ...query, upperPosition: store.currentPosition() })
}

function countConversationRecall(db: Database, query: Omit<RecallSearchQuery, "upperPosition">) {
  return count(db, { ...query, upperPosition: store.currentPosition() })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-recall-search-"))
  dbPath = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbPath)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("searchConversationRecall", () => {
  test("shared index releases are idempotent and a surviving consumer stays usable", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "retained")])
    const file = path.join(tmpDir, "search.sqlite")
    const source = asAsyncEventReadSurface(store)
    const first = acquireConversationSearchIndex(file, source, [])
    const second = acquireConversationSearchIndex(file, source, [])
    await first.through(store.currentPosition())
    await Promise.all([first.dispose(), first.dispose()])
    const db = await second.through(store.currentPosition())
    expect(count(db, { upperPosition: store.currentPosition(), conversationId: CONVERSATION_ID, match: "retained", limit: 5 })).toBe(1)
    const third = acquireConversationSearchIndex(file, source, [])
    await Promise.all([second.dispose(), third.dispose()])
    const reopened = acquireConversationSearchIndex(file, source, [])
    try {
      expect(await reopened.through(store.currentPosition())).toBeInstanceOf(Database)
    } finally {
      await reopened.dispose()
    }
  })

  test("final release waits for held catch-up before closing the shared index", async () => {
    let releaseRead: (() => void) | undefined
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve })
    let readStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    const source: AsyncEventReadSurface = {
      capturePosition: async () => 1,
      readPage: async (_query, upperPosition = 1) => {
        readStarted?.()
        await readHeld
        return {
          facts: [],
          upperPosition,
          continuationPosition: null,
          toolContent: { resolve: () => { throw new Error("This fixture has no referenced content") } },
        }
      },
    }
    const dbFile = path.join(tmpDir, "conversation-search.sqlite")
    const diagnostics: DebugLogRecordInput[] = []
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => {
      const db = new Database(dbFile, { readonly: true })
      try {
        expect(db.query<{ position: number }, []>("select position from conversation_index_position").get()?.position).toBe(0)
      } finally {
        db.close()
      }
      diagnostics.push(entry)
    })
    try {
      const index = acquireConversationSearchIndex(dbFile, source, [])
      const catchup = index.through(1)
      await started
      let closed = false
      const closing = index.dispose().then(() => { closed = true })

      await Bun.sleep(0)
      expect(closed).toBe(false)
      releaseRead?.()
      await Promise.all([catchup, closing])
      expect(closed).toBe(true)
      expect(diagnostics).toEqual([{
        type: "conversation.fts.write",
        payload: {
          indexedThroughPosition: 0,
          pageThroughPosition: 1,
          requestedThroughPosition: 1,
        },
      }])
    } finally {
      record.mockRestore()
    }
  })

  test("derived catch-up is bounded and page/count exclude a later indexed append", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka first")])
    const upperPosition = store.currentPosition()
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka later")])
    const index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store), [])
    try {
      const db = await index.through(store.currentPosition())
      const query = { upperPosition, conversationId: CONVERSATION_ID, match: "kafka", limit: 5 }
      expect(search(db, query).map((hit) => hit.entryId)).toEqual(["a"])
      expect(count(db, query)).toBe(1)
      expect(db.query("select position from conversation_index_position").get()).toEqual({ position: store.currentPosition() })
    } finally {
      await index.dispose()
    }
  })

  test("missing and version-invalid derived files rebuild retained history", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka retained")])
    const file = path.join(tmpDir, "search.sqlite")
    for (const invalidate of ["missing", "version"] as const) {
      let index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store), [])
      await index.through(store.currentPosition())
      await index.dispose()
      if (invalidate === "missing") fs.unlinkSync(file)
      else {
        const db = new Database(file)
        db.exec("pragma user_version = 999")
        db.close()
      }
      index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store), [])
      try {
        const db = await index.through(store.currentPosition())
        expect(searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 }).map((hit) => hit.entryId)).toEqual(["a"])
      } finally {
        await index.dispose()
      }
    }
  })

  test("a deletion removes the rows that the index already holds for that session", async () => {
    appendChat("kept", [userEntry("k", null, "kafka kept")])
    appendChat("gone", [userEntry("g", null, "kafka gone")])
    const index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store), ["workflow.run.deleted"])
    try {
      let db = await index.through(store.currentPosition())
      expect(indexedRows(db).fts).toEqual([{ conversation_id: "kept", entry_id: "k" }, { conversation_id: "gone", entry_id: "g" }])
      appendDeletion("gone")
      db = await index.through(store.currentPosition())
      expect(indexedRows(db)).toEqual({ fts: [{ conversation_id: "kept", entry_id: "k" }], sessions: [{ session_id: "kept" }] })
      expect(db.query(`select count(*) as c from ${CONVERSATION_FTS_TABLE} where ${CONVERSATION_FTS_TABLE} match 'kafka'`).get()).toEqual({ c: 1 })
      // A deleted workflow loses its tool content but keeps its chat facts, so it leaves the index the same way.
      appendChat("workflow", [userEntry("w", null, "kafka workflow")])
      db = await index.through(store.currentPosition())
      expect(indexedRows(db).sessions).toEqual([{ session_id: "kept" }, { session_id: "workflow" }])
      appendWorkflowDeletion("workflow")
      db = await index.through(store.currentPosition())
      expect(indexedRows(db)).toEqual({ fts: [{ conversation_id: "kept", entry_id: "k" }], sessions: [{ session_id: "kept" }] })
    } finally {
      await index.dispose()
    }
  })

  test("a generation 1 index rebuilds without deleted sessions and shrinks", async () => {
    const bulk = Array.from({ length: 2_000 }, (_, index) => `filler${index}`).join(" ")
    appendChat("kept", [userEntry("k", null, "kafka kept")])
    appendChat("gone", [userEntry("g", null, bulk)])
    appendDeletion("gone")
    const file = path.join(tmpDir, "search.sqlite")
    const old = new Database(file)
    old.exec("pragma journal_mode = wal")
    old.exec(`create virtual table ${CONVERSATION_FTS_TABLE} using fts5(content, conversation_id unindexed, entry_id unindexed, entry_kind unindexed, role unindexed, source_position unindexed, tokenize = 'porter unicode61')`)
    old.exec("create table conversation_index_position (position integer not null)")
    old.transaction(() => {
      for (let row = 0; row < 200; row++) {
        old.query(`insert into ${CONVERSATION_FTS_TABLE} values (?, 'gone', ?, 'message', 'user', 1)`).run(`${bulk} ${row}`, `g${row}`)
      }
      old.query("insert into conversation_index_position values (?)").run(store.currentPosition())
    })()
    old.exec("pragma user_version = 1")
    old.close()
    const before = fs.statSync(file).size
    const index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store), [])
    try {
      const db = await index.through(store.currentPosition())
      expect(indexedRows(db)).toEqual({ fts: [{ conversation_id: "kept", entry_id: "k" }], sessions: [{ session_id: "kept" }] })
      expect(fs.statSync(file).size).toBeLessThan(before / 10)
    } finally {
      await index.dispose()
    }
  })

  test("a failed page commits neither its rows nor its watermark", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka original")])
    const file = path.join(tmpDir, "search.sqlite")
    const index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store), [])
    try {
      const before = store.currentPosition()
      const db = await index.through(before)
      appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka staged"), { kind: "unsupported", id: "bad" }])
      await expect(index.through(store.currentPosition())).rejects.toThrow("unexpected chat entry kind")
      expect(db.query("select position from conversation_index_position").get()).toEqual({ position: before })
      expect(db.query(`select entry_id from ${CONVERSATION_FTS_TABLE}`).all()).toEqual([{ entry_id: "a" }])
    } finally {
      await index.dispose()
    }
  })

  test("derived opens refuse linked database and sidecar paths", async () => {
    const target = path.join(tmpDir, "target")
    fs.writeFileSync(target, "do not touch")
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path.join(tmpDir, `index-${suffix || "db"}.sqlite`)
      fs.symlinkSync(target, `${file}${suffix}`)
      const index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store), [])
      try {
        await expect(index.through(0)).rejects.toThrow("symlink")
        expect(fs.readFileSync(target, "utf8")).toBe("do not touch")
      } finally {
        await index.dispose()
      }
    }
  })

  test("primary appends do not create a search index", () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "searchable later")])
    const db = new Database(dbPath, { readonly: true })
    try {
      expect(db.query("select name from sqlite_master where name = ?").get(CONVERSATION_FTS_TABLE)).toBeNull()
    } finally {
      db.close()
    }
  })
  test("returns a match-centered highlighted excerpt after a long prefix", async () => {
    const prefix = Array.from({ length: 80 }, (_, index) => `prefix${index}`).join(" ")
    appendEntries("chat.entries.appended", [userEntry("a", null, `${prefix} kafka trailing context`)])
    await withIndexedDb((db) => {
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(hits[0]?.snippet).toContain("[kafka]")
      expect(hits[0]?.snippet).toStartWith("...")
      expect(hits[0]?.snippet).not.toContain("prefix0")
    })
  })

  test("returns both matches ordered by rank when both match", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka kafka kafka kafka")])
    await withIndexedDb((db) => {
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(new Set(hits.map((h) => h.entryId))).toEqual(new Set(["a", "b"]))
      // The denser turn (more occurrences) ranks first under BM25.
      expect(hits[0]?.entryId).toBe("b")
    })
  })

  test("entryIds allowlist restricts the search; empty set returns no rows", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka")])
    await withIndexedDb((db) => {
      const onlyB = searchConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set(["b"]),
      })
      expect(onlyB.map((h) => h.entryId)).toEqual(["b"])
      expect(onlyB[0]?.snippet).toBe("[kafka]")
      const none = searchConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set<string>(),
      })
      expect(none).toEqual([])
    })
  })

  test("provisional entries are NOT indexed; only the committed append indexes a single row", async () => {
    // The projection discards provisional entries once the committed append
    // supersedes them, so indexing a provisional row would orphan it in the FTS
    // table and corrupt recall counts. Only the committed row may exist.
    appendProvisional(userEntry("a", null, "kafka pipeline"))
    await withIndexedDb((dbAfterProvisional) => {
      const provisionalRows = dbAfterProvisional
        .query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE} where entry_id = 'a'`).all()
      expect(provisionalRows[0]?.c).toBe(0)
    })
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka pipeline")])
    await withIndexedDb((db) => {
      const rows = db.query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE} where entry_id = 'a'`).all()
      expect(rows[0]?.c).toBe(1)
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(hits.map((h) => h.entryId)).toEqual(["a"])
    })
  })

  test("countConversationRecall returns the true total independent of any page limit", async () => {
    const total = 14
    let parent: string | null = null
    for (let i = 0; i < total; i++) {
      const id = `m${i}`
      appendEntries("chat.entries.appended", [userEntry(id, parent, "kafka rebalance")])
      parent = id
    }
    await withIndexedDb((db) => {
      // limit is intentionally far below the true count: count() ignores it.
      const resultCount = countConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 3 })
      expect(resultCount).toBe(total)
    })
  })

  test("countConversationRecall honors the lineage entryIds allowlist", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka")])
    appendEntries("chat.entries.appended", [userEntry("c", "b", "kafka")])
    await withIndexedDb((db) => {
      const scoped = countConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set(["a", "c"]),
      })
      expect(scoped).toBe(2)
      const empty = countConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set<string>(),
      })
      expect(empty).toBe(0)
    })
  })

  test("a query word with punctuation matches the content the tokenizer split", async () => {
    // The tokenizer splits "feature-flag" into feature + flag and "3.11" into
    // 3 + 11; a bareword with "." or an unbalanced quote is an FTS5 syntax error.
    appendEntries("chat.entries.appended", [userEntry("a", null, "toggled the feature-flag rollout")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "boot Windows 3.11 from win311.img")])
    appendEntries("chat.entries.appended", [userEntry("c", "b", "the quick brown fox")])
    appendEntries("chat.entries.appended", [userEntry("d", "c", "unrelated content")])
    await withIndexedDb((db) => {
      for (const [query, entryId] of [["feature-flag", "a"], ["3.11 QEMU", "b"], ["win311.img", "b"], ['"brown', "c"]] as const) {
        const recallQuery = { conversationId: CONVERSATION_ID, match: buildFtsMatch(query), limit: 5 }
        expect(searchConversationRecall(db, recallQuery).map((h) => h.entryId)).toEqual([entryId])
        expect(countConversationRecall(db, recallQuery)).toBe(1)
      }
    })
  })

  test("displayOnly and leaf/label entries produce no FTS row", async () => {
    appendEntries("chat.entries.appended", [
      { kind: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), displayOnly: true, message: { kind: "user", content: "kafka diagnostic" } },
      { kind: "label", id: "b", parentId: "a", timestamp: new Date().toISOString(), targetId: "a", label: "kafka label" },
    ])
    await withIndexedDb((db) => {
      const rows = db.query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE}`).all()
      expect(rows[0]?.c).toBe(0)
    })
  })
})
