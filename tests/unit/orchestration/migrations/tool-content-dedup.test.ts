import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { contentEvidence } from "../../../../src/infra/content-evidence"
import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE } from "../../../../src/infra/conversation-fts"
import { searchConversationRecall } from "../../../../src/infra/conversation-recall-search"
import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { dedupToolContent } from "../../../../src/orchestration/migrations/tool-content-dedup"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { readToolResultDisplayMeta } from "../../../../src/orchestration/session/conversation/tool-result-meta"
import {
  createToolExecutionProjection as createAsyncToolExecutionProjection,
  toolExecutionTimelineFromProjection,
} from "../../../../src/orchestration/session/tool-execution-projection"

const createToolExecutionProjection = (store: LocalSqliteEventStore, sessionId: string) =>
  createAsyncToolExecutionProjection(asAsyncEventReadSurface(store), sessionId)

const HIDDEN_TOKEN = "zanzibar"
// Each text is distinct, over the inline threshold, and carries its token past
// the preview so an FTS match proves the index still holds the real text.
const LARGE_CHAT = `${"chat tool output padding line\n".repeat(120)}the treasure is in ${HIDDEN_TOKEN} tonight`
const LARGE_PROVISIONAL = `provisional ${"streamed tool output line\n".repeat(120)}`
const LARGE_NESTED = `nested ${"full nested result body\n".repeat(120)}`
const LARGE_DISPLAY_STRING = `display-string ${"search rendered view line\n".repeat(120)}`
const LARGE_DISPLAY_TEXT = `display-text ${"read rendered view line\n".repeat(120)}`
const LARGE_OUTPUT = `output ${"captured execution output line\n".repeat(120)}`
const SMALL_TEXT = "small inline part"

let tmpDir: string
let dbPath: string
let store: LocalSqliteEventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-dedup-migration-"))
  dbPath = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbPath)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

interface JsonObject {
  [key: string]: unknown
}

function append(sessionId: string, aggregateId: string, type: string, payload: JsonObject, actor: "agent" | "flywheel" = "flywheel"): void {
  store.append({
    aggregateId,
    type,
    version: 1,
    timestamp: Date.now(),
    actor,
    sessionId,
    payload,
  })
}

/** The tool execution projection refuses a result without its observed input,
 *  so every seeded tool fact chain starts with one. Small: never a candidate. */
function appendToolInput(sessionId: string, toolUseId: string, parentToolUseId?: string): void {
  const inputText = JSON.stringify({})
  const evidence = contentEvidence(inputText)
  append(sessionId, `session:${sessionId}`, "tool.input.completed", {
    toolUseId,
    toolName: "bash",
    input: {},
    inputBytes: evidence.bytes,
    inputSha256: evidence.sha256,
    inputPreview: inputText,
    executionMode: "foreground",
    traceKind: "tool",
    childHasOwnViewport: false,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  }, "agent")
}

/** Seeds one session in the pre-dedup inline shape covering all three rewritten
 *  field sites, including both positions of details.displayContent, plus rows
 *  the migration must leave alone - among them a turn fragment from the retired
 *  family, which a historical store of this vintage always carries. */
function seedInlineSession(sessionId: string, conversationId: string): void {
  const timestamp = new Date(1700000000000).toISOString()
  const conversation = `conversation:${conversationId}`
  const session = `session:${sessionId}`
  append(sessionId, conversation, "chat.tree.created", { conversationId, createdAt: timestamp })
  append(sessionId, conversation, "chat.entries.appended", {
    conversationId,
    entries: [
      { kind: "message", id: "e1", parentId: null, timestamp, message: { kind: "user", content: "run it" } },
      { kind: "message", id: "e2", parentId: "e1", timestamp, message: { kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] } },
      { kind: "message", id: "e3", parentId: "e2", timestamp, message: { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: LARGE_CHAT }, { type: "text", text: SMALL_TEXT }] } },
    ],
  })
  append(sessionId, conversation, "chat.entry.provisional", {
    conversationId,
    entry: { kind: "message", id: "p1", parentId: "e3", timestamp, message: { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: LARGE_PROVISIONAL }] } },
  })
  // A candidate-shaped row (over the byte prefilter) whose text fields are all
  // small; the migration must select and then leave it at version 1.
  append(sessionId, conversation, "chat.entries.appended", {
    conversationId,
    entries: [
      { kind: "message", id: "e4", parentId: "e3", timestamp, message: { kind: "toolResult", toolUseId: "t1", content: Array.from({ length: 200 }, (_, index) => ({ type: "text", text: `${SMALL_TEXT} ${index}` })) } },
    ],
  })
  appendToolInput(sessionId, "t1", "parent-1")
  appendToolInput(sessionId, "t2")
  append(sessionId, session, "tool.result.recorded", {
    toolUseId: "t1",
    outcome: "ok",
    content: LARGE_NESTED,
    contentPreview: contentEvidence(LARGE_NESTED).preview,
    details: { exitCode: 0, displayContent: LARGE_DISPLAY_STRING },
    parentToolUseId: "parent-1",
  })
  append(sessionId, session, "tool.result.recorded", {
    toolUseId: "t2",
    outcome: "ok",
    details: { displayContent: { text: LARGE_DISPLAY_TEXT, startLine: 1 } },
  })
  append(sessionId, session, "tool.execution_output.recorded", {
    toolUseId: "t1",
    output: LARGE_OUTPUT,
  })
  // A large non-tool fact: over the byte prefilter but outside the four
  // families, so the migration must never touch it.
  append(sessionId, session, "handoff.written", { note: LARGE_CHAT })
}

