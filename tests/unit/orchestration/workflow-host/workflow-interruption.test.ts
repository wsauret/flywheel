import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { Agent, AgentOptions, AgentRunResult } from "../../../../src/orchestration/agent-runtime/types.js"
import type { SessionInputProducer } from "../../../../src/infra/chat-input.js"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback.js"
import { publishWorkerAttempt, commitWorkflowEvent } from "./_workflow-host-fixtures"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import type { AttemptRow } from "../../../../src/workflows/view/types.js"
import { testAuth } from "../chat/_chat-session-agent-runtime-fixtures"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { ManagedRuntime, Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { EventReaderService, EventStoreLive, EventStoreService } from "../../../../src/infra/event-store-effect.js"
import { liveWorkflowControl, messageDisposition, type LiveRecipientState } from "../../../../src/orchestration/session/live-session-control.js"
import type { ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { readWorkflowAgentTurnEnds, resumableAgentTurnEnd, workflowSessionActions } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { createWorkflowRunner } from "../../../../src/orchestration/workflow-host/runner.js"
import { definition, fixtureSkills, workflow } from "../../workflows/vm/host-test-support"
import { recoverWorkflowControl } from "../../../../src/workflows/vm/recovery"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js"
import { cleanupProjectRoots, createCapabilities, makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"
import { capabilityAccessFor, type CapabilityAccess } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { holdQueuedUserInput, readWorkflowQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { WHOLE_WORKFLOW } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"
import { MODULE_IDS, moduleDisabledReason } from "../../../../src/protocol/module-ids.js"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { newTestRunner } from "../../../helpers/agent-runner"
import { asModelClient } from "../agent-runtime/_model-client"

afterEach(cleanupProjectRoots)

/** A run of the fixture workflow whose step's worker streams from
 *  `streamWithTools`, or is `stepAgent` when one is given, over a store under
 *  `root`, with the system messages its step shows and the person's messages
 *  it shows as queued, and the step each names (`placed`). The run settles on `capabilityAccess` when a test
 *  admits it under a policy. With `parentSessionId`, a parent chat launched
 *  the workflow, and the runner reads that binding from the session manager. */
async function fixtureWorkflowRun(root: string, streamWithTools: (options: StreamOptions) => AsyncGenerator<ProviderStreamEvent>, capabilityAccess?: CapabilityAccess, stepAgent?: (options: AgentOptions) => Agent, parentSessionId?: string, reenter: boolean | "later_phase" = false) {
  const selectedWorkflow = reenter === "later_phase"
    ? Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ ...workflow, phases: [...workflow.phases, { phase: "again", runs: "work" }] })
    : workflow
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(root)))
  const store = await runtime.runPromise(EventStoreService)
  const base = makeWorkflowDeps()
  const definitionRevision = {
    ...base.definitions.captureRevision(), skills: fixtureSkills,
  }
  const manager = createSessionManager({ projectRoot: root, executionCwd: root, projectionReader: store, writer: store })
  const parentId = parentSessionId ?? "parent"
  await manager.createChat({ id: parentId, conversationId: `${parentId}-conversation`, name: "Parent" })
  const prepared = await prepareWorkflowLaunch({ workflow: selectedWorkflow, description: "task", deps: base, authProfileId: "default", projectRoot: root, definitionRevision })
  await manager.publishWorkflow({
    id: "session", workflowDefinitionId: selectedWorkflow.id, description: "task",
    initialRoles: { chat: { model: "gpt-5.5", effort: "medium" }, "workflow-agent": { model: "gpt-5.4", effort: "medium" }, "title-generation": { model: "gpt-6-luna", effort: "low" } },
    launchedFrom: { parentSessionId: parentId, conversationId: `${parentId}-conversation`, toolUseId: "launch" },
    facts: prepared.workflowFacts,
  })
  if (reenter) {
    const deps = { manager, projectionReader: store }
    await commitWorkflowEvent(deps, "session", selectedWorkflow, { type: "START" })
    const attempts = async () => {
      const recovered = recoverWorkflowControl((await store.readSlice({ aggregateId: "workflow:session" }, true)).facts)
      if (!recovered.executable) throw new Error("Expected executable workflow")
      return recovered.control.attempts
    }
    let attemptId = (await attempts())[0]!.id
    if (reenter === "later_phase") {
      await commitWorkflowEvent(deps, "session", selectedWorkflow, { type: "ATTEMPT_STARTED", attemptId, conversationId: "source-step" })
      await commitWorkflowEvent(deps, "session", selectedWorkflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: "source-step", handoff: { summary: "source done" }, reassessment: null } })
      attemptId = (await attempts()).at(-1)!.id
    }
    await commitWorkflowEvent(deps, "session", selectedWorkflow, { type: "ATTEMPT_STARTED", attemptId, conversationId: "reentered-step" })
    await commitWorkflowEvent(deps, "session", selectedWorkflow, { type: "ABORT", reason: "replacement" })
  }
  const shown: string[] = [], injected: unknown[] = [], placed: { readonly text: string; readonly runId?: string }[] = []
  const runner = createWorkflowRunner({
    sessionId: "session", workflow: selectedWorkflow, description: "task", startMode: reenter ? "operator_resume" : "launch", projectRoot: root, executionCwd: root, runtime, projectionReader: store,
    manager,
    attachChildProjection: async ({ sessionId }) => {
      const session = await manager.read(sessionId)
      if (session?.kind !== "workflow-agent" || session.workflowMembership.kind !== "attempt") throw new Error("Expected agent member")
      const runId = session.workflowMembership.attemptId
      return {
        onEvent: event => {
          if (event.type === "agent.system_message.recorded") shown.push(event.data.message)
          if (event.type === "agent.message.injected") {
            injected.push(event.data)
            placed.push({ text: event.data.message, runId })
          }
        },
        queueUserMessage: input => {
          injected.push({ message: input.text, origin: "user", pending: true, ...(input.submissionIds ? { submissionIds: input.submissionIds } : {}), ...(input.dispatchIds ? { dispatchIds: input.dispatchIds } : {}) })
          placed.push({ text: input.text, runId })
        },
        lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {}, dispose: async () => {},
      }
    },
    workflowDeps: {
      ...base, definitionRevision, ...(capabilityAccess ? { capabilityAccess } : {}),
      createAgent: (options) => {
        if (options.purpose.kind !== "workflow-agent") return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }) }
        if (stepAgent) return stepAgent(options)
        return newTestRunner({ ...options, agentRegistry: new Map(), agentsMd: "" }, async () => asModelClient({
          accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
          promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          streamWithTools,
        }), undefined, base.captureProviderConnection)
      },
    },
    recall: noConversationRecall,
    onCoreCompleted: async () => ({ durable: true }),
  })
  return { runtime, store, runner, shown, injected, placed }
}

