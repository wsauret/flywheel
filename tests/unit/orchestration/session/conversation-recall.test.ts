import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore, openReadonlyEventReader } from "../../../../src/infra/sqlite-event-store.js"
import { createConversationRecall } from "../../../../src/orchestration/session/conversation-recall.js"
import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE, type ConversationSearchIndex } from "../../../../src/infra/conversation-fts.js"
import { tolerantReprojectionFixtures } from "../../../fixtures/tolerant-reprojection-fixtures.js"

const CONVERSATION_ID = "conv-recall"
const AGGREGATE = `conversation:${CONVERSATION_ID}`

let tmpDir: string
let dbPath: string
let store: LocalSqliteEventStore
let db: Database
let index: ConversationSearchIndex
interface EntryPayload {
  [key: string]: unknown
}

function ts(): string {
  return new Date().toISOString()
}

function createTree(): void {
  store.append({
    aggregateId: AGGREGATE, type: "chat.tree.created", version: 1, timestamp: Date.now(),
    actor: "flywheel", sessionId: CONVERSATION_ID,
    payload: { conversationId: CONVERSATION_ID, createdAt: ts() },
  })
}

function appendEntries(entries: ReadonlyArray<EntryPayload>): void {
  store.append({
    aggregateId: AGGREGATE, type: "chat.entries.appended", version: 1, timestamp: Date.now(),
    actor: "flywheel", sessionId: CONVERSATION_ID,
    payload: { conversationId: CONVERSATION_ID, entries },
  })
}

function userEntry(id: string, parentId: string | null, text: string, displayOnly?: boolean) {
  return { kind: "message", id, parentId, timestamp: ts(), message: { kind: "user", content: text }, ...(displayOnly ? { displayOnly: true } : {}) }
}

function recallFor() {
  return createConversationRecall({ store: asAsyncEventReadSurface(store), index, conversationId: CONVERSATION_ID })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-recall-cap-"))
  dbPath = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbPath)
  db = new Database(dbPath, { readonly: true })
  index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store))
})

