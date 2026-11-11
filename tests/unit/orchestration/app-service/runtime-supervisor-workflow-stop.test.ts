import { afterEach, describe, expect, test } from "bun:test"
import type { SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { until } from "../workflow-host/_workflow-controller-fixtures.js"
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { readChildStop } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { cleanup, compose, context, parentChat, branch, modelCall } from "./_runtime-supervisor-workflow-launch-fixtures.js"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import { workflowProtocol } from "./app-service-doubles.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"

afterEach(cleanup)

describe("a person's Stop of a workflow child", () => {
  /** The parent's results for `toolUseId`. */
  function callResults(ctx: SupervisorTestContext, parentId: string, toolUseId: string) {
    return ctx.store.read({ aggregateId: `session:${parentId}`, types: ["tool.result.recorded"] })
      .map(({ payload }) => payload)
      .filter((payload) => payload.toolUseId === toolUseId)
  }

  /** Presses Stop on the child twice, as a client sends it to the parent's
   *  launching call, and proves one settlement: the call records the person's
   *  Stop once, the child is aborted once, and the repeat changes nothing. */
  async function stopsOnce(ctx: SupervisorTestContext, composition: ReturnType<typeof compose>, childId: string): Promise<void> {
    const child = await workflowRunReader(composition.reader).read(childId)
    if (!child?.launchedFrom.toolUseId) throw new Error("the run has no launch binding")
    const { parentSessionId, toolUseId } = child.launchedFrom

    await composition.supervisor.terminateBackgroundWork(parentSessionId, toolUseId)

    expect(callResults(ctx, parentSessionId, toolUseId)).toEqual([expect.objectContaining({ outcome: "stopped" })])
    expect(await readChildStop(composition.reader, child.launchedFrom)).toBe("person")
    expect(composition.workflows._abortCalls).toEqual([childId])

    await composition.supervisor.terminateBackgroundWork(parentSessionId, toolUseId)

    expect(callResults(ctx, parentSessionId, toolUseId)).toHaveLength(1)
    expect(composition.workflows._abortCalls).toEqual([childId])
  }

  test("of a model launch answers the model's waiting call from the durable Stop", async () => {
    const ctx = context()
    const composition = compose(ctx)
    const parentId = await parentChat(ctx)
    const launch = await modelCall(ctx, composition, parentId)

    await stopsOnce(ctx, composition, launch.workflowId)

    await expect(launch.done).resolves.toMatchObject({ status: "stopped", content: expect.stringContaining("The user stopped it before it finished") })
  })

  test("of a model launch settles after the executor restarts, when no runner holds the call", async () => {
    const first = context()
    const parentId = await parentChat(first)
    const before = compose(first)
    const launch = await modelCall(first, before, parentId)
    await before.supervisor.disposeAll()
    await first.runtime.dispose()

    const ctx = context(first.baseDir)
    await stopsOnce(ctx, compose(ctx), launch.workflowId)
  })

  /** Whether the parent holds or shows the notification of `childId`'s end. */
  async function notified(ctx: SupervisorTestContext, parentId: string, childId: string): Promise<boolean> {
    const key = `workflow-completion:${childId}`
    return ctx.store.readInFlight(parentId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).some((row) => row.key === key)
      || (await branch(ctx, parentId)).some((entry) => entry.id === key)
  }

  /** A model launch whose child runs in a real workflow runner while the
   *  parent's turn runs. Once the launch exists, that turn ends only after
   *  the launch's done answers it and the test calls `endTurn`, and every
   *  reconciliation of the parent waits for it. The first step's agent
   *  either works until the workflow runner aborts its model request, or
   *  fails at once, so the run ends. */
  async function launchWhileParentTurnRuns(step: "works" | "fails") {
    const stepRuns = Promise.withResolvers<void>()
    const runsWorkflows: AgentFactory = (options) => {
      if (options.purpose.kind !== "workflow-agent" || step === "fails") {
        if (options.purpose.kind === "workflow-agent") stepRuns.resolve()
        return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: options.purpose.kind === "workflow-agent" ? { kind: "api_error", message: "the provider failed", recovery: { kind: "none" } } : { kind: "completed" } }) }
      }
      return newTestRunner({ ...options, agentRegistry: new Map(), agentsMd: "" }, async () => asModelClient({
        accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools(request) {
          stepRuns.resolve()
          yield { kind: "text_delta", text: "working", blockKey: "text" }
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            request.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      }))
    }
    // What the parent's running turn waits on once the launch exists.
    const turnWaitsOn: Promise<unknown>[] = []
    let waitingReconciliations = 0
    const turnEnds = Promise.withResolvers<void>()
    const ctx = context()
    const composition = compose(ctx, { reconcilesThroughParentActor: true, runsWorkflows, parentTurnEnds: async () => {
      if (turnWaitsOn.length === 0) return
      waitingReconciliations += 1
      await Promise.all([...turnWaitsOn, turnEnds.promise])
    } })
    const parentId = await parentChat(ctx)
    expect(await composition.supervisor.activateSession(parentId)).toBe(true)
    await composition.supervisor.ensureChatRunner(parentId)
    const launch = await modelCall(ctx, composition, parentId)
    turnWaitsOn.push(launch.done)
    await stepRuns.promise
    return { ctx, composition, parentId, launch, endTurn: turnEnds.resolve, waitingReconciliations: () => waitingReconciliations }
  }

  /** Presses Stop on the launch and proves that it returns while the
   *  parent's turn still runs. */
  async function stopsWhileParentTurnRuns(running: Awaited<ReturnType<typeof launchWhileParentTurnRuns>>): Promise<void> {
    const { ctx, composition, parentId, launch } = running
    let stopped = false
    const stop = composition.supervisor.terminateBackgroundWork(parentId, "workflow-call").then(() => { stopped = true })
    await until(() => stopped, "the Stop while the parent's turn waits on the launch")
    await stop
    expect(callResults(ctx, parentId, "workflow-call")).toEqual([expect.objectContaining({ outcome: "stopped" })])
    await expect(launch.done).resolves.toMatchObject({ status: "stopped" })
    expect(await notified(ctx, parentId, launch.workflowId)).toBe(false)
  }

  /** Waits until the child's runner is gone and the child is idle. */
  async function childEnds(ctx: SupervisorTestContext, childId: string): Promise<void> {
    for (let attempt = 0; attempt < 200 && ctx.workflowHosts.isRunning(childId); attempt += 1) await Bun.sleep(5)
    expect(ctx.workflowHosts.isRunning(childId)).toBe(false)
    expect(await workflowRunReader(ctx.runtime.runSync(EventReaderService)).read(childId)).not.toBeNull()
  }

  test("of a model launch answers the parent's turn that waits on it and ends the child's runner at once; its notification lands when that turn ends", async () => {
    const running = await launchWhileParentTurnRuns("works")
    const { ctx, composition, parentId, launch } = running

    await stopsWhileParentTurnRuns(running)
    await childEnds(ctx, launch.workflowId)

    running.endTurn()
    // Queued behind the Stop's own reconciliation of the parent.
    await composition.supervisor.reconcileChildSessionCompletions(parentId)
    expect(await notified(ctx, parentId, launch.workflowId)).toBe(true)
  })

  test("of a model launch whose run already ended returns at once while that end waits on the parent's turn", async () => {
    // The runner reports the run's end to the parent, behind the parent's
    // running turn.
    const running = await launchWhileParentTurnRuns("fails")
    const { ctx, composition, parentId, launch } = running
    await until(() => running.waitingReconciliations() > 0, "the run's end report to the parent")

    await stopsWhileParentTurnRuns(running)
    expect(ctx.workflowHosts.isRunning(launch.workflowId)).toBe(true)

    running.endTurn()
    await childEnds(ctx, launch.workflowId)
    await composition.supervisor.reconcileChildSessionCompletions(parentId)
    expect(await notified(ctx, parentId, launch.workflowId)).toBe(true)
  })

  // The deletion twin of a Stop: the parent's attached runner takes the
  // notification at once, so a parent that waits on the child wakes.
  test("by deleting the child of a model launch hands its notification to the parent's attached runner once", async () => {
    const delivered: Array<{ readonly sessionId: string; readonly key: string | undefined }> = []
    const ctx = context()
    const composition = compose(ctx, { onBackgroundNotification: (sessionId, key) => { delivered.push({ sessionId, key }) } })
    const parentId = await parentChat(ctx)
    expect(await composition.supervisor.activateSession(parentId)).toBe(true)
    await composition.supervisor.ensureChatRunner(parentId)
    const launch = await modelCall(ctx, composition, parentId)

    const protocol = workflowProtocol({ controller: composition.controller, supervisor: composition.supervisor, store: ctx.store, sessions: ctx.sessionStore, manager: ctx.manager, hosts: composition.workflows })
    expect(await protocol.mutate({ type: "workflow.delete", workflowId: launch.workflowId })).toEqual({ ok: true })
    protocol.dispose()

    expect(await workflowRunReader(composition.reader).read(launch.workflowId)).toBeNull()
    expect(callResults(ctx, parentId, "workflow-call")).toEqual([expect.objectContaining({ outcome: "stopped" })])
    expect(delivered).toEqual([{ sessionId: parentId, key: `workflow-completion:${launch.workflowId}` }])
  })

  // A notification wakes a parked parent into a model request. The deletion
  // of the parent removes it, so its child's end has no reader there.
  test("by deleting the parent of a model launch hands its notification to no runner", async () => {
    const delivered: Array<{ readonly sessionId: string; readonly key: string | undefined }> = []
    const ctx = context()
    const composition = compose(ctx, { onBackgroundNotification: (sessionId, key) => { delivered.push({ sessionId, key }) } })
    const parentId = await parentChat(ctx)
    expect(await composition.supervisor.activateSession(parentId)).toBe(true)
    await composition.supervisor.ensureChatRunner(parentId)
    const launch = await modelCall(ctx, composition, parentId)

    expect(await composition.supervisor.deleteSession(parentId)).toBe(true)

    expect(await workflowRunReader(composition.reader).read(launch.workflowId)).toBeNull()
    expect(await ctx.manager.read(parentId)).toBeNull()
    expect(delivered).toEqual([])
  })

  test("of a model launch whose runtime still starts runs no step of the child", async () => {
    const preflight = Promise.withResolvers<void>()
    const preflightRuns = Promise.withResolvers<void>()
    let stepAgents = 0
    const runsWorkflows: AgentFactory = (options) => {
      if (options.purpose.kind === "workflow-agent") stepAgents += 1
      return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: options.purpose.kind === "workflow-agent" ? { kind: "api_error", message: "the provider failed", recovery: { kind: "none" } } : { kind: "completed" } }) }
    }
    const ctx = context()
    const composition = compose(ctx, { runsWorkflows, runtimePreflight: async () => { preflightRuns.resolve(); await preflight.promise } })
    const parentId = await parentChat(ctx)
    const launching = modelCall(ctx, composition, parentId)
    await preflightRuns.promise

    await composition.supervisor.terminateBackgroundWork(parentId, "workflow-call")
    preflight.resolve()
    const launch = await launching

    await expect(launch.done).resolves.toMatchObject({ status: "stopped" })
    await childEnds(ctx, launch.workflowId)
    expect(stepAgents).toBe(0)
    // The child's run started and paused before its first step; it did not
    // fail to start.
    expect(ctx.store.read({ aggregateId: `workflow:${launch.workflowId}`, types: ["workflow.paused"] })).toHaveLength(1)
    expect(callResults(ctx, parentId, "workflow-call")).toEqual([expect.objectContaining({ outcome: "stopped" })])
  })

  test("of a background command goes to the runner and reads no child of the parent", async () => {
    const reads: string[] = []
    const ctx = context()
    const composition = compose(ctx, { onStopRead: (sessionId) => { reads.push(sessionId) } })
    const parentId = await parentChat(ctx)
    await modelCall(ctx, composition, parentId)
    await until(() => composition.workflows._startCalls.length === 1, "the workflow start")
    const input = { command: "sleep 100" }
    const evidence = contentEvidence(JSON.stringify(input))
    const facts = createSessionFactWriter({ sessionId: parentId, writer: composition.writer })
    await facts.record({
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: {
        toolUseId: "command-call", toolName: "bash", input,
        inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
        executionMode: "background", traceKind: "tool", childHasOwnViewport: false, modelRequestId: "request",
      },
    })
    facts.dispose()

    await composition.supervisor.terminateBackgroundWork(parentId, "command-call")

    expect(reads).toEqual([])
    expect(callResults(ctx, parentId, "command-call")).toEqual([])
    expect(composition.workflows._abortCalls).toEqual([])
  })
})