interface EventRowSnapshot {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  version: number
  timestamp: number
  actor: string
  sessionId: string
  payload: string
}

function readEventRows(where = "", bindings: string[] = []): EventRowSnapshot[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<EventRowSnapshot, string[]>(`
      select position, id, aggregate_id as aggregateId, seq, type, version, timestamp, actor, session_id as sessionId, payload
      from event ${where} order by position
    `).all(...bindings)
  } finally {
    db.close()
  }
}

function readContentRows(): Array<{ sessionId: string; sha256: string; content: string; bytes: number }> {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<{ sessionId: string; sha256: string; content: string; bytes: number }, []>(
      "select session_id as sessionId, sha256, content, bytes from tool_content order by session_id, sha256",
    ).all()
  } finally {
    db.close()
  }
}

/** Recall reads the derived search index, never the primary: each call builds
 *  a fresh index from the store's current facts, so a hit after the migration
 *  proves the rewritten reference parts still resolve to the indexed text. */
async function recallHits(conversationId: string, indexName: string): Promise<string[]> {
  const index = acquireConversationSearchIndex(path.join(tmpDir, indexName, "conversation-search.sqlite"), asAsyncEventReadSurface(store))
  try {
    const upperPosition = store.currentPosition()
    const db = await index.through(upperPosition)
    return searchConversationRecall(db, { upperPosition, conversationId, match: HIDDEN_TOKEN, limit: 5 })
      .map((hit) => hit.entryId)
  } finally {
    await index.dispose()
  }
}

function primaryTableNames(): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all().map((row) => row.name)
  } finally {
    db.close()
  }
}

/** Every read a downstream consumer sees: the conversation fold plus the two
 *  tool projections, serialized so pre and post migration compare byte for
 *  byte. */
async function readSurfaces(sessionId: string, conversationId: string): Promise<string> {
  const fold = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
  const timeline = toolExecutionTimelineFromProjection(await createToolExecutionProjection(store, sessionId).replay())
  const meta = [...(await readToolResultDisplayMeta(asAsyncEventReadSurface(store), sessionId)).entries()]
  return JSON.stringify({ entriesById: fold.entriesById, leafId: fold.leafId, timeline, meta })
}

function migrate() {
  // The migration owns its own connection; the test handle stays closed while
  // it runs so the only writer is the pass under test.
  store.close()
  const result = dedupToolContent(dbPath)
  store = createSqliteEventStore(dbPath)
  return result
}

function payloadOf(row: EventRowSnapshot | undefined): JsonObject {
  if (!row) throw new Error("expected an event row")
  const parsed: JsonObject = JSON.parse(row.payload)
  return parsed
}