describe("workflow interruption ownership", () => {

  it.each(["assembled", "settled"] as const)("waits for a re-entering step's host until it is %s, and never waits for an inactive or unrelated step", async (ending) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-host-assembly-"))
    const ready = Promise.withResolvers<AgentOptions>()
    const done = Promise.withResolvers<AgentRunResult>()
    const { runtime, runner } = await fixtureWorkflowRun(root, async function* () {}, undefined, (options) => {
      ready.resolve(options)
      return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
    }, undefined, true)
    try {
      expect(await runner.prepare()).toBeNull()
      expect([await runner.stepModuleRuntimes("reentered-step"), runner.stepBackgroundTasks("reentered-step")]).toEqual([undefined, undefined])
      const running = runner.run()
      const modules = runner.stepModuleRuntimes("reentered-step")
      const options = await ready.promise
      expect(await runner.stepModuleRuntimes("unrelated")).toBeUndefined()
      if (ending === "assembled") await options.lifecycle.onRuntimeAssembled?.({ modules: NO_MODULE_RUNTIMES })
      else done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      expect([await modules, runner.stepBackgroundTasks("reentered-step")]).toEqual(ending === "assembled" ? [NO_MODULE_RUNTIMES, expect.any(Object)] : [undefined, undefined])
      done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await running
      expect([await runner.stepModuleRuntimes("reentered-step"), runner.stepBackgroundTasks("reentered-step")]).toEqual([undefined, undefined])
    } finally {
      done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("interrupts every step worker that runs at the same time without involving workflow control", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-worker-interrupt-"))
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))

    try {
      const emit = createEmit(new EventBus())
      const writer = asAsyncEventWriter(store)
      const { manager } = await publishWorkerAttempt({ projectRoot, reader: asAsyncEventReadSurface(store), writer, workflowId: "workflow-worker-interrupt", attemptId: "step-1", conversationId: "conversation-1", siblings: [{ attemptId: "step-2", conversationId: "conversation-2" }] })
      const runners: { readonly done: PromiseWithResolvers<AgentRunResult>; interrupts: number }[] = []
      const bothReady = Promise.withResolvers<void>()

      const controls = createWorkerCallback({
        ...makeWorkflowDeps(),
        skills: fixtureSkills, personas: new Map(),
        createAgent: () => {
          const runner = { done: Promise.withResolvers<AgentRunResult>(), interrupts: 0 }
          runners.push(runner)
          if (runners.length === 2) bothReady.resolve()
          return {
            send() {}, end() {}, abort() {},
            interruptGeneration() {
              runner.interrupts += 1
              return true
            },
            done: runner.done.promise,
          }
        },
        auth: testAuth, moduleSelection: composeFirstPartyModules(),
        proactiveCompactionThreshold: () => 270_000,
        resolveRoles: async () => new Map([["workflow-agent", { roleId: "workflow-agent", model: "test", effort: "high" }]]),
        emit, sessionId: "workflow-worker-interrupt", projectRoot, executionCwd: projectRoot,
        agentInputs: workflowAgentInputs(asAsyncEventReadSurface(store), "workflow-worker-interrupt").agentInputs,
        deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
        sessionEventWriter: createSessionFactWriter({ sessionId: "workflow-worker-interrupt", writer }),
        recall: noConversationRecall,
        eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
        eventWriter: asAsyncEventWriter(store),
        resolvedAgents: new Map([["test-step", { ...definition, stepId: "test-step", contentId: "test-step" }]]),
      })
      const step = (id: string): AttemptRow => ({ id, definitionId: "test-step", workflowDefinitionId: "test-workflow", name: "Test step", briefId: "test-step", status: "pending", writes: [], resumeRevertCount: 0 })

      const first = controls.worker(step("step-1"), "Do the work", "", undefined, "conversation-1")
      const second = controls.worker(step("step-2"), "Do the other work", "", undefined, "conversation-2")
      await bothReady.promise

      // The two workers start concurrently, so the order they register in is
      // not part of the contract.
      expect(controls.interruptWorkers("person").toSorted()).toEqual(["step-1", "step-2"])
      expect(runners.map(({ interrupts }) => interrupts)).toEqual([1, 1])

      for (const runner of runners) runner.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      await expect(Promise.all([first, second])).resolves.toMatchObject([{ output: "completed" }, { output: "completed" }])
      expect(controls.interruptWorkers("person")).toEqual([])
    } finally {
      store.close()
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("shows messages in each receiving agent's own view and emits no turn labels, which the agent's conversation renders", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-steer-identity-"))
    const streamed = Promise.withResolvers<void>()
    const { runtime, runner, injected, placed } = await fixtureWorkflowRun(root, async function* (options) {
      streamed.resolve()
      await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
    })
    const attemptId = "host-test:node:1:attempt:1"
    try {
      expect(await runner.prepare()).toBeNull()
      const running = runner.run().catch(() => undefined)
      await streamed.promise
      const control = liveWorkflowControl(runtime.runSync(EventReaderService), "session")
      if (!control) throw new Error("a running workflow is live")
      const outcome = await control.deliver(
        { text: "focus on tests", submissionIds: ["local-1"], dispatchIds: ["cell"] },
        (state) => messageDisposition({ state, origin: "human", hop: 0, self: false }),
      )
      expect(outcome).toEqual({ status: "delivered", startsTurn: false, confirmedSubmissionIds: ["local-1"] })
      expect(injected).toEqual([{ message: "focus on tests", origin: "user", pending: true, submissionIds: ["local-1"], dispatchIds: ["cell"] }])
      await control.deliver(
        { text: "and the docs", submissionIds: ["local-2"], dispatchIds: ["cell-2"] },
        (state) => messageDisposition({ state, origin: "human", hop: 0, self: false }),
        { addressedTo: [{ _tag: "agent", nodeId: "host-test:node:1", definitionId: "host-test" }], label: "step host-test" },
      )
      expect(await runner.interrupt("person")).toBe(true)
      await runner.resume()
      expect(placed).toEqual([
        { text: "focus on tests", runId: attemptId }, { text: "and the docs", runId: attemptId },
      ])
      await runner.abort("runtime")
      await running
    } finally {
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a person's message to the step they interrupted waits while a module the run requires is off, Resume refuses in the same words, and the message continues the step once the module is on", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-held-message-"))
    const selected = [...MODULE_IDS]
    const capabilities = createCapabilities(selected)
    const launch = await capabilities.admit({ operation: "the fixture workflow", required: ["workflows"] })
    if (!launch.ok) throw new Error(launch.reason)
    const streamed = Promise.withResolvers<void>()
    const continued = Promise.withResolvers<string>()
    let providerCalls = 0
    const { runtime, store, runner, shown } = await fixtureWorkflowRun(root, async function* (options) {
      providerCalls += 1
      if (providerCalls === 1) {
        streamed.resolve()
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      continued.resolve(JSON.stringify(options.messages))
      yield { kind: "text_delta", text: "on it", blockKey: "text" }
      yield { kind: "done", stopReason: "end_turn" }
    }, capabilityAccessFor(capabilities, launch.grant))
    const interrupted = Promise.withResolvers<void>()
    const stopWatching = store.onStored((facts) => {
      const entries = facts.flatMap((fact) => fact.type === "chat.entries.appended" && Array.isArray(fact.payload.entries) ? fact.payload.entries : [])
      if (entries.some((entry: { readonly id?: unknown }) => typeof entry.id === "string" && entry.id.startsWith("itb-paused-person-"))) interrupted.resolve()
    })
    try {
      expect(await runner.prepare()).toBeNull()
      const running = runner.run().catch(() => undefined)
      await streamed.promise
      expect(await runner.interrupt("person")).toBe(true)
      await interrupted.promise
      const control = liveWorkflowControl(runtime.runSync(EventReaderService), "session")
      if (!control) throw new Error("a running workflow is live")
      while (await control.state() !== "interrupted") await Bun.sleep(1)

      selected.splice(selected.indexOf("workflows"), 1)
      const message = { text: "focus on tests", submissionIds: ["local-1"] }
      const key = await holdQueuedUserInput(store, "session", { target: "workflow" }, message)
      if (key === null) throw new Error("the fixture store holds in-flight cells")
      const outcome = await control.deliver({ ...message, dispatchIds: [key] }, (state) => messageDisposition({ state, origin: "human", hop: 0, self: false }))

      const refusal = `resuming the ${workflow.id} workflow is unavailable: ${moduleDisabledReason(["workflows"])}`
      expect(outcome).toEqual({ status: "held", reason: "interrupted" })
      expect(shown.at(-1)).toBe(`${refusal}. Your message waits, and the agent continues with it once that module is on.`)
      expect(await runner.handBack()).toEqual({ kind: "refused", reason: refusal })
      await runner.continueHeldMessages()
      expect(providerCalls).toBe(1)
      expect((await readWorkflowQueuedUserInputs(store, "session")).map((cell) => cell.key)).toEqual([key])
      // The hand-back admits the modules its run was admitted for, never the
      // current definition's.
      expect(capabilities._requests.slice(1).map(({ required }) => required)).toEqual([["workflows"], ["workflows"], ["workflows"]])

      selected.push("workflows")
      await runner.continueHeldMessages()
      expect(await continued.promise).toContain("focus on tests")
      expect(providerCalls).toBe(2)
      await runner.abort("runtime")
      await running
    } finally {
      stopWatching()
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Workflow steps that wait on their background work read each other's
  // messages without a wake, so a chain between them ran until a run ended.
  it("a step parked on its background work gives its loop a peer's message at the hop limit as held, and its parent's message to read", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-parked-on-work-"))
    const parkedOnWork = { handoffWritten: false, turnCount: 1, activeBackgroundCount: 1, parkedOnBackgroundWork: true, waitRequested: false, userResumeRequired: false, park: "waiting_on_work" as const }
    const read: { readonly text: string; readonly held: boolean }[] = []
    const parked = Promise.withResolvers<void>()
    const readBoth = Promise.withResolvers<void>()
    const { runtime, runner } = await fixtureWorkflowRun(root, async function* () {}, undefined, (options) => {
      const runAbort = new AbortController()
      const done = Promise.withResolvers<AgentRunResult>()
      const park = async (): Promise<void> => {
        for (;;) {
          await options.lifecycle?.onTurnParked?.(parkedOnWork)
          parked.resolve()
          const input = await options.lifecycle?.inputSource?.prepareWaitForInput?.(runAbort.signal).commit()
          if (!input) return
          if (input.kind === "message") read.push({ text: input.text, held: input.held === true })
          if (read.length === 2) readBoth.resolve()
        }
      }
      // The workflow's abort reaches the step through its run signal.
      const stop = (): void => {
        runAbort.abort()
        done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      }
      options.lifecycle?.signal?.addEventListener("abort", stop, { once: true })
      return { done: done.promise, send() { void park().catch(() => {}) }, end() {}, abort: stop }
    }, undefined, "later_phase")
    expect(await runner.prepare()).toBeNull()
    const running = runner.run().catch(() => undefined)
    try {
      await parked.promise
      const control = liveWorkflowControl(runtime.runSync(EventReaderService), "session")
      if (!control) throw new Error("a running workflow is live")
      expect(await control.state()).toBe("waiting_on_work")
      const peer: SessionInputProducer = { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "call-1", hop: 5, envelope: { name: "Peer", relation: "other", waits: false } }
      const fromParent: SessionInputProducer = { ...peer, sessionId: "parent", conversationId: "parent-conversation", hop: 9, envelope: { name: "Parent", relation: "parent", waits: false } }
      const decideFor = (producer: SessionInputProducer) => (state: LiveRecipientState) => messageDisposition({ state, origin: "session", hop: producer.hop, self: false, ...(producer.envelope ? { relation: producer.envelope.relation } : {}) })
      expect(await control.deliver({ text: "is your part done?", producer: peer, dispatchIds: ["msg:peer:call-1"] }, decideFor(peer), WHOLE_WORKFLOW)).toEqual({ status: "held", reason: "wake_limit" })
      expect(await control.deliver({ text: "use the new schema", producer: fromParent, dispatchIds: ["msg:parent:call-1"] }, decideFor(fromParent), WHOLE_WORKFLOW)).toEqual({ status: "delivered", startsTurn: false })
      await readBoth.promise
      expect(read).toEqual([{ text: "is your part done?", held: true }, { text: "use the new schema", held: false }])
    } finally {
      await runner.abort("runtime")
      await running
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The parent's message continues the step that the parent interrupted, as
  // its Resume does, and waits behind a person's interrupt: the person's
  // latest decision wins.
  it("hands back the agent of a later phase on its parent's message and holds a message behind a person's interrupt until authorized Resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-parent-hand-back-"))
    const streaming: PromiseWithResolvers<void>[] = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const continued = Promise.withResolvers<string>()
    const resumed = Promise.withResolvers<string>()
    let providerCalls = 0
    const { runtime, store, runner } = await fixtureWorkflowRun(root, async function* (options) {
      providerCalls += 1
      if (providerCalls === 2) continued.resolve(JSON.stringify(options.messages))
      if (providerCalls === 3) resumed.resolve(JSON.stringify(options.messages))
      yield { kind: "text_delta", text: "working", blockKey: "text" }
      streaming[providerCalls - 1]?.resolve()
      // A provider stream ends when its request is aborted.
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    }, undefined, undefined, "parent", "later_phase")
    const parentMessage = async (toolUseId: string, text: string) => {
      const control = liveWorkflowControl(runtime.runSync(EventReaderService), "session")
      if (!control) throw new Error("a running workflow is live")
      while (await control.state() !== "interrupted") await Bun.sleep(1)
      const message = { text, producer: { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId, hop: 0 } }
      const key = await holdQueuedUserInput(store, "session", { target: "workflow" }, message)
      if (key === null) throw new Error("the fixture store holds in-flight cells")
      return control.deliver({ ...message, dispatchIds: [key] }, (state) => messageDisposition({ state, origin: "session", hop: 0, self: false, relation: "parent" }), WHOLE_WORKFLOW)
    }
    try {
      expect(await runner.prepare()).toBeNull()
      const running = runner.run().catch(() => undefined)
      await streaming[0]!.promise
      expect(await runner.interrupt("agent")).toBe(true)
      expect(await parentMessage("message-1", "Also cover the tests.")).toEqual({ status: "delivered", startsTurn: false })
      expect(await continued.promise).toContain("Also cover the tests.")

      await streaming[1]!.promise
      expect(await runner.interrupt("person")).toBe(true)
      expect(await parentMessage("message-2", "Check the docs too.")).toEqual({ status: "held", reason: "interrupted" })
      expect(providerCalls).toBe(2)
      expect(await runner.handBack()).toEqual({ kind: "continued" })
      expect(await resumed.promise).toContain("Check the docs too.")
      expect(providerCalls).toBe(3)
      await runner.abort("runtime")
      await running
    } finally {
      await runner.abort("runtime")
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps an unrelated step parked when a person messages another lane, and retains person authority over pending sibling coverage", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-addressed-hand-back-"))
    const streaming: PromiseWithResolvers<void>[] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const continued = Promise.withResolvers<string>()
    let providerCalls = 0
    const { runtime, runner, injected } = await fixtureWorkflowRun(root, async function* (options) {
      providerCalls += 1
      if (providerCalls === 2) continued.resolve(JSON.stringify(options.messages))
      yield { kind: "text_delta", text: "working", blockKey: "text" }
      streaming[providerCalls - 1]?.resolve()
      await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
    }, undefined, undefined, "parent")
    const otherLane = { addressedTo: [{ _tag: "item" as const, listNodeId: "map", itemNodeId: "map:branch:3", key: "t3" }] as const, leafIds: ["map:branch:3:stage:1"], label: "lane t3" }
    const interrupted = async () => {
      const control = liveWorkflowControl(runtime.runSync(EventReaderService), "session")
      if (!control) throw new Error("a running workflow is live")
      while (await control.state() !== "interrupted") await Bun.sleep(1)
      return control
    }
    try {
      expect(await runner.prepare()).toBeNull()
      const running = runner.run().catch(() => undefined)
      await streaming[0]!.promise
      expect(await runner.interrupt("person")).toBe(true)
      const person = await (await interrupted()).deliver(
        { text: "Lane t3 keeps the old flag names.", submissionIds: ["local-1"], dispatchIds: ["cell-1"] },
        (state) => messageDisposition({ state, origin: "human", hop: 0, self: false }),
        otherLane,
      )
      expect(person).toEqual({ status: "delivered", startsTurn: false })
      expect(providerCalls).toBe(1)
      // A workflow has no transcript: the message shows in the view of the
      // agent that reads it, when that agent starts.
      expect(injected).not.toContainEqual(expect.objectContaining({ message: "Lane t3 keeps the old flag names." }))

      const parent = await (await interrupted()).deliver(
        { text: "Lane t3 checks the docs too.", dispatchIds: ["msg:parent:message-1"], producer: { kind: "session", sessionId: "parent", conversationId: "parent-conversation", toolUseId: "message-1", hop: 0 } },
        (state) => messageDisposition({ state, origin: "session", hop: 0, self: false, relation: "parent" }),
        WHOLE_WORKFLOW,
      )
      expect(parent).toEqual({ status: "held", reason: "interrupted" })
      expect(providerCalls).toBe(1)
      await runner.abort("runtime")
      await running
    } finally {
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("carries a person's interrupt that lands before the step's worker starts into that worker: its first turn opens interrupted and records the person's turn end", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-early-interrupt-"))
    let providerCalls = 0
    const { runtime, store, runner } = await fixtureWorkflowRun(root, async function* () {
      providerCalls += 1
      yield { kind: "text_delta", text: "working", blockKey: "text" }
      yield { kind: "done", stopReason: "end_turn" }
    })
    const recorded = Promise.withResolvers<void>()
    const stopWatching = store.onStored((facts) => {
      const entries = facts.flatMap((fact) => fact.type === "chat.entries.appended" && Array.isArray(fact.payload.entries) ? fact.payload.entries : [])
      if (entries.some((entry: { readonly id?: unknown }) => typeof entry.id === "string" && entry.id.startsWith("itb-paused-person-"))) recorded.resolve()
    })
    try {
      // The run has begun, as a Resume's dispatch begins it, and no worker
      // has a generation yet when the person's Escape lands.
      const running = runner.run()
      expect(await runner.interrupt("person")).toBe(true)

      await recorded.promise
      expect(resumableAgentTurnEnd(await readWorkflowAgentTurnEnds(store, "session"))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(providerCalls).toBe(0)
      await runner.abort("runtime")
      await running.catch(() => undefined)
    } finally {
      stopWatching()
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A step that the person interrupted parks for their Resume. A /compact
  // there runs at once, as a chat's does, and its reset carries the person's
  // turn end: the step still reads as paused by the person and admits Resume.
  it("a compaction of a step that the person interrupted runs at once and keeps the person's turn end, so the step still admits Resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-interrupt-compact-"))
    const streamed = Promise.withResolvers<void>()
    let providerCalls = 0
    const { runtime, store, runner } = await fixtureWorkflowRun(root, async function* (options) {
      providerCalls += 1
      yield { kind: "text_delta", text: "working", blockKey: "text" }
      if (providerCalls === 1) {
        streamed.resolve()
        // A provider stream ends when its request is aborted.
        await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return
      }
      yield { kind: "done", stopReason: "end_turn" }
    })
    const interrupted = Promise.withResolvers<void>()
    const reset = Promise.withResolvers<void>()
    const stopWatching = store.onStored((facts) => {
      const entries = facts.flatMap((fact) => fact.type === "chat.entries.appended" && Array.isArray(fact.payload.entries) ? fact.payload.entries : [])
      if (entries.some((entry: { readonly id?: unknown }) => typeof entry.id === "string" && entry.id.startsWith("itb-paused-person-"))) interrupted.resolve()
      if (entries.some((entry: { readonly kind?: unknown }) => entry.kind === "compaction")) reset.resolve()
    })
    try {
      const running = runner.run()
      await streamed.promise
      expect(await runner.interrupt("person")).toBe(true)
      await interrupted.promise

      expect(await runner.compact()).toBe(true)
      await reset.promise
      expect(providerCalls).toBe(2)
      const stepTurnEnd = resumableAgentTurnEnd(await readWorkflowAgentTurnEnds(store, "session"))
      expect(stepTurnEnd?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(workflowSessionActions("active", "running", { stepTurnEnd })).toContain("workflow.resume")
      await runner.abort("runtime")
      await running.catch(() => undefined)
    } finally {
      stopWatching()
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(["has parked at rest", "still unwinds"] as const)("a person's interrupt of the step a planned replacement's cut ended, while the cut step %s, is recorded through the step's own writer as the last turn end, and the step shows it", async (moment) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-worker-planned-cut-interrupt-"))
    const requested = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const unwind = Promise.withResolvers<void>()
    // The step's request streams until the cut aborts it, and its stream then
    // ends only once `unwind` resolves, as a provider stream takes time to end.
    const { runtime, store, runner, shown } = await fixtureWorkflowRun(root, async function* (options) {
      requested.resolve()
      yield { kind: "text_delta", text: "working", blockKey: "text" }
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        options.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      aborted.resolve()
      await unwind.promise
    })
    try {
      const running = runner.run()
      await requested.promise
      const cut = runner.interruptForReplacement()
      await aborted.promise
      if (moment === "has parked at rest") {
        unwind.resolve()
        expect(await cut).toBe(true)
        expect(resumableAgentTurnEnd(await readWorkflowAgentTurnEnds(store, "session"))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
      }

      expect(await runner.interruptPlannedCut("person")).toBe("recorded")
      unwind.resolve()
      expect(await cut).toBe(true)

      expect(resumableAgentTurnEnd(await readWorkflowAgentTurnEnds(store, "session"))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(shown).toEqual(["Interrupted"])
      await runner.abort("runtime")
      await running.catch(() => undefined)
    } finally {
      unwind.resolve()
      await runner.dispose()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

})
