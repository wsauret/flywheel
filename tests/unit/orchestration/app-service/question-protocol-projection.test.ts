import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"
import { createQuestionProtocolProjection } from "../../../../src/orchestration/app-service/question-protocol-projection.js"
import { QuestionPatchPayloadSchema, RuntimeQuestionSnapshotResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"

import { fakeSessionStore } from "./app-service-doubles.js"
import { entry } from "./_status-projection-fixtures.js"
// One microtask tick: the projection batches publishes per burst.
const flush = () => Promise.resolve()

let activeReader: LocalSqliteEventStore | undefined
let activeReaderDir: string | undefined

afterEach(() => {
  const reader = activeReader
  const readerDir = activeReaderDir
  activeReader = undefined
  activeReaderDir = undefined
  try {
    reader?.close()
  } finally {
    if (readerDir) rmSync(readerDir, { recursive: true, force: true })
  }
})

function createTestEventStore(): LocalSqliteEventStore {
  activeReaderDir = mkdtempSync(join(tmpdir(), "flywheel-question-projection-"))
  activeReader = createSqliteEventStore(join(activeReaderDir, "flywheel.sqlite"))
  return activeReader
}

function question(overrides: Partial<QuestionBlock> = {}): QuestionBlock {
  return {
    kind: "question",
    toolUseId: "tool-1",
    questions: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "continue", label: "Yes" }], multiSelect: false }],
    timestamp: 2,
    ...overrides,
  }
}