afterEach(async () => {
  await index.dispose()
  db.close()
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("createConversationRecall", () => {
  test("captures one scope and count boundary even when catch-up indexes a later append", async () => {
    createTree()
    appendEntries([userEntry("a", null, "kafka captured")])
    const source = asAsyncEventReadSurface(store)
    let appended = false
    const recall = createConversationRecall({
      conversationId: CONVERSATION_ID,
      store: {
        readPage: source.readPage,
        async capturePosition() {
          const upper = await source.capturePosition()
          if (!appended) {
            appended = true
            appendEntries([userEntry("later", "a", "kafka later")])
          }
          return upper
        },
      },
      index: {
        async through() { return index.through(store.currentPosition()) },
        dispose: async () => {},
      },
    })
    const result = await recall({ scope: "all", query: "kafka" })
    expect(result.totalMatches).toBe(1)
    expect(result.hits.map((hit) => hit.entryId)).toEqual(["a"])
    expect((await recallFor()({ scope: "all", query: "kafka" })).totalMatches).toBe(2)
  })

  test("read-only Worker surface is canonically equivalent for search, expansion, and recent assembly", async () => {
    createTree()
    appendEntries([
      userEntry("root", null, "shared kafka root"),
      userEntry("main", "root", "main kafka body"),
      userEntry("fork", "root", "fork kafka body"),
      { kind: "leaf", id: "selected", parentId: "fork", timestamp: ts(), targetId: "main" },
    ])
    const readonly = openReadonlyEventReader(dbPath)
    try {
      const workerRecall = createConversationRecall({
        conversationId: CONVERSATION_ID,
        store: asAsyncEventReadSurface(readonly),
        index,
      })
      const canonicalRecall = recallFor()
      for (const contract of [
        { scope: "lineage", query: "kafka" },
        { scope: "all", expand: [0, "fork"] },
        { scope: "all" },
      ] as const) {
        expect(await workerRecall(contract)).toEqual(await canonicalRecall(contract))
      }
    } finally {
      readonly.close()
    }
  })

  test("ranked lineage search returns durable IDs and FTS snippets without full bodies", async () => {
    createTree()
    appendEntries([userEntry("a", null, "first turn about widgets")])
    appendEntries([userEntry("b", "a", "the kafka pipeline broke during deploy")])
    const recall = recallFor()
    const result = await recall({ scope: "lineage", query: "kafka" })
    expect(result.hits.length).toBe(1)
    const hit = result.hits[0]
    expect(hit?.role).toBe("user")
    expect(hit?.summary).toContain("kafka")
    expect(hit?.snippet).toContain("[kafka]")
    expect(hit?.index).toBe(1)
    expect(hit?.entryId).toBe("b")
    expect(hit).not.toHaveProperty("text")
  })

  test("displayOnly entry is skipped and does not consume an index", async () => {
    createTree()
    appendEntries([userEntry("a", null, "kafka one")])
    appendEntries([userEntry("b", "a", "diagnostic kafka", true)])
    appendEntries([userEntry("c", "b", "kafka three")])
    const recall = recallFor()
    const result = await recall({ scope: "lineage" })
    // displayOnly "b" is filtered, so the contiguous indices are a=0, c=1.
    expect(result.hits.map((h) => h.index)).toEqual([0, 1])
    expect(result.hits.every((h) => h.summary !== "diagnostic kafka")).toBe(true)
  })

  test("compaction entry surfaces as role compaction", async () => {
    createTree()
    appendEntries([userEntry("a", null, "set up the kafka consumer")])
    appendEntries([{
      kind: "compaction", id: "c1", parentId: "a", timestamp: ts(),
      summary: "Summary: kafka consumer configured and tested.",
      retainedMessages: [{ kind: "user", content: "set up the kafka consumer" }],
      sourceLeafId: "a", tokensBefore: 100, tokensAfter: 20,
    }])
    const recall = recallFor()
    const result = await recall({ scope: "lineage", query: "kafka" })
    expect(result.hits.some((h) => h.role === "compaction")).toBe(true)
  })

  test("chat_tree orphan-fts conversation-recall reaches the exact mapping diagnostic", async () => {
    createTree()
    appendEntries([userEntry("root", null, "valid root")])
    db.close()
    await index.through(store.currentPosition())
    const writable = new Database(path.join(tmpDir, "search.sqlite"))
    writable.query(`insert into ${CONVERSATION_FTS_TABLE} (content, conversation_id, entry_id, entry_kind, role, source_position) values (?, ?, ?, ?, ?, 0)`).run(
      "orphan recall row",
      CONVERSATION_ID,
      "orphan-entry",
      "message",
      "user",
    )
    writable.close()
    db = new Database(dbPath, { readonly: true })

    await expect(recallFor()({ scope: "all", query: "orphan" })).rejects.toThrow("selected FTS hit did not map exactly once")
  })

  test("chat_tree invalid JSON conversation-recall fails strict projection before FTS mapping", async () => {
    const payloadBytes = tolerantReprojectionFixtures.chat_tree.failures["invalid JSON"].payloadBytes
    createTree()
    appendEntries([userEntry("root", null, "valid root")])
    db.close()
    const writable = new Database(dbPath)
    writable.query("update event set payload = ? where aggregate_id = ? and type = 'chat.tree.created'").run(payloadBytes, AGGREGATE)
    await index.through(store.currentPosition())
    const derived = new Database(path.join(tmpDir, "search.sqlite"))
    derived.query(`insert into ${CONVERSATION_FTS_TABLE} (content, conversation_id, entry_id, entry_kind, role, source_position) values (?, ?, ?, ?, ?, 0)`).run(
      "orphan strict precedence",
      CONVERSATION_ID,
      "orphan-entry",
      "message",
      "user",
    )
    derived.close()
    writable.close()
    db = new Database(dbPath, { readonly: true })

    await expect(recallFor()({ scope: "all", query: "orphan" })).rejects.toThrow()
    try {
      await recallFor()({ scope: "all", query: "orphan" })
    } catch (error) {
      expect(String(error)).not.toContain("selected FTS hit did not map exactly once")
    }
  })

  test("a degraded record uses its validated source identity and dedicated rendering", async () => {
    createTree()
    appendEntries([userEntry("orphan", "missing", "degraded searchable identity")])
    const recall = recallFor()

    expect((await recall({ scope: "all", query: "degraded" })).hits[0]).toMatchObject({ role: "degraded", summary: "Part of this transcript could not be displayed." })
    expect((await recall({ scope: "all" })).hits[0]).toMatchObject({ role: "degraded", summary: "Part of this transcript could not be displayed." })
  })

  test("lineage excludes an off-branch degraded source while all includes it", async () => {
    createTree()
    appendEntries([userEntry("root", null, "shared root")])
    appendEntries([userEntry("main", "root", "main branch")])
    appendEntries([userEntry("fork", "root", "fork branch")])
    appendEntries([userEntry("broken-fork", "missing", "degraded branch source")])
    appendEntries([{ kind: "leaf", id: "selected", parentId: "fork", timestamp: ts(), targetId: "main" }])
    const recall = recallFor()

    expect((await recall({ scope: "lineage" })).hits.some((hit) => hit.role === "degraded")).toBe(false)
    expect((await recall({ scope: "all" })).hits.some((hit) => hit.role === "degraded")).toBe(true)
  })

  test("scope all returns a sibling-branch hit that lineage excludes", async () => {
    createTree()
    appendEntries([userEntry("root", null, "shared root turn")])
    // Active branch tip.
    appendEntries([userEntry("main", "root", "main branch work")])
    // Off-lineage sibling chained off the shared root.
    appendEntries([userEntry("fork", "root", "fork branch holds the magicword")])
    appendEntries([{ kind: "leaf", id: "selected", parentId: "fork", timestamp: ts(), targetId: "main" }])
    const recall = recallFor()
    expect((await recall({ scope: "lineage", query: "magicword" })).hits.length).toBe(0)
    const all = await recall({ scope: "all", query: "magicword" })
    expect(all.hits.length).toBe(1)
    expect(all.hits[0]?.summary).toContain("magicword")
  })

  test("expand accepts numeric coordinates and durable IDs with bounded reads", async () => {
    createTree()
    appendEntries([userEntry("a", null, "alpha turn")])
    appendEntries([userEntry("b", "a", "beta turn with more text to render fully")])
    const recall = recallFor()
    const ok = await recall({ scope: "lineage", expand: [1, "a"], offset: 6, limit: 4 })
    expect(ok.hits).toEqual([
      expect.objectContaining({ index: 1, entryId: "b", text: "urn ", totalLength: 40, nextOffset: 10 }),
      expect.objectContaining({ index: 0, entryId: "a", text: "turn", totalLength: 10 }),
    ])
    expect(ok.invalidExpand).toBeUndefined()
    const bad = await recall({ scope: "lineage", expand: [99] })
    expect(bad.hits.length).toBe(0)
    expect(bad.invalidExpand).toEqual([99])
  })

  test("exact IDs cannot cross the selected scope or owning conversation", async () => {
    createTree()
    appendEntries([userEntry("root", null, "shared")])
    appendEntries([userEntry("main", "root", "main body")])
    appendEntries([userEntry("fork", "root", "fork body")])
    appendEntries([{ kind: "leaf", id: "selected", parentId: "fork", timestamp: ts(), targetId: "main" }])
    const recall = recallFor()

    expect((await recall({ scope: "lineage", expand: ["fork"] })).invalidExpand).toEqual(["fork"])
    expect((await recall({ scope: "all", expand: ["fork"] })).hits[0]).toMatchObject({
      entryId: "fork",
      text: "fork body",
      totalLength: 9,
    })
    expect((await recall({ scope: "all", expand: ["entry-from-another-conversation"] })).invalidExpand)
      .toEqual(["entry-from-another-conversation"])
  })

  test("totalMatches reflects the true match count and is stable across pages", async () => {
    createTree()
    // Seed more than RECALL_PAGE_SIZE * 2 (= 10) matching entries on one chain so
    // the per-page fetch limit can no longer fill the count.
    const total = 14
    let parent: string | null = null
    for (let i = 0; i < total; i++) {
      const id = `m${i}`
      appendEntries([userEntry(id, parent, "kafka rebalance event")])
      parent = id
    }
    const recall = recallFor()
    const page1 = await recall({ scope: "lineage", query: "kafka", page: 1 })
    const page2 = await recall({ scope: "lineage", query: "kafka", page: 2 })
    const page3 = await recall({ scope: "lineage", query: "kafka", page: 3 })
    // True total, not the fetch-limit-capped rendered.length, and identical on
    // every page rather than growing with the per-page fetch window.
    expect(page1.totalMatches).toBe(total)
    expect(page2.totalMatches).toBe(total)
    expect(page3.totalMatches).toBe(total)
    // The page window itself is still RECALL_PAGE_SIZE (= 5).
    expect(page1.hits.length).toBe(5)
    expect(page2.hits.length).toBe(5)
  })

  test("hyphenated query term matches content tokenized on the hyphen", async () => {
    createTree()
    appendEntries([userEntry("a", null, "rolled out the feature-flag system")])
    appendEntries([userEntry("b", "a", "unrelated turn")])
    const recall = recallFor()
    // "feature-flag" must not glue into the bareword "featureflag"; it must match
    // the content that tokenizes as feature + flag.
    const result = await recall({ scope: "lineage", query: "feature-flag" })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]?.index).toBe(0)
    expect(result.totalMatches).toBe(1)
  })

  test("scope all flattens a branching+linear tree parent-before-child deterministically", async () => {
    createTree()
    // Branch at the root, then a linear chain under each branch.
    appendEntries([userEntry("root", null, "shared marker")])
    appendEntries([userEntry("left", "root", "marker left")])
    appendEntries([userEntry("left-1", "left", "marker left-one")])
    appendEntries([userEntry("right", "root", "marker right")])
    appendEntries([userEntry("right-1", "right", "marker right-one")])
    appendEntries([userEntry("right-2", "right-1", "marker right-two")])
    const recall = recallFor()
    // scope:all uses topoFlatten. Pre-order DFS by insertion order: root, then
    // the left subtree fully, then the right subtree fully. Each parent precedes
    // its children, and the order is reproducible across runs.
    const all = await recall({ scope: "all", query: "marker", page: 1 })
    expect(all.totalMatches).toBe(6)
    const first = await recall({ scope: "all", expand: [0, 1, 2, 3, 4] })
    const last = await recall({ scope: "all", expand: [5] })
    const ordered = [...first.hits, ...last.hits].map((h) => h.text)
    expect(ordered[0]).toContain("shared marker")
    expect(ordered[1]).toContain("marker left")
    expect(ordered[2]).toContain("marker left-one")
    expect(ordered[3]).toContain("marker right")
    expect(ordered[4]).toContain("marker right-one")
    expect(ordered[5]).toContain("marker right-two")
  })

  test("no query and no expand returns the recent tail", async () => {
    createTree()
    let parent: string | null = null
    for (let i = 0; i < 30; i++) {
      const id = `m${i}`
      appendEntries([userEntry(id, parent, `turn number ${i}`)])
      parent = id
    }
    const recall = recallFor()
    const result = await recall({ scope: "lineage" })
    // DEFAULT_RECENT = 25.
    expect(result.hits.length).toBe(25)
    expect(result.hits.at(-1)?.summary).toContain("turn number 29")
  })

  test("recent and expansion reads do not acquire FTS catch-up", async () => {
    createTree()
    appendEntries([userEntry("a", null, "first body")])
    const recall = createConversationRecall({
      conversationId: CONVERSATION_ID,
      store: asAsyncEventReadSurface(store),
      index: {
        through: async () => { throw new Error("FTS catch-up must not run") },
        dispose: async () => {},
      },
    })

    expect((await recall({ scope: "all" })).hits[0]?.entryId).toBe("a")
    expect((await recall({ scope: "all", expand: ["a"] })).hits[0]?.text).toBe("first body")
  })
})
