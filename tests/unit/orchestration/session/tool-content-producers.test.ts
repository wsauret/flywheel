import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createEmit, EventBus } from "../../../../src/infra/event-bus"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { LlmToolOutputPart } from "../../../../src/infra/llm/tool-output-part-schema"
import { ToolContentReferencePartSchema } from "../../../../src/infra/tool-content"
import { subscribeSessionRuntimeFacts } from "../../../../src/orchestration/session/create-session-infra"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { parseConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"

const SESSION_ID = "session-1"
const CONVERSATION_ID = "conv-1"
// The marker sits past the 240-char reference preview, so it can only appear
// in a payload that inlines the full text.
const MARKER = "MARKER_c0ffee42_END"
const LARGE_TEXT = `${"scripted large tool output line\n".repeat(750)}${MARKER}`
const SMALL_TEXT = "short output"
const FIXED_TIME = new Date(2026, 4, 21).toISOString()

let tmpDir: string
let store: EventStore
let dbFile: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-tool-content-producers-"))
  dbFile = path.join(tmpDir, "flywheel.sqlite")
  store = createSqliteEventStore(dbFile)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function reference(text: string) {
  const evidence = contentEvidence(text)
  return { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview }
}

/** Drive the runtime-fact subscriber, the durable write site for tool facts,
 *  with one scripted turn: execution output, a top-level result carrying a
 *  display view, and a nested result carrying full content. */
async function emitToolTurn(text: string): Promise<void> {
  const bus = new EventBus()
  const writer = createSessionFactWriter({ sessionId: SESSION_ID, writer: asAsyncEventWriter(store) })
  const subscription = subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer, requireStoredFacts: true })
  const emit = createEmit(bus)
  // The tool-execution projection requires input facts before outputs.
  for (const [id, parent] of [["tool-1", undefined], ["tool-2", "tool-1"]] as const) {
    emit("tool.input.completed", {
      sessionId: SESSION_ID,
      data: {
        type: "tool.input.completed",
        model_request_id: "request-1",
        tool_use: {
          id,
          name: "bash",
          provider_call_id: `call-${id}`,
          provider_tool_name: "bash",
          executable_tool_name: "bash",
          input: {},
          execution: { mode: "foreground", trace_kind: "tool" },
        },
        ...(parent ? { parent_tool_use_id: parent } : {}),
      },
    })
  }
  emit("tool.execution_output.recorded", {
    sessionId: SESSION_ID,
    data: { type: "tool.execution_output.recorded", tool_use_id: "tool-1", output: text },
  })
  emit("tool.result.recorded", {
    sessionId: SESSION_ID,
    data: {
      type: "tool.result.recorded",
      tool_use_id: "tool-1",
      content: [{ type: "text", text }],
      is_error: false,
      details: { exitCode: 0, displayContent: text },
    },
  })
  emit("tool.result.recorded", {
    sessionId: SESSION_ID,
    data: {
      type: "tool.result.recorded",
      tool_use_id: "tool-2",
      content: [{ type: "text", text }],
      is_error: false,
      parent_tool_use_id: "tool-1",
    },
  })
  await bus.drain()
  expect(subscription.getPersistenceFailure()).toBeNull()
  subscription.unsubscribe()
  await bus.dispose()
  writer.dispose()
}

function turnEntries(text: string) {
  const precursors: ConversationEntry[] = [
    { kind: "message", id: "u1", parentId: null, timestamp: FIXED_TIME, message: { kind: "user", content: "run it" } },
    {
      kind: "message",
      id: "a1",
      parentId: "u1",
      timestamp: FIXED_TIME,
      message: { kind: "assistant", content: [{ type: "tool_use", id: "t-chat", name: "bash", input: {} }] },
    },
  ]
  const toolResult: ConversationEntry = {
    kind: "message",
    id: "r1",
    parentId: "a1",
    timestamp: FIXED_TIME,
    message: { kind: "toolResult", toolUseId: "t-chat", content: [{ type: "text", text }] },
  }
  return { precursors, toolResult }
}

/** Drive the conversation tree storage, the durable write site for chat
 *  entries, through one live turn. */
async function writeChatTurn(text: string): Promise<void> {
  const storage = await ConversationTreeStorage.create({ conversationId: CONVERSATION_ID, sessionId: SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now: () => FIXED_TIME })
  const { precursors, toolResult } = turnEntries(text)
  expect(await storage.appendEntries(precursors)).toEqual({ kind: "committed" })
  expect(await storage.appendEntries([toolResult])).toEqual({ kind: "committed" })
  storage.dispose()
}

