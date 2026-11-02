import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { OutputProjector } from "../../../../src/infra/output/output-projector.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { workflowLaunchRetainedOperation } from "../../../../src/orchestration/modules/workflows/launch-operation.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

describe("RuntimeSupervisor question settlement, compaction, and recall", () => {
  test("joins accepted retained work through cold startup and the post-startup admission tail", async () => {
    const startup = createDeferred<Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>>()
    const admitted = createDeferred<void>()
    const accepting = createDeferred<void>()
    const base = supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
      acceptRetainedOperation: async () => { accepting.resolve(); await admitted.promise },
    }) })
    const authority = workflowLaunchRetainedOperation.bind({
      reader: ctx.runtime.runSync(EventReaderService), writer: ctx.runtime.runSync(EventStoreWriterService),
      hosts: { get: () => undefined },
    })
    const supervisor = createRuntimeSupervisor({ ...base, runnerCapabilities: () => startup.promise, retainedOperations: [authority], closeStartupGraceMs: 0 })
    try {
      const parent = await supervisor.openSessionRuntime()
      const entry = ctx.sessionStore.get(parent)
      if (entry?.kind !== "chat") throw new Error("Missing parent shell")
      const operation = { kind: "workflow.launch", version: 1, operationId: "accepted", parentSessionId: parent,
        parentConversationId: entry.conversationId, childSessionId: "child", toolUseId: "launch",
        parentEntryId: "itb-settled-accepted", acceptedAt: new Date().toISOString(), initiator: "person",
        launch: { workflowDefinitionId: "work", description: "accepted work" } }
      expect(await supervisor.acceptRetainedOperation(parent, { kind: "workflow.launch", key: "accepted", payload: operation })).toBe(true)
      let drained = false
      const settlement = supervisor.awaitAcceptedWork().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      startup.resolve(await base.runnerCapabilities())
      await accepting.promise
      expect(drained).toBe(false)
      admitted.resolve()
      await settlement
      expect(drained).toBe(true)
      expect(supervisor.ownedSessionIds()).toContain(parent)
    } finally {
      admitted.resolve()
      startup.resolve(await base.runnerCapabilities())
      await supervisor.disposeAll()
    }
  })
  test("compact on a shell with no attached runner returns false and creates no runner", async () => {
    let createCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => { createCalls += 1; return mockRunner(deps.sessionId) })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.compactChat(sessionId)).resolves.toBe(false)
    expect(createCalls).toBe(0)
    expect(ctx.sessionStore.get(sessionId)?.runner).toBeNull()
  })

  test("compact delegates to the attached runner unchanged", async () => {
    let compactCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      compact: async () => { compactCalls += 1; return true },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })

    await expect(supervisor.compactChat(sessionId)).resolves.toBe(true)
    expect(compactCalls).toBe(1)
  })

  test("answer and cancel reject unknown questions and settle recorded questions without a live waiter", async () => {
    let resumes = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      resumeCommitted: () => { resumes += 1; return true },
    }))
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.answerQuestion(sessionId, "tool_a", { Pick: { kind: "freeform", text: "A" } })).resolves.toEqual({ ok: false, refusal: "not_pending" })
    await expect(supervisor.cancelQuestion(sessionId, "tool_a")).resolves.toEqual({ ok: false, refusal: "not_pending" })
    await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })
    for (const toolUseId of ["tool_b", "tool_c"]) {
      await ctx.store.append({
        aggregateId: `session:${sessionId}`,
        sessionId,
        type: "agent_input.requested",
        version: 3,
        actor: "agent",
        timestamp: Date.now(),
        payload: {
          interactionId: toolUseId,
          conversationId: "conversation-1",
          toolUseId,
          request: [{ question: "Pick", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }],
        },
      })
    }
    await expect(supervisor.answerQuestion(sessionId, "tool_b", { Pick: { kind: "freeform", text: "B" } })).resolves.toEqual({ ok: true })
    await expect(supervisor.cancelQuestion(sessionId, "tool_c")).resolves.toEqual({ ok: true })
    expect(ctx.store.read({ aggregateId: `session:${sessionId}`, types: ["agent_input.answered", "agent_input.cancelled"] }).map((fact) => fact.type)).toEqual(["agent_input.answered", "agent_input.cancelled"])
    expect(resumes).toBe(0)
  })

  // A question suspended by an interrupt or a restart stays pending while the
  // conversation moves on. Its skip is durable only: no tool waits on it, and
  // the display of a turn in flight is not reseeded, so the settlement itself
  // must show on the live block. A second skip says why it does nothing.
  test.each([
    ["streaming", { runnerState: "streaming" as const }],
    ["waiting on background work", { runnerState: "idle" as const, waitingOnBackgroundWork: true }],
  ])("a durable-only skip while the turn is %s settles the live question block and refuses a second skip", async (_label, turn) => {
    const display = new OutputProjector({ executionCwd: "/workspace" })
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      applyProjectionEvent: (event) => {
        display.apply(event)
        ctx.sessionStore.updateChatEntry(deps.sessionId, { outputBlocks: [...display.getBlocks()], visibleMessageCountSuffix: 0 })
      },
    }))
    const records = spyOn(DebugLog, "record")
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await expect(supervisor.sendChat(sessionId, "Ask me")).resolves.toEqual({ ok: true })
      const entry = ctx.sessionStore.get(sessionId)
      if (entry?.kind !== "chat") throw new Error("missing chat")
      const question = { question: "Pace?", choices: [{ kind: "freeform" as const, label: "Other" }], multiSelect: false }
      await ctx.store.append({
        aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
        payload: { interactionId: "ask-1", conversationId: entry.conversationId, toolUseId: "ask-1", request: [question] },
      })
      entry.runner?.applyProjectionEvent({ type: "push-question", toolUseId: "ask-1", questions: [question], timestamp: 1 })
      ctx.sessionStore.updateChatEntry(sessionId, turn)

      await expect(supervisor.cancelQuestion(sessionId, "ask-1")).resolves.toEqual({ ok: true })
      expect(ctx.sessionStore.get(sessionId)?.outputBlocks().find((block) => block.kind === "question")).toMatchObject({ toolUseId: "ask-1", cancelled: true })
      records.mockClear()
      await expect(supervisor.cancelQuestion(sessionId, "ask-1")).resolves.toEqual({ ok: false, refusal: "already_skipped" })
      expect(records.mock.calls.map(([record]) => record).filter((record) => record.type === "question.settlement.refused"))
        .toEqual([{ type: "question.settlement.refused", sessionId, payload: { toolUseId: "ask-1", refusal: "already_skipped" } }])
    } finally {
      records.mockRestore()
      await supervisor.disposeAll()
    }
  })

  test("targeted background termination delegates by toolUseId without invoking turn interrupt", async () => {
    const terminated: string[] = []
    let interrupted = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      interrupt: () => { interrupted += 1; return true },
      terminateBackgroundWork: (toolUseId) => { terminated.push(toolUseId) },
    }))
    const sessionId = await supervisor.openSessionRuntime()

    await supervisor.terminateBackgroundWork(sessionId, "tool_live")
    await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })
    await supervisor.terminateBackgroundWork(sessionId, "tool_wrong")
    await supervisor.terminateBackgroundWork(sessionId, "tool_live")
    expect(terminated).toEqual(["tool_wrong", "tool_live"])
    expect(interrupted).toBe(0)
  })

  test("a bound child's refused Stop reaches the caller without falling back to its parent's runner", async () => {
    const terminated: string[] = []
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        terminateBackgroundWork: (id) => { terminated.push(id) },
      }) }),
      sessionStops: async () => async () => ({ ok: false, error: "Cancellation was not confirmed." }),
    })
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })
      await expect(supervisor.terminateBackgroundWork(sessionId, "child-call")).rejects.toThrow("Cancellation was not confirmed.")
      expect(terminated).toEqual([])
    } finally {
      await supervisor.disposeAll()
    }
  })

  test("recall resolves through the async actor path to the runner's recalled input", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      recallQueuedMessage: () => "recalled text",
    }))
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.recallQueuedMessage(sessionId)).resolves.toBeNull()

    await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })
    await expect(supervisor.recallQueuedMessage(sessionId)).resolves.toBe("recalled text")
  })

  test("recall on an attached runner is ordered behind an earlier injecting send", async () => {
    const events: string[] = []
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
      send: async () => { events.push("inject"); return "accepted" as const },
      recallQueuedMessage: () => { events.push("recall"); return "queued" },
    }))
    const sessionId = await supervisor.openSessionRuntime()
    // First send attaches the runner; subsequent sends inject into it.
    await expect(supervisor.sendChat(sessionId, "first")).resolves.toEqual({ ok: true })

    const send = supervisor.sendChat(sessionId, "second")
    const recall = supervisor.recallQueuedMessage(sessionId)

    await expect(send).resolves.toEqual({ ok: true })
    await expect(recall).resolves.toBe("queued")
    expect(events).toEqual(["inject", "recall"])
  })

  test("compact, answer, cancel, and recall never create a runner on a cold shell", async () => {
    let createCalls = 0
    const supervisor = supervisorWithRunner(ctx, async (deps) => { createCalls += 1; return mockRunner(deps.sessionId) })
    const sessionId = await supervisor.openSessionRuntime()

    await expect(supervisor.answerQuestion(sessionId, "t", {})).resolves.toEqual({ ok: false, refusal: "not_pending" })
    await expect(supervisor.cancelQuestion(sessionId, "t")).resolves.toEqual({ ok: false, refusal: "not_pending" })
    await expect(supervisor.compactChat(sessionId)).resolves.toBe(false)
    await expect(supervisor.recallQueuedMessage(sessionId)).resolves.toBeNull()
    expect(createCalls).toBe(0)
  })
})
