import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE, type ConversationSearchIndex } from "../../../../src/infra/conversation-fts"
import { searchConversationRecall } from "../../../../src/infra/conversation-recall-search"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile, resolveConversationSearchDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"

let baseDir: string
let store: EventStore
let index: ConversationSearchIndex
const sessionId = "s_abcd1234"
const conversationId = "c_abcd1234"
let nowCounter = 0

function nextTimestamp(): string {
  nowCounter += 1
  return new Date(2026, 4, 21, 0, 0, 0, nowCounter).toISOString()
}

function makeMessageEntry(parentId: string | null, id: string): ConversationEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: nextTimestamp(),
    message: { kind: "user", content: `from ${id}` },
  }
}

async function createStorage(): Promise<ConversationTreeStorage> {
  return ConversationTreeStorage.create({ conversationId, sessionId, now: nextTimestamp, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-tree-"))
  nowCounter = 0
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  index = acquireConversationSearchIndex(resolveConversationSearchDbFile(baseDir), asAsyncEventReadSurface(store))
})

afterEach(async () => {
  await index.dispose()
  store.close()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

describe("appendEntries FTS", () => {
  it("does not index in primary append and catches up without deleting identities", async () => {
    const storage = await createStorage()
    await storage.appendEntries([makeMessageEntry(null, "a0000001")])
    const query = spyOn(Database.prototype, "query")
    try {
      const outcome = await storage.appendEntries([makeMessageEntry("a0000001", "a0000002")])
      expect(outcome.kind).toBe("committed")
      const ftsWrites = query.mock.calls.map(([sql]) => sql.trim())
        .filter((sql) => /^(insert into|delete from)\s+conversation_recall_fts\b/i.test(sql))
      expect(ftsWrites).toHaveLength(0)
    } finally {
      query.mockRestore()
      storage.dispose()
    }
    const db = await index.through(store.currentPosition())
    const hits = searchConversationRecall(db, { upperPosition: store.currentPosition(), conversationId, match: "from", rawQuery: "from", limit: 5 })
    expect(hits.map((hit) => hit.entryId).sort()).toEqual(["a0000001", "a0000002"])
  })

  it("rejects an already committed id without changing facts, recall, or the leaf", async () => {
    const storage = await createStorage()
    const original = makeMessageEntry(null, "a0000001")
    await storage.appendEntries([original])
    const before = store.read({ aggregateId: `conversation:${conversationId}` })
    try {
      await expect(storage.appendEntries([
        makeMessageEntry("a0000001", "a0000002"),
        makeMessageEntry("a0000002", "a0000001"),
      ])).rejects.toThrow(/duplicate/i)
      expect(store.read({ aggregateId: `conversation:${conversationId}` })).toEqual(before)
      expect(await storage.getLeafId()).toBe(original.id)
      expect(await storage.getEntry("a0000002")).toBeUndefined()
      const db = await index.through(store.currentPosition())
      expect(db.query(`select entry_id from ${CONVERSATION_FTS_TABLE}`).all()).toEqual([{ entry_id: original.id }])
      const hits = searchConversationRecall(db, { upperPosition: store.currentPosition(), conversationId, match: "from", rawQuery: "from", limit: 5 })
      expect(hits.map((hit) => hit.entryId)).toEqual([original.id])
    } finally {
      storage.dispose()
    }
  })
})