interface RawFact {
  type: string
  version: number
  actor: string
  payload: unknown
}

function rawFacts(db: Database, type: string): RawFact[] {
  return db.query<{ type: string; version: number; actor: string; payload: string }, []>(
    `select type, version, actor, payload from event where type = '${type}' order by position`,
  ).all().map((row) => {
    const payload: unknown = JSON.parse(row.payload)
    return { type: row.type, version: row.version, actor: row.actor, payload }
  })
}

type StoredToolResultPart = LlmToolOutputPart | typeof ToolContentReferencePartSchema.Type

/** Decode a raw chat fact through the real schema and return its toolResult
 *  entry's content parts. Throws when the fact holds no toolResult entry. */
function chatToolResultParts(fact: RawFact): ReadonlyArray<StoredToolResultPart> {
  const parsed = parseConversationTreeFact(fact)
  const entries = parsed.type === "chat.entries.appended" ? parsed.payload.entries : []
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.kind === "toolResult") return entry.message.content
  }
  throw new Error(`fact ${fact.type} holds no toolResult entry`)
}

describe("producers emit tool-content references", () => {
  test("one large output lands as one content row with references in all four fact sites", async () => {
    await emitToolTurn(LARGE_TEXT)
    await writeChatTurn(LARGE_TEXT)

    const expected = reference(LARGE_TEXT)
    const db = new Database(dbFile, { readonly: true })
    try {
      const rows = db.query<{ sha256: string; content: string }, []>("select sha256, content from tool_content").all()
      expect(rows).toEqual([{ sha256: expected.sha256, content: LARGE_TEXT }])

      const [output] = rawFacts(db, "tool.execution_output.recorded")
      expect(output?.version).toBe(4)
      expect(output?.payload).toMatchObject({ output: expected })

      const [topLevel, nested] = rawFacts(db, "tool.result.recorded")
      expect(topLevel?.version).toBe(4)
      expect(topLevel?.payload).toMatchObject({ details: { exitCode: 0, displayContent: expected } })
      expect(nested?.version).toBe(4)
      expect(nested?.payload).toMatchObject({ content: expected })

      // The turn's committed batch follows the precursor batch.
      const committed = rawFacts(db, "chat.entries.appended").at(-1)
      expect(committed?.version).toBe(3)
      expect(chatToolResultParts(committed!)).toEqual([{ type: "text_reference", ...expected }])

      // R1: no durable payload inlines the text anywhere in the event table.
      const inlineCopies = db.query<{ n: number }, []>(`select count(*) as n from event where payload like '%${MARKER}%'`).get()
      expect(inlineCopies?.n).toBe(0)
    } finally {
      db.close()
    }
  })

  test("a small output stays inline at current per-family versions and writes no content row", async () => {
    await emitToolTurn(SMALL_TEXT)
    await writeChatTurn(SMALL_TEXT)

    const db = new Database(dbFile, { readonly: true })
    try {
      expect(db.query<{ n: number }, []>("select count(*) as n from tool_content").get()?.n).toBe(0)

      const [output] = rawFacts(db, "tool.execution_output.recorded")
      expect(output?.version).toBe(3)
      expect(output?.payload).toMatchObject({ output: SMALL_TEXT })

      const [topLevel, nested] = rawFacts(db, "tool.result.recorded")
      expect(topLevel?.version).toBe(3)
      expect(topLevel?.payload).toMatchObject({ details: { displayContent: SMALL_TEXT } })
      expect(nested?.version).toBe(3)
      expect(nested?.payload).toMatchObject({ content: SMALL_TEXT })

      const committed = rawFacts(db, "chat.entries.appended").at(-1)
      expect(committed?.version).toBe(3)
      expect(chatToolResultParts(committed!)).toEqual([{ type: "text", text: SMALL_TEXT }])
    } finally {
      db.close()
    }
  })

  test("the tool facts and the chat entry of one turn share exactly one content row", async () => {
    await emitToolTurn(LARGE_TEXT)
    await writeChatTurn(LARGE_TEXT)

    const expected = reference(LARGE_TEXT)
    const db = new Database(dbFile, { readonly: true })
    try {
      const rows = db.query<{ session_id: string; sha256: string }, []>("select session_id, sha256 from tool_content").all()
      expect(rows).toEqual([{ session_id: SESSION_ID, sha256: expected.sha256 }])
      // Execution output, top-level result, nested result, and the committed
      // chat entry: four facts, one row.
      const referencing = db.query<{ n: number }, []>(
        `select count(*) as n
         from event
         where (
           (type = 'tool.execution_output.recorded' and version = 4)
           or (type = 'tool.result.recorded' and version = 4)
           or (type = 'chat.entries.appended' and version = 3)
         )
         and payload like '%${expected.sha256}%'`,
      ).get()
      expect(referencing?.n).toBe(4)
    } finally {
      db.close()
    }
  })

})