function store(initial: { [key: string]: SessionEntry }) {
  const entries = new Map(Object.entries(initial))
  const revisions = new Map(Object.keys(initial).map((id) => [id, 1]))
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const sessionStore = fakeSessionStore(entries)
  return {
    store: {
      ...sessionStore,
      allIds: () => [...entries.keys()],
      get: (id: string) => entries.get(id),
      revision: (id: string) => revisions.get(id) ?? 0,
      onChange(listener: (changed: ReadonlySet<string> | undefined) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(id: string, next: SessionEntry) {
      entries.set(id, next)
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      for (const listener of listeners) listener(undefined)
    },
  }
}

function sink() {
  const sequencer = createRuntimeUiPatchSequencer()
  const patches: RuntimeUiPatch[] = []
  return {
    patches,
    publish(input: RuntimeUiPatchInput): RuntimeUiPatch {
      const patch = sequencer.publish(input)
      patches.push(patch)
      return patch
    },
  }
}

describe("question protocol projection", () => {
  // Each terminal fact carries the version the strict registry parses; the
  // answered fact records the discriminated answer the dock resolved.
  test.each([
    ["answer", "agent_input.answered", 3, { interactionId: "tool-1", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } }],
    ["dismiss", "agent_input.cancelled", 1, { interactionId: "tool-1", reason: "user_cancelled" }],
    ["unreadable answer", "agent_input.answered", 3, { interactionId: "tool-1", answers: { "Continue?": 5 } }],
  ] as const)("inactive session snapshot publishes removal after %s", async (_action, type, version, payload) => {
    const s = store({})
    const out = sink()
    const reader = createTestEventStore()
    reader.append({ aggregateId: "session:inactive", sessionId: "inactive", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2, payload: { interactionId: "tool-1", conversationId: "conv-1", toolUseId: "tool-1", request: question().questions } })
    const projection = await createQuestionProtocolProjection({ sessionStore: s.store, reader: asAsyncEventReadSurface(reader), onStored: reader.onStored, publish: out.publish })

    expect(await projection.snapshot("inactive")).toEqual(question())
    reader.append({ aggregateId: "session:inactive", sessionId: "inactive", type, version, actor: "user", timestamp: 3, payload })
    await projection.snapshot("inactive")
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.payload).toEqual({ kind: "question.removed" })
    projection.dispose()
  })

  test("pending question changes publish question patches", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const reader = createTestEventStore()
    const projection = await createQuestionProtocolProjection({ sessionStore: s.store, reader: asAsyncEventReadSurface(reader), onStored: reader.onStored, publish: out.publish })
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2, payload: { interactionId: "tool-1", conversationId: "conv-1", toolUseId: "tool-1", request: question().questions } })
    await projection.snapshot("chat-1")
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.cursor).toEqual({ scope: "session", domain: "question", sessionId: "chat-1" })
    expect(out.patches[0]!.payload).toEqual({ kind: "question.updated", question: question() })
    projection.dispose()
  })

  test("answered question removes the pending question view", async () => {
    const s = store({ "chat-1": entry({ outputBlocks: () => [question()] }) })
    const out = sink()
    const reader = createTestEventStore()
    const projection = await createQuestionProtocolProjection({ sessionStore: s.store, reader: asAsyncEventReadSurface(reader), onStored: reader.onStored, publish: out.publish })
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2, payload: { interactionId: "tool-1", conversationId: "conv-1", toolUseId: "tool-1", request: question().questions } })
    await projection.snapshot("chat-1")
    await flush()
    out.patches.length = 0
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.answered", version: 3, actor: "user", timestamp: 3, payload: { interactionId: "tool-1", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } } })
    await projection.snapshot("chat-1")
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.payload).toEqual({ kind: "question.removed" })
    projection.dispose()
  })

  test("docks pending questions in the order the agent asked them", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const reader = createTestEventStore()
    const projection = await createQuestionProtocolProjection({ sessionStore: s.store, reader: asAsyncEventReadSurface(reader), onStored: reader.onStored, publish: out.publish })
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2, payload: { interactionId: "tool-b", conversationId: "conv-1", toolUseId: "tool-b", request: question().questions } })
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 3, payload: { interactionId: "tool-a", conversationId: "conv-1", toolUseId: "tool-a", request: question().questions } })

    expect(await projection.snapshot("chat-1")).toEqual(question({ toolUseId: "tool-b", timestamp: 2 }))
    reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.answered", version: 3, actor: "user", timestamp: 4, payload: { interactionId: "tool-b", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "continue" }], text: "Yes" } } } })
    expect(await projection.snapshot("chat-1")).toEqual(question({ toolUseId: "tool-a", timestamp: 3 }))
    projection.dispose()
  })

  test("a failed read on a fact push is contained, and a later push still publishes", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const reader = createTestEventStore()
    const local = asAsyncEventReadSurface(reader)
    let refuse = false
    const refusing = { ...local, readPage: async (...args: Parameters<typeof local.readPage>) => {
      if (refuse) {
        refuse = false
        throw new Error("state read refused")
      }
      return local.readPage(...args)
    } }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    const projection = await createQuestionProtocolProjection({ sessionStore: s.store, reader: refusing, onStored: reader.onStored, publish: out.publish })
    try {
      refuse = true
      reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2, payload: { interactionId: "tool-1", conversationId: "conv-1", toolUseId: "tool-1", request: question().questions } })
      await Bun.sleep(0)
      reader.append({ aggregateId: "session:chat-1", sessionId: "chat-1", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 4, payload: { interactionId: "tool-2", conversationId: "conv-1", toolUseId: "tool-2", request: question().questions } })
      await Bun.sleep(0)

      expect(unhandled).toEqual([])
      expect(out.patches.map((patch) => patch.payload)).toEqual([{ kind: "question.updated", question: question() }])
      expect(await projection.snapshot("chat-1")).toEqual(question())
    } finally {
      process.off("unhandledRejection", onUnhandled)
      projection.dispose()
    }
  })

  test("schema round-trips question snapshot/patch and rejects output fields", () => {
    const pending = question()
    const snapshot = { snapshotPosition: 1, views: [{ sessionId: "s1", view: pending }] }
    const patch = { kind: "question.updated", question: pending } as const

    expect(Schema.decodeUnknownSync(RuntimeQuestionSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    expect(Schema.decodeUnknownSync(QuestionPatchPayloadSchema)(patch)).toEqual(patch)
    expect(() => Schema.decodeUnknownSync(QuestionPatchPayloadSchema)({ kind: "question.updated", question: { ...pending, content: "not output text" } }, { onExcessProperty: "error" })).toThrow()
  })
})
