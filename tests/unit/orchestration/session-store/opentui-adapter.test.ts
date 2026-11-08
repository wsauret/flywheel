import { afterEach, describe, expect, it } from "bun:test"
import { EventBus, createEmit } from "../../../../src/infra/event-bus.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import type { ChatEntryPatch } from "../../../../src/orchestration/session-store/types.js"
import { SessionEventAdapter } from "../../../../src/orchestration/session-store/event-adapter.js"
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/runner/output-session.js"

type Emit = ReturnType<typeof createEmit>

function emitRuntime(emit: Emit, sessionId: string, event: RuntimeEvent): void {
  emit(event.type, { sessionId, data: event.data })
}

describe("SessionEventAdapter", () => {
  let adapter: SessionEventAdapter | null = null

  afterEach(() => {
    adapter?.disconnect()
    adapter = null
  })

  it("projects ask_user waiting as awaiting_user", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.user_input.awaiting", { sessionId: "s1", data: {} })

    expect(patches).toEqual([{ runnerState: "awaiting_user", streamingStartedAt: null, waitingOnBackgroundWork: false }])
  })

  it("projects ask_user resume as streaming with a fresh timestamp", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.user_input.resumed", { sessionId: "s1", data: {} })

    expect(patches).toHaveLength(1)
    expect(patches[0]?.runnerState).toBe("streaming")
    expect(typeof patches[0]?.streamingStartedAt).toBe("number")
  })

  it("clears the active-clock anchor on park with no background work running", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.turn.parked", { sessionId: "s1", data: { handoffWritten: false, turnCount: 1, activeBackgroundCount: 0, parkedOnBackgroundWork: false, userResumeRequired: false, park: "idle" } })

    expect(patches).toEqual([{ runnerState: "idle", streamingStartedAt: null, waitingOnBackgroundWork: false }])
  })

  it("keeps the active-clock anchor running on a park that waits on background work", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.turn.parked", { sessionId: "s1", data: { handoffWritten: false, turnCount: 1, activeBackgroundCount: 2, parkedOnBackgroundWork: false, userResumeRequired: false, park: "waiting_on_work" } })

    expect(patches).toEqual([{ runnerState: "idle", waitingOnBackgroundWork: true }])
  })

  it("reports an interrupted turn idle only when the loop parks after its record", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.turn.interrupted", { sessionId: "s1", data: {} })
    // The interrupt alone reports nothing: the turn-end record is not yet durable.
    expect(patches).toEqual([])
    emit("agent.turn.parked", { sessionId: "s1", data: { handoffWritten: false, turnCount: 1, activeBackgroundCount: 1, parkedOnBackgroundWork: false, userResumeRequired: true, park: "interrupted" } })

    // Background work still runs, but the park waits for the person.
    expect(patches).toEqual([{ runnerState: "idle", streamingStartedAt: null, waitingOnBackgroundWork: false }])
  })

  it("reports a finished turn idle only when the loop parks, not at its logical end", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = new SessionEventAdapter({
      updateEntry: (patch) => patches.push(patch),
      outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: (patch) => patches.push(patch) }),
    })
    adapter.connect(bus)

    emit("agent.logical_turn.started", { sessionId: "s1", data: { origin: "user", reason: "new_input" } })
    emit("agent.logical_turn.ended", { sessionId: "s1", data: { status: "completed" } })
    // Input queued behind the turn, or an observer's nudge, starts the next
    // logical turn at once: the loop never yields between the two.
    emit("agent.logical_turn.started", { sessionId: "s1", data: { origin: "background", reason: "queued_input" } })
    emit("agent.turn.parked", { sessionId: "s1", data: { handoffWritten: false, turnCount: 2, activeBackgroundCount: 0, parkedOnBackgroundWork: false, userResumeRequired: false, park: "idle" } })

    expect(patches.flatMap((patch) => patch.runnerState ?? [])).toEqual(["streaming", "streaming", "idle"])
  })

  it("keeps concurrent members' output, pending input, and lifecycle in their ordinary sessions", () => {
    const first: ChatEntryPatch[] = []
    const second: ChatEntryPatch[] = []
    const bus = new EventBus()
    const emit = createEmit(bus)
    adapter = chatAdapter(first)
    adapter.connect(bus)
    const sibling = chatAdapter(second)
    const siblingBus = new EventBus()
    sibling.connect(siblingBus)
    try {
      emit("agent.logical_turn.started", { sessionId: "member-a", data: { origin: "system", reason: "new_input" } })
      emitRuntime(emit, "member-a", createRuntimeEvent("model.assistant_message.recorded", {
        type: "model.assistant_message.recorded", entry_id: "assistant-entry", message: { content: [{ type: "text", text: "Reading the parser." }] },
      }))
      emit("agent.message.injected", { sessionId: "member-a", data: { message: "wrap up", origin: "user", pending: true } })
      emit("agent.user_input.awaiting", { sessionId: "member-a", data: {} })
      adapter.flush()
      sibling.flush()
      const blocks = first.findLast((patch) => patch.outputBlocks)?.outputBlocks
      expect(blocks).toContainEqual(expect.objectContaining({ kind: "text", content: "Reading the parser." }))
      expect(blocks).toContainEqual(expect.objectContaining({ kind: "userMessage", content: "wrap up", pending: true }))
      expect(first.findLast((patch) => patch.runnerState)?.runnerState).toBe("awaiting_user")
      expect(second.flatMap((patch) => patch.outputBlocks ?? [])).toEqual([])
      expect(second.some((patch) => patch.runnerState !== undefined)).toBe(false)
    } finally {
      sibling.disconnect()
    }
  })

  it("syncs an injected user message synchronously (echo latency)", async () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = chatAdapter(patches)
    adapter.connect(bus)
    // Arm the 16ms sync debounce (a fresh session's first change syncs
    // immediately): the user message must bypass the armed window.
    adapter.flush()
    patches.length = 0

    emit("agent.message.injected", { sessionId: "wf-1", data: { message: "queued", origin: "user", pending: true } })

    const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
    expect(blockPatch).toBeDefined()
    expect(blockPatch!.outputBlocks).toHaveLength(1)
  })

  it("flushes a user runtime event in the emit tick on the direct critical seam", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const calls: string[] = []

    adapter = new SessionEventAdapter({ updateEntry: () => {}, outputSession: recordingOutputSession(calls) })
    adapter.connect(bus)

    emitRuntime(emit, "s1", { type: "model.user_message.recorded", data: { type: "model.user_message.recorded", message: { content: "hello", origin: "user" } } })

    expect(calls).toEqual(["dispatch:model.user_message.recorded", "drainQueued", "flush"])
  })

  it("drives the compaction spinner from main-agent compaction events", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = chatAdapter(patches)
    adapter.connect(bus)

    emit("agent.compaction.started", { sessionId: "s1", data: { type: "agent.compaction.started" } })

    expect(patches).toHaveLength(1)
    expect(typeof patches[0]?.compactionStartedAt).toBe("number")
  })

  it("ignores subagent compaction events (parentToolUseId set)", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = chatAdapter(patches)
    adapter.connect(bus)

    emit("agent.compaction.started", { sessionId: "s1", data: { type: "agent.compaction.started", parent_tool_use_id: "toolu_sub" } })
    emit("agent.compaction.completed", { sessionId: "s1", data: { type: "agent.compaction.completed", status: "completed", parent_tool_use_id: "toolu_sub" } })
    adapter.flush()

    expect(patches.some((p) => "compactionStartedAt" in p)).toBe(false)
    const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
    const blocks = blockPatch?.outputBlocks ?? []
    expect(blocks.some((b) => b.kind === "system")).toBe(false)
  })

  it("carries review mutations from a live system message onto the system block", async () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = chatAdapter(patches)
    adapter.connect(bus)

    const { buildMutationDiffEvidence } = await import("../../../../src/infra/mutation-diff-evidence.js")
    const mutationEvidence = await buildMutationDiffEvidence({
      version: 1, files: ["provider-quirks", "new-package"].map(path => ({ path, change: "modified", unifiedDiff: "@@ -1 +1 @@\n-old\n+new" })), omissions: [],
    }, "review", async () => {})
    emit("agent.system_message.recorded", {
      sessionId: "s1",
      data: { message: "Updated skill: `provider-quirks`. Created skill: `new-package`.", mutationEvidence },
    })
    await Promise.resolve()

    const blocks = patches.filter((p) => p.outputBlocks !== undefined).pop()?.outputBlocks ?? []
    const systemBlock = blocks.find((b): b is Extract<AnyBlock, { kind: "system" }> => b.kind === "system")
    expect(systemBlock).toBeDefined()
    expect(systemBlock!.message).toBe("Updated skill: `provider-quirks`. Created skill: `new-package`.")
    expect(systemBlock!.mutationEvidence).toEqual(mutationEvidence)
  })

  it("leaves review mutations absent on an ordinary system message and keeps its level", async () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    adapter = chatAdapter(patches)
    adapter.connect(bus)

    emit("agent.system_message.recorded", { sessionId: "s1", data: { message: "worker tree flush failed", level: "error" } })
    await Promise.resolve()

    const blocks = patches.filter((p) => p.outputBlocks !== undefined).pop()?.outputBlocks ?? []
    const systemBlock = blocks.find((b): b is Extract<AnyBlock, { kind: "system" }> => b.kind === "system")
    expect(systemBlock).toBeDefined()
    expect(systemBlock!.level).toBe("error")
    expect("reviewMutations" in systemBlock!).toBe(false)
  })

})

/** The adapter of a session that has a transcript of its own, as a chat's. */
function chatAdapter(patches: ChatEntryPatch[]): SessionEventAdapter {
  const push = (patch: ChatEntryPatch) => { patches.push(patch) }
  return new SessionEventAdapter({ updateEntry: push, outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: push }) })
}

function recordingOutputSession(calls: string[]): OutputSession {
  return {
    dispatchRuntimeEvent(event) { calls.push(`dispatch:${event.type}`) },
    applyProjectionEvent() {},
    beginTurn() {},
    pushUserMessage() {},
    seedBlocks() {},
    hasQueued: () => false,
    drainQueued() { calls.push("drainQueued"); return [] },
    withdrawQueued: () => null,
    pushSystemMessage() {},
    pushDivider() {},
    pushQuestion() {},
    answerQuestion() {},
    cancelQuestion() {},
    getBlocks: () => [],
    endTurn() {},
    streamPhase: null,
    sessionId: "s1",
    flush() { calls.push("flush") },
    dispose() {},
  }
}