// R4 evidence, measured by this test with the 24,019-byte scripted output
// above. Inline shape: 100,941 durable payload bytes for the turn, four inline
// copies of the output - execution output, displayContent, nested content,
// committed entry. Reference shape: 3,959 payload bytes plus one 24,019-byte
// content row, 27,978 durable bytes total, ratio 0.28.
const MEASURED_INLINE_TURN_BYTES = 100_941
const MEASURED_REFERENCE_TURN_BYTES = 27_978

describe("R4: durable write bandwidth", () => {
  test("the reference shape writes a small fraction of the inline shape's bytes", async () => {
    // Inline (before) shape: the exact facts the producers emitted before
    // extraction existed. The mapper still returns them, so the before store
    // appends the pure mapper output and the version-1 chat facts directly.
    const beforeDbFile = path.join(tmpDir, "before.sqlite")
    const beforeStore = createSqliteEventStore(beforeDbFile)
    const events = [
      createRuntimeEvent("tool.execution_output.recorded", { tool_use_id: "tool-1", output: LARGE_TEXT }),
      createRuntimeEvent("tool.result.recorded", {
        tool_use_id: "tool-1",
        content: [{ type: "text", text: LARGE_TEXT }],
        is_error: false,
        details: { exitCode: 0, displayContent: LARGE_TEXT },
      }),
      createRuntimeEvent("tool.result.recorded", {
        tool_use_id: "tool-2",
        content: [{ type: "text", text: LARGE_TEXT }],
        is_error: false,
        parent_tool_use_id: "tool-1",
      }),
    ]
    for (const event of events) {
      for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) {
        beforeStore.append({
          aggregateId: `session:${SESSION_ID}`,
          type: fact.type,
          version: fact.version,
          timestamp: Date.now(),
          actor: fact.actor,
          sessionId: SESSION_ID,
          payload: fact.payload,
        })
      }
    }
    const { precursors, toolResult } = turnEntries(LARGE_TEXT)
    beforeStore.append({
      aggregateId: `conversation:${CONVERSATION_ID}`,
      type: "chat.tree.created",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: SESSION_ID,
      payload: { conversationId: CONVERSATION_ID, createdAt: FIXED_TIME },
    })
    for (const payload of [
      { conversationId: CONVERSATION_ID, entries: precursors },
      { conversationId: CONVERSATION_ID, entries: [toolResult] },
    ]) {
      beforeStore.append({
        aggregateId: `conversation:${CONVERSATION_ID}`,
        type: "chat.entries.appended",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload,
      })
    }
    beforeStore.close()

    // Reference (after) shape: the same turn through the live producers.
    await emitToolTurn(LARGE_TEXT)
    await writeChatTurn(LARGE_TEXT)

    const durableBytes = (file: string) => {
      const db = new Database(file, { readonly: true })
      try {
        const payload = db.query<{ n: number | null }, []>("select sum(length(payload)) as n from event").get()?.n ?? 0
        const content = db.query<{ n: number | null }, []>("select sum(length(content)) as n from tool_content").get()?.n ?? 0
        return { payload, content }
      } finally {
        db.close()
      }
    }
    const before = durableBytes(beforeDbFile)
    const after = durableBytes(dbFile)
    expect(before.content).toBe(0)

    const beforeTotal = before.payload
    const afterTotal = after.payload + after.content
    // One retained copy of the ~24KB output (as the content row) against four
    // inline copies: the reference shape must land well under half of the
    // inline shape's durable bytes. The equality checks pin the measured
    // totals so a byte regression in either direction is visible.
    expect(beforeTotal).toBe(MEASURED_INLINE_TURN_BYTES)
    expect(afterTotal).toBe(MEASURED_REFERENCE_TURN_BYTES)
    expect(afterTotal).toBeLessThan(beforeTotal * 0.5)
  })
})