describe("dedupToolContent", () => {
  test("converts all three field sites, matches shas per row, and keeps reads byte-identical", async () => {
    seedInlineSession("session-a", "conv-a")
    const before = await readSurfaces("session-a", "conv-a")

    const result = migrate()

    expect(result.sessions).toEqual([{
      sessionId: "session-a",
      factsRewritten: 4,
      contentRowsWritten: 5,
      payloadBytesMoved: result.sessions[0]?.payloadBytesMoved ?? -1,
    }])
    expect(result.skipped).toEqual([])
    expect(result.factsRewritten).toBe(4)
    expect(result.contentRowsWritten).toBe(5)
    expect(result.payloadBytesMoved).toBeGreaterThan(0)

    expect(await readSurfaces("session-a", "conv-a")).toBe(before)

    const contentBySha = new Map(readContentRows().map((row) => [row.sha256, row]))
    expect(contentBySha.size).toBe(5)
    for (const text of [LARGE_CHAT, LARGE_NESTED, LARGE_DISPLAY_STRING, LARGE_DISPLAY_TEXT, LARGE_OUTPUT]) {
      const evidence = contentEvidence(text)
      expect(contentBySha.get(evidence.sha256)).toEqual({ sessionId: "session-a", sha256: evidence.sha256, content: text, bytes: evidence.bytes })
    }

    const rows = readEventRows("where session_id = ?1", ["session-a"])
    const executionOutput = payloadOf(rows.find((row) => row.type === "tool.execution_output.recorded"))
    expect(executionOutput.output).toEqual({
      sha256: contentEvidence(LARGE_OUTPUT).sha256,
      bytes: contentEvidence(LARGE_OUTPUT).bytes,
      preview: contentEvidence(LARGE_OUTPUT).preview,
    })

    const toolResults = rows.filter((row) => row.type === "tool.result.recorded")
    expect(toolResults.map((row) => row.version)).toEqual([2, 2])
    expect(payloadOf(toolResults[0])).toMatchObject({
      content: { sha256: contentEvidence(LARGE_NESTED).sha256 },
      details: { displayContent: { sha256: contentEvidence(LARGE_DISPLAY_STRING).sha256 } },
    })
    expect(payloadOf(toolResults[1])).toMatchObject({
      details: { displayContent: { text: { sha256: contentEvidence(LARGE_DISPLAY_TEXT).sha256 }, startLine: 1 } },
    })

    const appended = rows.filter((row) => row.type === "chat.entries.appended")
    expect(payloadOf(appended[0])).toMatchObject({
      entries: [
        { id: "e1" },
        { id: "e2" },
        {
          id: "e3",
          message: {
            content: [
              { type: "text_reference", ...contentEvidence(LARGE_CHAT) },
              { type: "text", text: SMALL_TEXT },
            ],
          },
        },
      ],
    })
    // The retired family is not a candidate: --prune-retired deletes those
    // rows, and rewriting bytes on the way to deletion is wasted work.
    const fragment = rows.find((row) => row.type === "chat.entry.provisional")
    expect(fragment?.version).toBe(1)
    expect(payloadOf(fragment)).toMatchObject({
      entry: { message: { content: [{ type: "text", text: LARGE_PROVISIONAL }] } },
    })
  })

  test("leaves small-text version-1 rows, non-tool facts, and small sessions untouched", () => {
    seedInlineSession("session-a", "conv-a")
    append("session-small", "session:session-small", "tool.execution_output.recorded", { toolUseId: "t9", output: "tiny" })
    const smallBefore = readEventRows("where session_id = ?1", ["session-small"])
    const nonToolBefore = readEventRows("where type in (?1, ?2)", ["handoff.written", "chat.tree.created"])
    const smallEntriesBefore = readEventRows("where type = ?1 and json_extract(payload, '$.entries[0].id') = ?2", ["chat.entries.appended", "e4"])

    const result = migrate()

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["session-a"])
    expect(readEventRows("where session_id = ?1", ["session-small"])).toEqual(smallBefore)
    expect(readEventRows("where type in (?1, ?2)", ["handoff.written", "chat.tree.created"])).toEqual(nonToolBefore)
    // The all-small chat turn was a candidate by payload size but holds no
    // extractable text, so it keeps its version-1 inline shape.
    expect(readEventRows("where type = ?1 and json_extract(payload, '$.entries[0].id') = ?2", ["chat.entries.appended", "e4"])).toEqual(smallEntriesBefore)
  })

  test("recall from a derived index built over the migrated facts answers as it did before", async () => {
    seedInlineSession("session-a", "conv-a")
    const before = await recallHits("conv-a", "search-before")
    expect(before).toEqual(["e3"])

    migrate()

    // The primary carries facts and content only; the search index is derived
    // by its execution owner and never lives in flywheel.sqlite.
    expect(primaryTableNames().some((name) => name.startsWith(CONVERSATION_FTS_TABLE))).toBe(false)
    expect(await recallHits("conv-a", "search-after")).toEqual(before)
  })

  test("resumes after a kill between sessions: converged run leaves the converted session byte-identical", async () => {
    seedInlineSession("session-a", "conv-a")
    const firstRun = migrate()
    expect(firstRun.sessions.map((session) => session.sessionId)).toEqual(["session-a"])

    // The kill-between-sessions state: one session converted, one still inline.
    seedInlineSession("session-b", "conv-b")
    const convertedRows = readEventRows("where session_id = ?1", ["session-a"])

    const secondRun = migrate()

    expect(secondRun.sessions.map((session) => session.sessionId)).toEqual(["session-b"])
    expect(secondRun.factsRewritten).toBe(4)
    expect(readEventRows("where session_id = ?1", ["session-a"])).toEqual(convertedRows)
    expect(await readSurfaces("session-b", "conv-b")).toBeTruthy()
  })

  test("converts a store that predates the tool_content table", () => {
    seedInlineSession("session-a", "conv-a")
    store.close()
    const bare = new Database(dbPath)
    bare.exec("drop table if exists tool_content")
    bare.close()

    const result = dedupToolContent(dbPath)
    store = createSqliteEventStore(dbPath)

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["session-a"])
    expect(readContentRows()).toHaveLength(5)
  })

  test("a second full run is a no-op", () => {
    seedInlineSession("session-a", "conv-a")
    seedInlineSession("session-b", "conv-b")
    migrate()
    const eventRows = readEventRows()
    const contentRows = readContentRows()

    const secondRun = migrate()

    expect(secondRun.sessions).toEqual([])
    expect(secondRun.skipped).toEqual([])
    expect(secondRun.factsRewritten).toBe(0)
    expect(secondRun.contentRowsWritten).toBe(0)
    expect(secondRun.payloadBytesMoved).toBe(0)
    expect(readEventRows()).toEqual(eventRows)
    expect(readContentRows()).toEqual(contentRows)
  })
})
