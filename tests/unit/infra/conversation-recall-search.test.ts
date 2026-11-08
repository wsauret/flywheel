import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, type AsyncEventReadSurface, type LocalSqliteEventStore } from "../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE, createConversationFtsTable, indexChatEntriesForFts } from "../../../src/infra/conversation-fts.js"
import { countConversationRecall as count, searchConversationRecall as search, type RecallSearchQuery } from "../../../src/infra/conversation-recall-search.js"
import { DebugLog, type DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { buildFtsMatch } from "../../../src/orchestration/session/conversation-recall.js"

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

function openReadDb(): Database {
  const db = new Database(":memory:")
  createConversationFtsTable(db)
  for (const fact of store.read()) indexChatEntriesForFts(db, fact, store.toolContent)
  return db
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
    const first = acquireConversationSearchIndex(file, source)
    const second = acquireConversationSearchIndex(file, source)
    await first.through(store.currentPosition())
    await Promise.all([first.dispose(), first.dispose()])
    const db = await second.through(store.currentPosition())
    expect(count(db, { upperPosition: store.currentPosition(), conversationId: CONVERSATION_ID, match: "retained", limit: 5 })).toBe(1)
    const third = acquireConversationSearchIndex(file, source)
    await Promise.all([second.dispose(), third.dispose()])
    const reopened = acquireConversationSearchIndex(file, source)
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
      const index = acquireConversationSearchIndex(dbFile, source)
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
    const index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store))
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
      let index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store))
      await index.through(store.currentPosition())
      await index.dispose()
      if (invalidate === "missing") fs.unlinkSync(file)
      else {
        const db = new Database(file)
        db.exec("pragma user_version = 999")
        db.close()
      }
      index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store))
      try {
        const db = await index.through(store.currentPosition())
        expect(searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 }).map((hit) => hit.entryId)).toEqual(["a"])
      } finally {
        await index.dispose()
      }
    }
  })

  test("a failed page commits neither its rows nor its watermark", async () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka original")])
    const file = path.join(tmpDir, "search.sqlite")
    const index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store))
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
      const index = acquireConversationSearchIndex(file, asAsyncEventReadSurface(store))
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
  test("returns a match-centered highlighted excerpt after a long prefix", () => {
    const prefix = Array.from({ length: 80 }, (_, index) => `prefix${index}`).join(" ")
    appendEntries("chat.entries.appended", [userEntry("a", null, `${prefix} kafka trailing context`)])
    const db = openReadDb()
    try {
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(hits[0]?.snippet).toContain("[kafka]")
      expect(hits[0]?.snippet).toStartWith("...")
      expect(hits[0]?.snippet).not.toContain("prefix0")
    } finally {
      db.close()
    }
  })

  test("returns both matches ordered by rank when both match", () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka kafka kafka kafka")])
    const db = openReadDb()
    try {
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(new Set(hits.map((h) => h.entryId))).toEqual(new Set(["a", "b"]))
      // The denser turn (more occurrences) ranks first under BM25.
      expect(hits[0]?.entryId).toBe("b")
    } finally {
      db.close()
    }
  })

  test("entryIds allowlist restricts the search; empty set returns no rows", () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka")])
    const db = openReadDb()
    try {
      const onlyB = searchConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set(["b"]),
      })
      expect(onlyB.map((h) => h.entryId)).toEqual(["b"])
      expect(onlyB[0]?.snippet).toBe("[kafka]")
      const none = searchConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set<string>(),
      })
      expect(none).toEqual([])
    } finally {
      db.close()
    }
  })

  test("provisional entries are NOT indexed; only the committed append indexes a single row", () => {
    // The projection discards provisional entries once the committed append
    // supersedes them, so indexing a provisional row would orphan it in the FTS
    // table and corrupt recall counts. Only the committed row may exist.
    appendProvisional(userEntry("a", null, "kafka pipeline"))
    const dbAfterProvisional = openReadDb()
    try {
      const provisionalRows = dbAfterProvisional
        .query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE} where entry_id = 'a'`).all()
      expect(provisionalRows[0]?.c).toBe(0)
    } finally {
      dbAfterProvisional.close()
    }
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka pipeline")])
    const db = openReadDb()
    try {
      const rows = db.query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE} where entry_id = 'a'`).all()
      expect(rows[0]?.c).toBe(1)
      const hits = searchConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 5 })
      expect(hits.map((h) => h.entryId)).toEqual(["a"])
    } finally {
      db.close()
    }
  })

  test("countConversationRecall returns the true total independent of any page limit", () => {
    const total = 14
    let parent: string | null = null
    for (let i = 0; i < total; i++) {
      const id = `m${i}`
      appendEntries("chat.entries.appended", [userEntry(id, parent, "kafka rebalance")])
      parent = id
    }
    const db = openReadDb()
    try {
      // limit is intentionally far below the true count: count() ignores it.
      const resultCount = countConversationRecall(db, { conversationId: CONVERSATION_ID, match: "kafka", limit: 3 })
      expect(resultCount).toBe(total)
    } finally {
      db.close()
    }
  })

  test("countConversationRecall honors the lineage entryIds allowlist", () => {
    appendEntries("chat.entries.appended", [userEntry("a", null, "kafka")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "kafka")])
    appendEntries("chat.entries.appended", [userEntry("c", "b", "kafka")])
    const db = openReadDb()
    try {
      const scoped = countConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set(["a", "c"]),
      })
      expect(scoped).toBe(2)
      const empty = countConversationRecall(db, {
        conversationId: CONVERSATION_ID, match: "kafka", limit: 5, entryIds: new Set<string>(),
      })
      expect(empty).toBe(0)
    } finally {
      db.close()
    }
  })

  test("a query word with punctuation matches the content the tokenizer split", () => {
    // The tokenizer splits "feature-flag" into feature + flag and "3.11" into
    // 3 + 11; a bareword with "." or an unbalanced quote is an FTS5 syntax error.
    appendEntries("chat.entries.appended", [userEntry("a", null, "toggled the feature-flag rollout")])
    appendEntries("chat.entries.appended", [userEntry("b", "a", "boot Windows 3.11 from win311.img")])
    appendEntries("chat.entries.appended", [userEntry("c", "b", "the quick brown fox")])
    appendEntries("chat.entries.appended", [userEntry("d", "c", "unrelated content")])
    const db = openReadDb()
    try {
      for (const [query, entryId] of [["feature-flag", "a"], ["3.11 QEMU", "b"], ["win311.img", "b"], ['"brown', "c"]] as const) {
        const recallQuery = { conversationId: CONVERSATION_ID, match: buildFtsMatch(query), limit: 5 }
        expect(searchConversationRecall(db, recallQuery).map((h) => h.entryId)).toEqual([entryId])
        expect(countConversationRecall(db, recallQuery)).toBe(1)
      }
    } finally {
      db.close()
    }
  })

  test("displayOnly and leaf/label entries produce no FTS row", () => {
    appendEntries("chat.entries.appended", [
      { kind: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), displayOnly: true, message: { kind: "user", content: "kafka diagnostic" } },
      { kind: "label", id: "b", parentId: "a", timestamp: new Date().toISOString(), targetId: "a", label: "kafka label" },
    ])
    const db = openReadDb()
    try {
      const rows = db.query<{ c: number }, []>(`select count(*) as c from ${CONVERSATION_FTS_TABLE}`).all()
      expect(rows[0]?.c).toBe(0)
    } finally {
      db.close()
    }
  })
})
