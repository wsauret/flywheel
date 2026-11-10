import { expect, test } from "bun:test"

import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { asAsyncEventReadSurface, type EventStoreReadSurface } from "../../../../src/infra/event-store-types.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { childSessionProjectionAttachment } from "../../../../src/orchestration/session-store/child-session-projection.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"

const emptyEventStore: EventStoreReadSurface = {
  read: () => [],
  readTolerant: () => [],
  readLatestPayloadByAggregateAndType: () => null,
  readLatestByAggregateAndTypes: () => [],
  readInFlight: () => [],
  sessionsWithInFlight: () => [],
  inFlightProfileKeys: () => [],
  currentPosition: () => 0,
  countByAggregate: () => 0,
  aggregateSeq: () => -1,
  foldEvidence: () => ({ head: 0, generation: 0, anchor: null }),
  toolContent: { resolve: () => null },
}

test("a child's own transcript includes unanchored unreadable session facts", async () => {
  let blocks: readonly AnyBlock[] = []
  let activeMs: number | undefined
  const reader = asAsyncEventReadSurface(inMemoryEventReader([{
    id: "damaged", position: 1, seq: 0, aggregateId: "session:child", sessionId: "child",
    type: "agent_input.answered", version: 3, actor: "user", timestamp: 1,
    payload: { interactionId: "missing", answers: { Q: 5 } },
  }, {
    id: "duration", position: 2, seq: 1, aggregateId: "session:child", sessionId: "child",
    type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: 2,
    payload: { accumulatedActiveMs: 7000 },
  }]))
  const projection = await childSessionProjectionAttachment({
    openSessionRuntime: (input) => {
      blocks = input.priorBlocks ?? []
      activeMs = input.accumulatedActiveMs
      return "child"
    },
    updateChatEntry: () => {},
    remove: async () => {},
  })({
    sessionId: "child",
    conversationId: "conversation",
    description: "child",
    executionCwd: "/workspace",
    eventStore: reader,
    projectionReader: reader,
  })
  try {
    expect(activeMs).toBe(7000)
    expect(blocks).toEqual([expect.objectContaining({
      kind: "degraded", factFamily: "agent_input", eventPosition: 1, failureClass: "decode_failure",
    })])
  } finally {
    await projection.dispose()
  }
})

test("a workflow member opens its ordinary session and keeps reconnect and compaction private", async () => {
  const states = new Map<string, { [key: string]: unknown }>()
  const attach = childSessionProjectionAttachment({
    openSessionRuntime: (input) => { states.set(input.sessionId, { kind: input.kind }); return input.sessionId },
    updateChatEntry: (id, patch) => { Object.assign(states.get(id)!, patch) },
    remove: async () => {},
  })
  const reader = asAsyncEventReadSurface(emptyEventStore)
  const members = await Promise.all(["a", "b"].map((sessionId) => attach({
    kind: "workflow-agent", workflowId: "workflow", sessionId, conversationId: `conversation-${sessionId}`,
    description: sessionId, executionCwd: "/workspace", eventStore: reader, projectionReader: reader,
  })))
  try {
    expect(states.get("a")?.kind).toBe("workflow-agent")
    members[0]!.lifecycle.onConnectionState?.("reconnecting")
    members[0]!.onEvent(createRuntimeEvent("agent.compaction.started", {}))
    expect(states.get("a")).toMatchObject({ compactionStartedAt: expect.any(Number) })
    expect(states.get("b")).not.toHaveProperty("compactionStartedAt")
    expect(states.get("b")).not.toHaveProperty("connectionState")
  } finally { await Promise.all(members.map((member) => member.dispose())) }
})

test("a child projection shows a queued message immediately, under the identity and the sender it came from, and sends the batch together", async () => {
  let blocks: readonly AnyBlock[] = []
  const store: Pick<SessionStore, "openSessionRuntime" | "updateChatEntry" | "remove"> = {
    openSessionRuntime: () => "child",
    updateChatEntry: (_sessionId, patch) => {
      if (patch.outputBlocks) blocks = patch.outputBlocks
    },
    remove: async () => {},
  }
  const projection = await childSessionProjectionAttachment(store)({
    sessionId: "child",
    conversationId: "conversation",
    description: "child",
    executionCwd: "/workspace",
    eventStore: asAsyncEventReadSurface(emptyEventStore),
    projectionReader: asAsyncEventReadSurface(emptyEventStore),
  })

  try {
    projection.queueUserMessage({
      text: "parent guidance",
      producer: { kind: "session", sessionId: "parent", conversationId: "parent-conversation", toolUseId: "call-1", hop: 0, envelope: { name: "Root", relation: "parent", waits: false } },
    })
    projection.queueUserMessage({ text: "human guidance", submissionIds: ["local-1"], producer: { kind: "human" } })
    const queued = blocks.filter((block) => block.kind === "userMessage")
    expect(queued).toEqual([
      expect.objectContaining({ content: "parent guidance", pending: true, from: { sessionId: "parent", name: "Root", relation: "parent" } }),
      expect.objectContaining({ content: "human guidance", pending: true, submissionIds: ["local-1"] }),
    ])
    expect(queued[0]).not.toHaveProperty("submissionIds")
    expect(queued[1]).not.toHaveProperty("from")

    projection.onEvent(createRuntimeEvent("model.user_message.recorded", {
      type: "model.user_message.recorded",
      message: { origin: "user", content: [{ type: "text", text: "parent guidance" }] },
    }))
    expect(blocks.filter((block) => block.kind === "userMessage")).toEqual([
      expect.objectContaining({ content: "parent guidance", pending: false }),
      expect.objectContaining({ content: "human guidance", pending: false }),
    ])
  } finally {
    await projection.dispose()
  }
})

test("a child projection states the child's running background commands on its entry, and none once it is disposed", async () => {
  const patches: unknown[] = []
  const projection = await childSessionProjectionAttachment({
    openSessionRuntime: () => "child",
    updateChatEntry: (_sessionId, patch) => { if ("activeBackgroundCommands" in patch) patches.push(patch.activeBackgroundCommands) },
    remove: async () => {},
  })({
    sessionId: "child",
    conversationId: "conversation",
    description: "child",
    executionCwd: "/workspace",
    eventStore: asAsyncEventReadSurface(emptyEventStore),
    projectionReader: asAsyncEventReadSurface(emptyEventStore),
  })
  const command = { id: "bash-bg-1", description: "python3 reshape.py", toolUseId: "toolu_reshape", startedAtMs: 1 }
  projection.updateBackgroundCommands([command])
  await projection.dispose()
  expect(patches).toEqual([[command], []])
})
