import { afterEach, describe, expect, mock, test } from "bun:test"
import { until } from "../workflow-host/_workflow-controller-fixtures.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { cleanup, compose, context, parentChat, branch, modelCall, quietAgent } from "./_runtime-supervisor-workflow-launch-fixtures.js"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog.js"

afterEach(cleanup)

describe("a model workflow launch through its parent chat actor", () => {
  test("delivers a failed startup to its real parent Chat without holding the parent's command mailbox", async () => {
    const gate = Promise.withResolvers<void>()
    const reporting = Promise.withResolvers<void>()
    const ctx = context()
    const composition = compose(ctx, {
      realChat: true, reconcilesThroughParentActor: true, runsWorkflows: quietAgent,
      runtimePreflight: async () => { throw new Error("preflight failure") },
      beforeParentReconciliation: async () => { reporting.resolve(); await gate.promise },
    })
    const parentId = await parentChat(ctx)
    await composition.supervisor.activateSession(parentId)
    const launching = modelCall(ctx, composition, parentId)
    await reporting.promise
    try {
      expect(await composition.supervisor.renameSession(parentId, { title: "Failure report is blocked" })).toBe(true)
      expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
      expect(composition.modelTurns()).toBe(0)
    } finally { gate.resolve() }
    await launching
    await until(() => composition.modelTurns() === 1, "the parent consuming the failure")
    const entry = ctx.sessionStore.get(parentId)
    if (entry?.kind !== "chat" || !entry.runner) throw new Error("the parent Chat is not attached")
    await entry.runner.pendingTurnSettlement
    expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    expect((await branch(ctx, parentId)).at(-1)).toMatchObject({ kind: "message", message: { kind: "assistant" } })
  })

  test("hands a real workflow terminal result to its parent before the parent turn settles", async () => {
    const outcome = Promise.withResolvers<{ servedRequests: 0, durationMs: number; terminal: { kind: "api_error"; message: string, recovery: { kind: "none" } } }>()
    const started = Promise.withResolvers<void>()
    const reconciling = Promise.withResolvers<void>()
    const releaseParent = Promise.withResolvers<void>()
    const ctx = context()
    const composition = compose(ctx, { realChat: true, reconcilesThroughParentActor: true,
      parentTurnEnds: async () => { reconciling.resolve(); await releaseParent.promise },
      runsWorkflows: (options) => {
        if (options.purpose.kind !== "workflow-agent") return quietAgent(options)
        started.resolve()
        return { send() {}, end() {}, abort() {}, done: outcome.promise }
      },
    })
    const parentId = await parentChat(ctx)
    await composition.supervisor.activateSession(parentId)
    const launch = await modelCall(ctx, composition, parentId)
    await started.promise
    expect(ctx.workflowHosts.isRunning(launch.workflowId)).toBe(true)
    expect(composition.modelTurns()).toBe(0)
    outcome.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "api_error", message: "terminal failure", recovery: { kind: "none" } } })
    await reconciling.promise
    try {
      expect(ctx.workflowHosts.isRunning(launch.workflowId)).toBe(true)
      expect(composition.modelTurns()).toBe(0)
      expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(0)
    } finally { releaseParent.resolve() }
    await until(() => composition.modelTurns() === 1, "the parent's result turn")
    const entry = ctx.sessionStore.get(parentId)
    if (entry?.kind !== "chat" || !entry.runner) throw new Error("the parent Chat is not attached")
    await entry.runner.pendingTurnSettlement
    expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    expect((await branch(ctx, parentId)).some(({ id }) => id === `workflow-completion:${launch.workflowId}`)).toBe(true)
    expect((await branch(ctx, parentId)).at(-1)).toMatchObject({ kind: "message", message: { kind: "assistant" } })
  })

  test("holds a workflow result during disposal without creating an actor or waking Chat", async () => {
    const outcome = Promise.withResolvers<{ servedRequests: 0, durationMs: number; terminal: { kind: "api_error"; message: string, recovery: { kind: "none" } } }>()
    const started = Promise.withResolvers<void>()
    const hostsClosing = Promise.withResolvers<void>()
    const continueStop = Promise.withResolvers<void>()
    const ctx = context()
    const composition = compose(ctx, { realChat: true, reconcilesThroughParentActor: true, runsWorkflows: (options) => {
      if (options.purpose.kind !== "workflow-agent") return quietAgent(options)
      started.resolve()
      return { send() {}, end() {}, abort() {}, done: outcome.promise }
    } })
    const parentId = await parentChat(ctx)
    await composition.supervisor.activateSession(parentId)
    const launch = await modelCall(ctx, composition, parentId)
    await started.promise
    const closeHosts = ctx.workflowHosts.disposeAll
    ctx.workflowHosts.disposeAll = async (causeOf) => { hostsClosing.resolve(); await continueStop.promise; await closeHosts(causeOf) }
    const stopping = composition.supervisor.disposeAll()
    await hostsClosing.promise
    outcome.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "api_error", message: "terminal failure during stop", recovery: { kind: "none" } } })
    try {
      await until(() => ctx.store.readInFlight(parentId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).length === 1, "the held result")
      expect(composition.modelTurns()).toBe(0)
      expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    } finally { continueStop.resolve(); await stopping }
    expect(composition.supervisor.ownedSessionIds()).toEqual([])
    const after = compose(context(ctx.baseDir), { realChat: true, reconcilesThroughParentActor: true })
    await after.supervisor.activateSession(parentId)
    expect((await branch(ctx, parentId)).some(({ id }) => id === `workflow-completion:${launch.workflowId}`)).toBe(true)
    expect(ctx.store.readInFlight(parentId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
  })

  test("reconciles already-admitted work durably without waking a closing real Chat", async () => {
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const ctx = context()
    const composition = compose(ctx, { realChat: true, reconcilesThroughParentActor: true, runsWorkflows: quietAgent, parentTurnEnds: async () => { reached.resolve(); await gate.promise } })
    const parentId = await parentChat(ctx)
    await composition.supervisor.activateSession(parentId)
    await modelCall(ctx, composition, parentId)
    await reached.promise
    const stopping = composition.supervisor.disposeAll()
    await expect(composition.supervisor.recallQueuedMessage(parentId)).rejects.toThrow("runtime supervisor is disposed")
    gate.resolve()
    await stopping
    expect(composition.modelTurns()).toBe(0)
    expect(ctx.store.readInFlight(parentId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    expect(composition.supervisor.ownedSessionIds()).toEqual([])
  })

  test("keeps a child that cannot start: it settles the parent's call failed once, with no Stop and no deletion", async () => {
    const ctx = context()
    const onRunnerError = mock(async () => {})
    const composition = compose(ctx, { onRunnerError })
    composition.workflows.start = mock(async (): Promise<string> => { throw new Error("runner boom") })
    const parentId = await parentChat(ctx)
    const launch = await modelCall(ctx, composition, parentId)
    await until(() => onRunnerError.mock.calls.length > 0, "the start failure")

    expect(onRunnerError).toHaveBeenCalledWith(launch.workflowId, "runner boom")
    const child = await workflowRunReader(composition.reader).read(launch.workflowId)
    expect(child).not.toBeNull()
    if (!child?.launchedFrom.toolUseId) throw new Error("the run has no launch binding")
    expect(ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] }).map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ toolUseId: child.launchedFrom.toolUseId, outcome: "error" }),
    ])
    expect((await ctx.manager.read(parentId))?.childSessionIds ?? []).toEqual([])
    expect((await workflowRunReader(composition.reader).listForParent(parentId)).map(({ workflowId }) => workflowId)).toEqual([launch.workflowId])
  })
})
