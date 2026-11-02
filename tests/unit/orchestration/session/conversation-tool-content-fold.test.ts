import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { contentEvidence } from "../../../../src/infra/content-evidence"
import { asAsyncEventReadSurface, type EventStore, type StoredFact } from "../../../../src/infra/event-store-types"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ToolContentRow } from "../../../../src/infra/tool-content"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader"

const SESSION_ID = "session-1"
// Above the inline threshold so referencing it is the realistic case.
const LARGE_TEXT = "tool output line with searchable token quixotic\n".repeat(200)

let tmpDir: string
let store: EventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-fold-content-"))
  store = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
})

afterEach(() => {
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

interface EntryFixture {
  [key: string]: unknown
}

function turnEntries(toolResultContent: readonly EntryFixture[]): EntryFixture[] {
  const timestamp = new Date().toISOString()
  return [
    { kind: "message", id: "e1", parentId: null, timestamp, message: { kind: "user", content: "run it" } },
    {
      kind: "message",
      id: "e2",
      parentId: "e1",
      timestamp,
      message: { kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    },
    {
      kind: "message",
      id: "e3",
      parentId: "e2",
      timestamp,
      message: { kind: "toolResult", toolUseId: "t1", content: toolResultContent },
    },
  ]
}

function appendTree(conversationId: string): void {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.tree.created",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: SESSION_ID,
    payload: { conversationId, createdAt: new Date().toISOString() },
  })
}

function appendEntries(conversationId: string, version: 1 | 2, entries: readonly EntryFixture[], contentRows?: readonly ToolContentRow[]): void {
  store.append({
    aggregateId: `conversation:${conversationId}`,
    type: "chat.entries.appended",
    version,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: SESSION_ID,
    payload: { conversationId, entries },
    ...(contentRows ? { contentRows } : {}),
  })
}

async function toolResultText(conversationId: string, entryId: string) {
  const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
  const entry = state.entriesById[entryId]
  if (entry?.kind !== "message" || entry.message.kind !== "toolResult") throw new Error(`entry ${entryId} is not a toolResult`)
  return entry.message.content
}

describe("conversation fold hydrates tool-content references", () => {
  test("a referenced fixture folds byte-identical to its inline fixture", async () => {
    appendTree("conv-inline")
    appendEntries("conv-inline", 1, turnEntries([{ type: "text", text: LARGE_TEXT }]))

    appendTree("conv-ref")
    appendEntries("conv-ref", 2, turnEntries([referencePart(LARGE_TEXT)]), [contentRow(LARGE_TEXT)])

    const inline = await toolResultText("conv-inline", "e3")
    const referenced = await toolResultText("conv-ref", "e3")
    expect(referenced).toEqual([{ type: "text", text: LARGE_TEXT }])
    expect(referenced).toEqual(inline)
  })

  test("a historical fragment holding a reference is skipped, not hydrated", async () => {
    // The retired family still carries content references in old stores. The
    // fold selects by type, so the row is never read and its content row is
    // simply unreferenced until --prune-retired deletes the row.
    appendTree("conv-prov")
    appendEntries("conv-prov", 1, turnEntries([{ type: "text", text: "small" }]))
    store.append({
      aggregateId: "conversation:conv-prov",
      type: "chat.entry.provisional",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: SESSION_ID,
      payload: {
        conversationId: "conv-prov",
        entry: {
          kind: "message",
          id: "p1",
          parentId: "e3",
          timestamp: new Date().toISOString(),
          message: { kind: "toolResult", toolUseId: "t1", content: [referencePart(LARGE_TEXT)] },
        },
      },
      contentRows: [contentRow(LARGE_TEXT)],
    })

    const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), "conv-prov").replay()

    expect(state.entriesById["p1"]).toBeUndefined()
    expect(state.degraded.length).toBe(0)
  })
})

// Corruption cases use the in-memory reader: the store's own insert seam
// refuses to persist a reference without its verified row, so these states
// only arise from on-disk damage - which the fold must still detect.
describe("conversation fold reference invariants", () => {
  function storedFacts(entries: readonly EntryFixture[]): StoredFact[] {
    return [
      {
        aggregateId: "conversation:conv-bad",
        type: "chat.tree.created",
        version: 1,
        timestamp: 1,
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload: { conversationId: "conv-bad", createdAt: new Date(1).toISOString() },
        position: 1,
        id: "f1",
        seq: 0,
      },
      {
        aggregateId: "conversation:conv-bad",
        type: "chat.entries.appended",
        version: 2,
        timestamp: 2,
        actor: "flywheel",
        sessionId: SESSION_ID,
        payload: { conversationId: "conv-bad", entries },
        position: 2,
        id: "f2",
        seq: 1,
      },
    ]
  }

  test("a missing content row becomes one degraded gap that holds the whole fact", async () => {
    const facts = storedFacts(turnEntries([referencePart(LARGE_TEXT)]))
    const reader = inMemoryEventReader(facts)
    const state = await createConversationTreeProjection(asAsyncEventReadSurface(reader), "conv-bad").replay()
    expect(state.degraded.length).toBe(1)
    const gap = state.degraded.materialize()[0]
    expect(gap?.block.failureClass).toBe("decode_failure")
    expect(gap?.raw).toEqual(facts[1])
  })

  test("a disconnected entry of a referenced batch becomes a gap that holds the entry as stored, its reference unresolved", async () => {
    const [user, , toolResult] = turnEntries([referencePart(LARGE_TEXT)])
    const disconnected = { ...toolResult, parentId: "missing" }
    const reader = inMemoryEventReader(storedFacts([user!, disconnected]), new Map([[SESSION_ID, [contentRow(LARGE_TEXT)]]]))
    const state = await createConversationTreeProjection(asAsyncEventReadSurface(reader), "conv-bad").replay()
    const gaps = state.degraded.materialize()
    expect(gaps.map((gap) => gap.block.failureClass)).toEqual(["structural_violation"])
    expect(gaps[0]?.raw).toEqual(disconnected)
  })

  test("a sha256 mismatch becomes a degraded gap", async () => {
    const reference = referencePart(LARGE_TEXT)
    const corrupted: ToolContentRow = { sha256: String(reference.sha256), content: "not the promised bytes", bytes: Number(reference.bytes) }
    const reader = inMemoryEventReader(
      storedFacts(turnEntries([reference])),
      new Map([[SESSION_ID, [corrupted]]]),
    )
    const state = await createConversationTreeProjection(asAsyncEventReadSurface(reader), "conv-bad").replay()
    expect(state.degraded.length).toBe(1)
    expect(state.degraded.materialize()[0]?.block.failureClass).toBe("decode_failure")
  })
})
