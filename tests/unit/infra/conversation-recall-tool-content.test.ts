import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { contentEvidence } from "../../../src/infra/content-evidence"
import { searchConversationRecall } from "../../../src/infra/conversation-recall-search"
import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../src/infra/event-store-types"
import { acquireConversationSearchIndex, type ConversationSearchIndex } from "../../../src/infra/conversation-fts"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import { TOOL_CONTENT_INLINE_MAX_BYTES, type ToolContentRow } from "../../../src/infra/tool-content"

const CONVERSATION_ID = "conv-1"
const SESSION_ID = "session-1"
const AGGREGATE = `conversation:${CONVERSATION_ID}`
// The searchable token exists only inside the referenced content row; the
// event payload carries the reference (whose preview is trimmed off the
// token) so a match proves the FTS seam resolved the row's real text.
const HIDDEN_TOKEN = "zanzibar"
const LARGE_TEXT = `${"padding line before the interesting part\n".repeat(120)}the treasure is in ${HIDDEN_TOKEN} tonight`

let tmpDir: string
let dbPath: string
let store: LocalSqliteEventStore
let index: ConversationSearchIndex

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-recall-content-"))
  dbPath = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbPath)
  index = acquireConversationSearchIndex(path.join(tmpDir, "search.sqlite"), asAsyncEventReadSurface(store))
})

afterEach(async () => {
  await index.dispose()
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function contentRow(text: string): ToolContentRow {
  const evidence = contentEvidence(text)
  return { sha256: evidence.sha256, content: text, bytes: evidence.bytes }
}

function referencePart(text: string) {
  const evidence = contentEvidence(text)
  return { type: "text_reference", sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview }
}

describe("conversation recall over referenced tool content", () => {
  test("a recall query matches text that exists only as a content row", async () => {
    expect(contentEvidence(LARGE_TEXT).preview.includes(HIDDEN_TOKEN)).toBe(false)
    const timestamp = new Date().toISOString()
    store.append({
      aggregateId: AGGREGATE,
      type: "chat.entries.appended",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: SESSION_ID,
      payload: {
        conversationId: CONVERSATION_ID,
        entries: [
          { kind: "message", id: "a", parentId: null, timestamp, message: { kind: "user", content: "run it" } },
          {
            kind: "message",
            id: "b",
            parentId: "a",
            timestamp,
            message: { kind: "toolResult", toolUseId: "t1", content: [referencePart(LARGE_TEXT)] },
          },
        ],
      },
      contentRows: [contentRow(LARGE_TEXT)],
    })

    const db = await index.through(store.currentPosition())
    const hits = searchConversationRecall(db, { upperPosition: store.currentPosition(), conversationId: CONVERSATION_ID, match: HIDDEN_TOKEN, rawQuery: HIDDEN_TOKEN, limit: 5 })
    expect(hits.map((hit) => hit.entryId)).toEqual(["b"])
    expect(hits[0]?.snippet).toContain(`[${HIDDEN_TOKEN}]`)
    expect(hits[0]?.snippet).toStartWith("...")
  })

  test("a deleted session's unindexed tool content does not block another conversation's recall", async () => {
    const timestamp = new Date().toISOString()
    const row = contentRow(LARGE_TEXT)
    expect(row.bytes).toBeGreaterThan(TOOL_CONTENT_INLINE_MAX_BYTES)
    store.append({
      aggregateId: AGGREGATE,
      type: "chat.entries.appended",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: SESSION_ID,
      payload: {
        conversationId: CONVERSATION_ID,
        entries: [{
          kind: "message", id: "deleted-result", parentId: null, timestamp,
          message: { kind: "toolResult", toolUseId: "t1", content: [referencePart(LARGE_TEXT)] },
        }],
      },
      contentRows: [row],
    })
    store.append({
      aggregateId: "conversation:survivor",
      type: "chat.entries.appended",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "survivor",
      payload: {
        conversationId: "survivor",
        entries: [{
          kind: "message", id: "surviving-entry", parentId: null, timestamp,
          message: { kind: "user", content: "searchable survivor" },
        }],
      },
    })
    expect(store.toolContent.resolve(SESSION_ID, row.sha256)).toBe(LARGE_TEXT)
    store.append({
      aggregateId: `session:${SESSION_ID}`,
      type: "session.deleted",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: SESSION_ID,
      payload: { lastUpdated: timestamp },
      inFlight: [{ op: "clear_session" }],
    })
    expect(store.toolContent.resolve(SESSION_ID, row.sha256)).toBeNull()

    const upper = store.currentPosition()
    const db = await index.through(upper)
    const hits = searchConversationRecall(db, {
      upperPosition: upper, conversationId: "survivor", match: "searchable", rawQuery: "searchable", limit: 5,
    })
    expect(hits.map((hit) => hit.entryId)).toEqual(["surviving-entry"])
    expect(db.query<{ position: number }, []>("select position from conversation_index_position").get()?.position).toBe(upper)
  })

  test("a reference without its content row rejects the primary append atomically", () => {
    const timestamp = new Date().toISOString()
    expect(() =>
      store.appendGuarded({
        aggregateId: AGGREGATE,
        expectedSeq: 0,
        type: "chat.entries.appended",
        version: 2,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload: {
          conversationId: CONVERSATION_ID,
          entries: [
            {
              kind: "message",
              id: "a",
              parentId: null,
              timestamp,
              message: { kind: "toolResult", toolUseId: "t1", content: [referencePart(LARGE_TEXT)] },
            },
          ],
        },
      }),
    ).toThrow("tool content row")
    expect(store.currentPosition()).toBe(0)
    expect(store.read({ aggregateId: AGGREGATE })).toEqual([])

    expect(
      store.appendGuarded({
        aggregateId: AGGREGATE,
        expectedSeq: 0,
        type: "chat.entries.appended",
        version: 2,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload: { conversationId: CONVERSATION_ID, entries: [] },
      }),
    ).toMatchObject({ kind: "stored", events: [{ seq: 0 }] })
  })

  test.each([
    ["hash", { ...contentRow(LARGE_TEXT), content: `${LARGE_TEXT} altered` }, referencePart(LARGE_TEXT)],
    ["byte count", contentRow(LARGE_TEXT), { ...referencePart(LARGE_TEXT), bytes: contentEvidence(LARGE_TEXT).bytes + 1 }],
  ])("a reference with the wrong %s rejects the primary append", (_case, row, reference) => {
    const timestamp = new Date().toISOString()
    expect(() =>
      store.appendGuarded({
        aggregateId: AGGREGATE,
        expectedSeq: 0,
        type: "chat.entries.appended",
        version: 2,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload: {
          conversationId: CONVERSATION_ID,
          entries: [
            {
              kind: "message",
              id: "a",
              parentId: null,
              timestamp,
              message: { kind: "toolResult", toolUseId: "t1", content: [reference] },
            },
          ],
        },
        contentRows: [row],
      }),
    ).toThrow("resolved to sha256")
    expect(store.currentPosition()).toBe(0)
    expect(store.toolContent.resolve(SESSION_ID, row.sha256)).toBeNull()
  })
})
