import { Effect, Exit, Scope } from "effect"
import { createEmit, EventBus, type EmitFn } from "../../infra/event-bus.js"
import { EventReaderService, EventStoreWriterService } from "../../infra/event-store-effect.js"
import { Log } from "../../infra/log.js"
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js"
import { DEFAULT_BUDGET, toBudgetLimits } from "../../workflows/budget.js"
import { interruptedTurnEnd, isRuntimeInterruption, type ControlInterruption, type PlannedCutInterrupt, type TurnInterruption, type WorkflowInterruption } from "../session/conversation/turn-end-record.js"
import { readWorkflowAgentTurnEnds } from "../session/chat-session-run-evidence.js"
import { startedAgents } from "../../workflows/vm/host-commit-controller.js"
import { parentMayContinue, strongestInterrupt, workflowStepCut, type ChildCut } from "../session/child-continuation.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import type { WorkflowVmHost } from "../../workflows/vm/host-types.js"
import { TITLE_GENERATION_ROLE_ID } from "../config/roles.js"
import { createWorkflowHost } from "./factory.js"
import { acquireSessionResources, type SessionResources } from "../session/session-resources-service.js"
import { repairInterruptedToolExecutions } from "../session/tool-execution-store.js"
import { loadAgentInputProjection } from "../session/agent-input-projection.js"
import { reconcilePendingFileMutations } from "../session/file-mutation-recovery.js"
import type { WorkflowRunnerFactoryOptions } from "./host-collection.js"
import { generateSessionTitle, type SessionTitleGeneration } from "../session/session-title.js"
import { treeRootSessionIdOf } from "../session/session-messaging.js"
import { automaticWake, type WorkflowHandBack, type WorkflowResult, type WorkflowRunner } from "./runner-types.js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import { errorMessage } from "../../infra/error-message.js"
import { messageSenderOf } from "../../infra/output-blocks.js"
import { notifyLiveWorkChanged, registerLiveWorkflowControl, type DeliveryOutcome, type LiveWorkflowControl } from "../session/live-session-control.js"
import { retireAddressedWorkflowMessages, WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import { addressReachesStartedAgent, workflowInterruptRefusal } from "./workflow-addressing.js"
import { dropQueuedUserInput, readWorkflowQueuedUserInputs } from "../session/conversation/queued-user-inputs.js"
import type { CapabilityAdmission } from "../config/module-policy.js"
import { createWorkflowAgentInputs } from "./agent-inputs.js"
import { nextRunCut, type WorkflowRunCut } from "./run-record.js"
import { workflowRunReader, workflowRunOwner } from "../module-catalog.js"
import { readWorkflowUsage } from "./member-totals.js"
import { workflowMembershipReader } from "../session/workflow-membership.js"

const log = Log.create({ service: "workflow-runner" })

/** The reason an abort records, which each interrupted attempt carries. */
const ABORT_REASONS = {
  person: "Workflow stopped by a person",
  agent: "Workflow stopped by its parent agent",
  runtime: "Workflow paused because the runtime stopped",
  replacement: "Workflow paused for a runtime replacement",
} as const satisfies { readonly [cause in WorkflowInterruption]: string }

export function createWorkflowRunner(opts: WorkflowRunnerFactoryOptions): WorkflowRunner {
  const { sessionId, description, projectRoot, executionCwd, workflowDeps: deps } = opts
  const eventBus = new EventBus()
  const emit = createEmit(eventBus)
  const resourceScope = Scope.makeUnsafe("sequential")
  const eventStore = opts.runtime.runSync(EventReaderService)
  const eventWriter = opts.runtime.runSync(EventStoreWriterService)
  let resources: SessionResources | null = null
  const agentInputs = createWorkflowAgentInputs({
    store: opts.projectionReader, sessionId, wake: opts.wake, restore: opts.startMode !== "launch",
    onChange: () => { publishInterruption(); notifyLiveWorkChanged(opts.projectionReader) },
    runningAgents: () => {
      const started = startedAgents(committedQueue)
      const ids = new Set(started.map(({ agent }) => agent.id))
      const groups = new Set(committedQueue?.tree.nodes.flatMap(agent => agent.kind === "agent" && ids.has(agent.id) ? [agent.parentId] : []))
      return committedQueue?.tree.nodes.flatMap(agent => agent.kind === "agent" && groups.has(agent.parentId)
        && agent.disposition !== "completed" && agent.disposition !== "failed" && agent.disposition !== "skipped" ? [agent] : []) ?? []
    },
  })
  // The one live-runtime binding: null before ensureHost and after dispose.
  // Host, worker interruption, and background-work control are read through it.
  let createdRuntime: ReturnType<typeof createWorkflowHost> | null = null
  let hostCreation: Promise<ReturnType<typeof createWorkflowHost>> | null = null
  let disposePromise: Promise<void> | null = null
  let runSettled: Promise<void> | null = null
  const completionAcknowledged = Promise.withResolvers<void>()
  let terminalSequence: number | undefined
  // Whether the run is live: from `run()` until it settles.
  let running = false
  let committedQueue: WorkflowView | undefined
  let publishedInterruption: ControlInterruption | undefined
  function interruption(): ControlInterruption | undefined {
    const started = startedAgents(committedQueue)
    if (started.length === 0) return agentInputs.state === "interrupted" ? agentInputs.pendingControl() : undefined
    const cuts = started.map(({ attemptId }) => {
      const live = agentInputs.evidence(attemptId)
      return live?.cut
    })
    if (cuts.some((attemptCut) => attemptCut === undefined)) return undefined
    return cuts.some((attemptCut) => attemptCut?.by === "person") ? "person" : cuts.some((attemptCut) => attemptCut?.by === "agent") ? "agent" : undefined
  }
  function publishInterruption(): void {
    const next = interruption()
    if (publishedInterruption === next) return
    publishedInterruption = next
    opts.onInterruptionChanged?.(sessionId)
  }

  async function cut(address = WHOLE_WORKFLOW): Promise<ChildCut | undefined> {
    const evidence = await readWorkflowAgentTurnEnds(opts.projectionReader, sessionId)
    const merged = evidence.map((attempt) => {
      const live = agentInputs.evidence(attempt.attemptId)
      const durable = attempt.turnEnd?.end.reason === "paused" ? { by: attempt.turnEnd.end.pausedBy, timestamp: attempt.timestamp } : undefined
      const effective = live === undefined ? strongestInterrupt([durable, agentInputs.effective(attempt.agent)]) : live.cut
      if (live === undefined && effective === undefined) return attempt
      return { ...attempt, turnEnd: effective === undefined ? undefined : { end: interruptedTurnEnd(effective.by), recorded: true } }
    })
    const result = workflowStepCut(merged, address)
    const pending = agentInputs.pendingCut(address)
    const strongest = strongestInterrupt([result?.kind === "interrupt" ? result : undefined, pending === undefined ? undefined : { kind: "interrupt" as const, by: interruptedTurnEnd(pending.by).pausedBy }])
    return strongest ?? result
  }
  let abortPromise: Promise<boolean> | null = null
  let titleGeneration: SessionTitleGeneration | null = null
  let runOutcome: "ok" | "error" | "interrupted" = "error"
  const hostRuntimeConfig = deps.captureRuntimeConfig()

  const readQueue = async (): Promise<WorkflowView> => {
    if (!createdRuntime) throw new Error("Workflow queue is unavailable before VM preflight")
    committedQueue = await createdRuntime.readQueue()
    publishInterruption()
    return committedQueue
  }

  const subscribeToAttemptEvents = (): void => {
    for (const type of ["workflow.attempt.started", "workflow.attempt.completed", "workflow.attempt.failed", "workflow.attempt.interrupted"] as const) eventBus.subscribeToType(type, async () => {
      await readQueue()
      notifyLiveWorkChanged(opts.projectionReader)
    }, { delivery: "direct", deliveryClass: "critical", label: "workflow-committed-attempt-projection" })
  }

  const applyNestedStoredFact = async (stored: Parameters<SessionResources["toolExecutionStore"]["applyStoredFact"]>[0]): Promise<void> => {
    // Hydrate before the fact crosses the infra boundary: nested-fact
    // projection reads payload text directly and must never see a
    // tool-content reference.
    const hydrated = hydrateToolContentFact(stored, await eventStore.contentFor([stored]))
    await resources?.toolExecutionStore.applyStoredFact(hydrated)
  }

  async function initializeHost(): Promise<ReturnType<typeof createWorkflowHost>> {
    const failures = await reconcilePendingFileMutations({ sessionId, store: opts.projectionReader, writer: eventWriter })
    for (const failure of failures) {
      log.error("file mutation recovery deferred", {
        sessionId,
        mutationId: failure.mutationId,
        path: failure.path,
        error: failure.message,
      })
    }
    const created = createWorkflowHost({
      deps,
      eventBus,
      sessionId,
      workflow: opts.workflow,
      description,
      startMode: opts.startMode,
      projectRoot,
      executionCwd,
      eventStore,
      projectionReader: opts.projectionReader,
      eventWriter,
      ...(opts.manager ? { manager: opts.manager } : {}),
      recall: opts.recall,
      attachChildProjection: opts.attachChildProjection,
      initializeInfra: () => {
        if (resources) return resources
        resources = opts.runtime.runSync(Scope.provide(resourceScope)(acquireSessionResources({
          sessionId,
          owner: { kind: "workflow", workflowId: sessionId },
          projectRoot,
          emitter: emit,
          eventBus,
          budgetLimits: toBudgetLimits(hostRuntimeConfig.budget ?? DEFAULT_BUDGET),
          projectionReader: opts.projectionReader,
        })))
        return resources
      },
      agentInputs,
      applyNestedStoredFact,
      onDefinitionAccepted: opts.onDefinitionAccepted,
      onPostPreflight: async () => {
        if (!resources) throw new Error("Workflow runtime infrastructure did not initialize")
        subscribeToAttemptEvents()
        const protectedToolUseIds = new Set(
          [...(await loadAgentInputProjection(opts.projectionReader, sessionId)).values()].map((interaction) => interaction.toolUseId),
        )
        await repairInterruptedToolExecutions(resources.toolExecutionStore, resources.sessionEventWriter, protectedToolUseIds)
        // A short title on the run record is its name: the one its launch
        // gave, or one generated before this run resumed.
        if ((await workflowRunReader(opts.projectionReader).read(sessionId))?.shortLabel !== undefined) return
        titleGeneration = generateSessionTitle(description, ({ full, short }) => {
          opts.onSessionName?.({ label: full, shortLabel: short })
        }, async () => ({
          ...(await created.resolveRoles()).get(TITLE_GENERATION_ROLE_ID),
          resolveRoles: created.resolveRoles,
          createRunner: deps.createAgent, auth: deps.auth, projectRoot, userDataRoot: deps.userDataRoot, accountHome: deps.accountHome,
          // The workflow's agents name their tree root through the session manager, so the title does too.
          ...(opts.manager ? { treeRootSessionId: await treeRootSessionIdOf(opts.manager, sessionId) } : {}),
        }), deps.headless)
      },
      lifecycle: {
        disposeRemaining: async () => {
          titleGeneration?.abort()
          await Effect.runPromise(Scope.close(resourceScope, runOutcome === "ok" ? Exit.void : Exit.fail(new Error("workflow failed"))))
        },
      },
    })
    createdRuntime = created
    return created
  }

  async function ensureHost(): Promise<ReturnType<typeof createWorkflowHost>> {
    if (createdRuntime) return createdRuntime
    hostCreation ??= initializeHost()
    return hostCreation
  }

  async function prepare(): Promise<Awaited<ReturnType<WorkflowVmHost["preflight"]>>> {
    const created = await ensureHost()
    const failure = await created.host.preflight()
    if (!failure) await readQueue()
    const recorded = await workflowRunReader(opts.projectionReader).readCut(sessionId)
    if (recorded && (opts.startMode === "launch" || automaticWake(opts.wake))) {
      if (startedAgents(committedQueue).length === 0) agentInputs.interrupt(WHOLE_WORKFLOW, recorded.by)
    }
    else if (recorded) await recordWholeCut(null)
    return failure
  }

  function run(): Promise<WorkflowResult> {
    const unregisterControl = registerLiveWorkflowControl(eventStore, {
      workflowId: sessionId,
      kind: "workflow",
      handBackMember: async (continueMember) => {
        if (await handBackRefusal()) return undefined
        if (!continueMember()) return false
        await recordWholeCut(null)
        return true
      },
      memberHost: async (conversationId) => {
        const modules = await stepModuleRuntimes(conversationId)
        return modules ? { modules, backgroundTasks: createdRuntime?.workerBackgroundTasks(conversationId) } : undefined
      },
      // A sweep reads committed control after the terminal commit, and later
      // facts on the aggregate, such as a learning review's, raise the
      // position it reads. An acknowledgement of an earlier revision, such as
      // a start failure before a Resume, stays below the terminal commit.
      acknowledgeCompletion: (sequence) => { if (terminalSequence !== undefined && sequence >= terminalSequence) completionAcknowledged.resolve() },
      state: async () => agentInputs.state,
      workProgress: async () => {
        const queue = createdRuntime ? await readQueue() : committedQueue
        const members = await workflowMembershipReader(opts.projectionReader).list(sessionId)
        return {
          runnable: createdRuntime?.host.hasRunnableWork() ?? true,
          members: startedAgents(queue).flatMap(({ attemptId, conversationId }) => {
            const member = members.find((candidate) => candidate.conversationId === conversationId)
            return member ? [{
              sessionId: member.sessionId, conversationId,
              state: agentInputs.stateOf(attemptId),
              tasks: createdRuntime?.workerBackgroundTasks(conversationId),
            }] : []
          }),
        }
      },
      deliver: (input, decide, address) => deliverHeldMessage(input, decide, address),
      // A notice reaches the agent that runs now; with no agent running it
      // stays held, and the next agent adopts it.
      notify: async (notification) => agentInputs.notify(notification),
    })
    const promise = Log.runWithSession(sessionId, async () => {
      const created = await ensureHost()
      const runtimeInfra = resources
      if (!runtimeInfra) throw new Error("Workflow runtime infrastructure did not initialize")
      const hostResult = await created.host.run()
      if (abortPromise) await abortPromise
      const { display } = await readWorkflowUsage(opts.projectionReader, sessionId)
      const coreResult = workflowResult(hostResult, display.totalCost, display.totalInputTokens + display.totalOutputTokens)
      const terminal = hostResult.view?.status === "completed" || hostResult.view?.status === "failed"
      if (terminal) terminalSequence = hostResult.controlSeq
      try {
        const acknowledgement = await opts.onCoreCompleted?.(coreResult)
        if (!opts.onCoreCompleted || acknowledgement?.durable) completionAcknowledged.resolve()
      } catch (error) {
        if (!terminal) throw error
        log.warn("workflow parent completion reconciliation deferred", { sessionId, error: errorMessage(error) })
      }
      if (terminal) await completionAcknowledged.promise
      runOutcome = abortPromise ? "interrupted" : coreResult.completed ? "ok" : "error"
      return coreResult
    })
    running = true
    runSettled = promise.then(() => undefined, () => undefined).then(() => {
      running = false
      unregisterControl()
    })
    return promise
  }

  async function abort(cause: WorkflowInterruption): Promise<void> {
    await Log.runWithSession(sessionId, async () => {
      abortPromise ??= createdRuntime?.host.abort(ABORT_REASONS[cause]) ?? Promise.resolve(false)
      await abortPromise
      completionAcknowledged.resolve()
      await runSettled
    })
  }

  async function stepModuleRuntimes(conversationId: string) {
    if (!running || !runSettled) return undefined
    const ended = runSettled
    const created = await ensureHost()
    const queue = await created.readQueue()
    if (!running || !queue.attempts.some((attempt) => attempt.lastConversationId === conversationId && (attempt.status === "running" || attempt.status === "pending"))) return undefined
    const waiting = new AbortController()
    try {
      return await Promise.race([created.workerModules(conversationId, waiting.signal), ended.then(() => undefined)])
    } finally { waiting.abort() }
  }

  /** Cuts started attempts, retaining cuts for workers still assembling.
   * Whole Interrupt before any attempt starts carries into the first frontier.
   * Runtime cuts are never carried because the stop that follows ends the run. */
  function interruptTurns(by: TurnInterruption, address = WHOLE_WORKFLOW): readonly string[] | undefined {
    if (!running || abortPromise || disposePromise) return undefined
    if (workflowInterruptRefusal(address, startedAgents(committedQueue).map(({ agent }) => agent)) !== undefined) return undefined
    const cutAttempts = createdRuntime?.interruptWorkers(by, agentInputs.reached(address)) ?? []
    const pending = !isRuntimeInterruption(by) && agentInputs.interrupt(address, by)
    if (pending && cutAttempts.length === 0) log.info("an interrupt waits for the reached agents to start", { sessionId, by, addressKinds: address.addressedTo.map(({ _tag }) => _tag) })
    publishInterruption()
    return cutAttempts.length > 0 || pending ? cutAttempts : undefined
  }

  /** The emitter that shows a notice in the transcript of the agent of
   *  `attemptId`. A workflow has no transcript of its own, so what happens
   *  to an agent shows in that agent's view. */
  function emitToAgent(attemptId: string): EmitFn {
    return (type, input) => { createdRuntime?.emitToAgent(attemptId)?.(type, input) }
  }

  /** Says to each agent in `attemptIds` that `by` cut its turn. The agent's
   *  durable conversation renders the turn's label. */
  function showInterrupt(attemptIds: readonly string[]): void {
    for (const attemptId of attemptIds) emitToAgent(attemptId)("agent.turn.interrupted", { sessionId, data: {} })
  }

  /** Interrupts the agents that `address` reaches. A whole-run Interrupt
   *  records the run cut, which stops the run's time until a Resume or a
   *  hand-back clears it. Before any agent starts, the cut is recorded first,
   *  so the first frontier carries it; once agents run, only an Interrupt
   *  that cut them records it. */
  function interrupt(by: ControlInterruption, address = WHOLE_WORKFLOW): Promise<boolean> {
    return Log.runWithSession(sessionId, async () => {
      const whole = address.addressedTo.some(({ _tag }) => _tag === "workflow")
      const carried = whole && startedAgents(committedQueue).length === 0
      if (carried) await recordWholeCut({ by, timestamp: Date.now() })
      const cutAttempts = interruptTurns(by, address)
      if (cutAttempts === undefined) return false
      if (whole && !carried) await recordWholeCut({ by, timestamp: Date.now() })
      showInterrupt(cutAttempts)
      return true
    })
  }

  /** An interrupt by `by` of the agent that a planned replacement's cut
   *  ended (`PlannedCutInterrupt`): the agent's worker that holds the
   *  conversation records the turn end that names `by` through its own
   *  writer and shows it; `ended` when no worker holds it. */
  function interruptPlannedCut(by: ControlInterruption, address = WHOLE_WORKFLOW): Promise<PlannedCutInterrupt> {
    return Log.runWithSession(sessionId, async () => await (createdRuntime?.interruptPlannedCut(by, agentInputs.reached(address)) ?? "ended"))
  }

  /** A planned replacement's cut of the running agents: each parks and
   *  records its turn end as interrupted by the runtime, and the shutdown
   *  that follows pauses the workflow with each attempt's conversation kept,
   *  so the successor's Resume re-enters them and never restarts an attempt. */
  async function interruptForReplacement(): Promise<boolean> {
    const ended = runSettled
    const cutAttempts = Log.runWithSession(sessionId, () => interruptTurns("replacement"))
    if (cutAttempts === undefined) return false
    showInterrupt(cutAttempts)
    const parked = createdRuntime?.awaitWorkerParks(cutAttempts) ?? Promise.resolve()
    if (ended) await Promise.race([parked, ended])
    else await parked
    return true
  }

  /** Continues the agent a person interrupted inside its own attempt and
   *  conversation: the parked worker consumes the resume as its authorizing
   *  input, so the attempt never restarts (PI-INTERACTION-044). */
  function resume(address = WHOLE_WORKFLOW): Promise<boolean> {
    return Log.runWithSession(sessionId, async () => {
      if (!createdRuntime) return false
      await recordWholeCut(null)
      const pending = agentInputs.hasPending(address)
      const resumed = agentInputs.resume(address)
      return pending || resumed.length > 0
    })
  }

  function continueCapacity(conversationIds: ReadonlySet<string>): ReadonlySet<string> {
    return Log.runWithSession(sessionId, () => createdRuntime ? agentInputs.continueCapacity(conversationIds) : new Set<string>())
  }

  function terminateBackgroundWork(toolUseId: string): void {
    Log.runWithSession(sessionId, () => {
      createdRuntime?.terminateBackgroundWork(toolUseId)
    })
  }

  /** Why the person's hand-back of the agent they interrupted, their Resume
   *  or their message, cannot continue it now, or undefined when it can. The
   *  hand-back is new work (ARCH-WORKFLOWS-031). The run keeps the definition revision
   *  it captured, so the hand-back admits the modules that revision requires,
   *  which are the modules the run was admitted for. */
  async function handBackRefusal(): Promise<Extract<CapabilityAdmission, { ok: false }> | undefined> {
    const access = deps.capabilityAccess
    if (!access) return undefined
    const admission = await access.admit({ operation: `resuming the ${opts.workflow.id} workflow`, required: access.grant?.required ?? [] })
    if (admission.ok) return undefined
    log.info("workflow hand-back refused", { sessionId, kind: "module_disabled", missing: admission.missing })
    return admission
  }

  /** Hands the person's messages that wait in the workflow's cells, except
   *  the cells in `except`, to the agents they interrupted: a recovery's
   *  retained input, and each message whose address reaches an agent and that
   *  its conversation does not hold. The first message that a parked agent
   *  reads continues it, as a message the person sends does. A cell that an
   *  agent took already is not handed to it again. False when no message
   *  waits. */
  // A person's held message continues the parked agent, so the wake limit
  // never holds it.
  const PERSON_HAND_OVER = { status: "delivered", startsTurn: true } as const

  async function handOverHeldMessages(address = WHOLE_WORKFLOW, except: readonly string[] = []): Promise<boolean> {
    const retained = (await readWorkflowQueuedUserInputs(opts.projectionReader, sessionId))
      .map(({ key, text, attachments, invocation, submissionIds, producer }): ChatInput => ({ text, dispatchIds: [key], ...(attachments ? { attachments } : {}), ...(invocation ? { invocation } : {}), ...(submissionIds ? { submissionIds } : {}), ...(producer ? { producer } : {}) }))
    const handed = await agentInputs.handOver(retained, ({ producer, dispatchIds = [] }) => producer?.kind !== "session" && !dispatchIds.some((key) => except.includes(key)), PERSON_HAND_OVER, address)
    if (handed === 0) return false
    // A person's message continues the agents it reaches as a Resume does.
    await recordWholeCut(null)
    log.info("workflow held messages continued the agents", { sessionId, messages: handed })
    return true
  }

  async function handBack(address = WHOLE_WORKFLOW): Promise<WorkflowHandBack> {
    return Log.runWithSession(sessionId, async () => {
      const refusal = await handBackRefusal()
      if (refusal) return { kind: "refused" as const, reason: refusal.reason }
      // The cut that a person's message meets, so an agent that has not read
      // its durable cut yet takes the Resume as its slot's hand-back.
      if (createdRuntime === null || (await cut(address))?.kind !== "interrupt") return { kind: "not_parked" as const }
      await handOverHeldMessages(address)
      await resume(address)
      return { kind: "continued" as const }
    })
  }

  async function continueHeldMessages(): Promise<void> {
    await Log.runWithSession(sessionId, async () => {
      if (!createdRuntime || await handBackRefusal()) return
      await handOverHeldMessages()
      await createdRuntime.continueMemberMessages()
    }).catch((error: unknown) => {
      log.warn("workflow held messages could not continue the agents", { sessionId, error: errorMessage(error) })
    })
  }

  /** Takes one accepted message, already held in its workflow cell: the
   *  running agent reads it, and the next commit records it for every later
   *  agent that its address reaches. A message to the
   *  interrupted agent is a hand-back, as a Resume is, when it comes from a
   *  person, or from the parent agent while a person did not make the
   *  latest cut (`parentMayContinue`). A hand-back drops a carried
   *  interrupt and continues the agent once it passes the same module
   *  admission. While a module the run requires is off, the message waits
   *  in its cell, the agent stays interrupted, and the agent shows why. Any
   *  other message from a session waits behind the interrupt, and the wake
   *  limit holds it at an agent that answered its turn or waits on its
   *  background work. A message whose `address` does not reach the agent that
   *  runs now goes to `deliverElsewhere`. */
  async function deliverHeldMessage(input: Parameters<LiveWorkflowControl["deliver"]>[0], decide: Parameters<LiveWorkflowControl["deliver"]>[1], address?: WorkflowDeliveryAddress): Promise<DeliveryOutcome> {
    return Log.runWithSession(sessionId, async () => {
      const queue = createdRuntime ? await readQueue() : undefined
      if (queue?.status === "completed") return { status: "refused" as const, reason: "settled" as const }
      const fromPerson = input.producer?.kind !== "session"
      const reached = address ?? WHOLE_WORKFLOW
      const latest = await cut(reached)
      const interrupted = latest?.kind === "interrupt" || agentInputs.hasPending(reached)
      const state = interrupted ? "interrupted" : agentInputs.stateAt(reached)
      const handsBack = interrupted && (fromPerson || await parentHandsBack(input.producer, reached))
      if (address && !addressReachesStartedAgent(queue, address)) return deliverElsewhere(input, decide, address, interrupted, handsBack)
      const refusal = handsBack ? await handBackRefusal() : undefined
      const outcome = decide(refusal ? "interrupted" : handsBack ? "running" : state)
      if (outcome.status === "refused") return outcome
      if (refusal) {
        // The message keeps its address, so the agents it reaches show it
        // with why it waits.
        const held = agentInputs.reached(reached)
        showQueuedMessage(input, held)
        for (const attemptId of held) emitToAgent(attemptId)("agent.system_message.recorded", { sessionId, data: { message: heldMessageNotice(refusal) } })
        return outcome
      }
      // An admitted hand-back hands every message of the person that waits
      // first, so the agent reads them in the order they were sent.
      if (handsBack) await handOverHeldMessages(reached, input.dispatchIds)
      const taken = agentInputs.deliver(input, outcome, address)
      // Only a person's message or a Resume ends the park of an interrupted
      // agent, so the parent's hand-back continues the agents with a Resume
      // after its message, which each agent reads first. The Resume joins the
      // message synchronously, before the cut's record yields, so the
      // agent takes both together and none waits for its next park.
      if (handsBack) {
        agentInputs.resume(reached)
        await recordWholeCut(null)
      }
      showQueuedMessage(input, taken)
      // Each agent that took the message shows it in its own view, so the
      // sender's copy is confirmed.
      if (taken.length > 0) return { ...outcome, confirmedSubmissionIds: input.submissionIds }
      return outcome
    })
  }

  /** Takes one message whose address does not reach the agent that runs
   *  now: a message for items or agents that do not run now, or a message to
   *  the whole workflow while no agent runs. It waits in its addressed cell:
   *  the next commit records it, and each agent that its address reaches
   *  reads it when that agent starts, so the agent that runs now never reads
   *  it, and no state of that agent's loop decides a wake. It is still
   *  a message to the workflow, so it hands back the interrupted agent by the
   *  rule that every message follows; with no words for that agent, the
   *  hand-back is a Resume. A workflow has no transcript, so its words show
   *  in the view of each agent that reads it, when that agent starts. */
  async function deliverElsewhere(
    input: Parameters<LiveWorkflowControl["deliver"]>[0],
    decide: Parameters<LiveWorkflowControl["deliver"]>[1],
    address: WorkflowDeliveryAddress,
    interrupted: boolean,
    handsBack: boolean,
  ): Promise<DeliveryOutcome> {
    const refusal = handsBack ? await handBackRefusal() : undefined
    const outcome = decide(refusal !== undefined || (interrupted && !handsBack) ? "interrupted" : handsBack ? "running" : "between_steps")
    if (outcome.status === "refused") return outcome
    log.info("a message waits for the agents its address reaches", { sessionId, addressKinds: address.addressedTo.map(({ _tag }) => _tag), held: refusal !== undefined })
    if (handsBack && !refusal) {
      await handOverHeldMessages(address, input.dispatchIds)
      await resume(address)
    }
    return outcome
  }

  /** Whether a message from another session hands back the interrupted
   *  agent: only the workflow's parent's, and only while a person did not
   *  make the latest cut. */
  async function parentHandsBack(producer: Parameters<LiveWorkflowControl["deliver"]>[0]["producer"], address: WorkflowDeliveryAddress): Promise<boolean> {
    if (producer?.kind !== "session") return false
    const record = await workflowRunReader(opts.projectionReader).read(sessionId)
    if (record?.launchedFrom.parentSessionId !== producer.sessionId) return false
    const latest = await cut(address)
    return latest !== undefined && parentMayContinue(latest)
  }

  /** Shows a message that waits for its reader in the transcript of each
   *  agent in `attemptIds` that took it. */
  function showQueuedMessage({ text, submissionIds, dispatchIds, producer }: Parameters<LiveWorkflowControl["deliver"]>[0], attemptIds: readonly string[]): void {
    const from = messageSenderOf(producer)
    for (const attemptId of attemptIds) emitToAgent(attemptId)("agent.message.injected", { sessionId, data: { message: text, origin: "user", pending: true, ...(submissionIds?.length ? { submissionIds } : {}), ...(dispatchIds?.length ? { dispatchIds } : {}), ...(from ? { from } : {}) } })
  }

  function recallQueuedMessage(): Promise<ChatInputLike | null> {
    return Log.runWithSession(sessionId, async () => {
      const recalled = agentInputs.recallLastUserMessage(() => true)
      if (recalled === null) return null
      // The words go back into the editor, which is not durable state, so
      // the cells retire first: a later agent must not read what the person
      // took back. A message to the workflow waits in an addressed cell, and
      // a recovery's retained input in a queued one.
      const keys = recalled.dispatchIds ?? []
      await Promise.all([
        retireAddressedWorkflowMessages(eventWriter, sessionId, keys),
        ...keys.map((key) => dropQueuedUserInput(eventWriter, sessionId, key)),
      ])
      const { dispatchIds: _retired, ...bare } = recalled
      return bare
    })
  }

  async function compact(): Promise<boolean> {
    if (!createdRuntime) return false
    return agentInputs.compact()
  }

  async function recordWholeCut(next: WorkflowRunCut | null): Promise<void> {
    const current = await workflowRunReader(opts.projectionReader).readCut(sessionId)
    if (nextRunCut(current, next) === current) return
    await eventWriter.append(workflowRunOwner().cut(sessionId, next))
  }

  function dispose(): Promise<void> {
    disposePromise ??= Log.runWithSession(sessionId, async () => {
      const hostDisposal = await createdRuntime?.host.dispose()
      completionAcknowledged.resolve()
      await runSettled
      createdRuntime = null
      if (hostDisposal?.kind === "failed") throw new Error(hostDisposal.failure.message)
    })
    return disposePromise
  }

  return {
    handBack,
    continueHeldMessages,
    run,
    // A workflow has no transcript that a projection event could change:
    // each agent's view reads that agent's conversation.
    applyProjectionEvent: () => {},
    abort,
    interrupt,
    interruption,
    cut,
    interruptForReplacement,
    interruptPlannedCut,
    stepModuleRuntimes,
    stepBackgroundTasks: (conversationId) => running ? createdRuntime?.workerBackgroundTasks(conversationId) : undefined,
    resume,
    continueCapacity,
    releaseForegroundBash: (toolUseId) => createdRuntime?.releaseForegroundBash(toolUseId) ?? false,
    transferForegroundForReplacement: async () => { await createdRuntime?.transferForegroundForReplacement() },
    terminateBackgroundWork,
    recallQueuedMessage,
    compact,
    sessionId,
    prepare,
    readQueue,
    dispose,
  }
}

/** What an agent shows when it keeps a person's message behind a module that
 *  is off: the refusal a Resume reads, then what happens to the message. */
function heldMessageNotice({ reason, missing }: Extract<CapabilityAdmission, { ok: false }>): string {
  return `${reason.replace(/\.$/, "")}. Your message waits, and the agent continues with it once ${missing.length === 1 ? "that module is" : "those modules are"} on.`
}

function workflowResult(
  result: Awaited<ReturnType<WorkflowVmHost["run"]>>,
  cost: number,
  tokens: number,
): WorkflowResult {
  if (result.kind === "completed") {
    return { completed: true, attemptsCompleted: result.attemptsCompleted, attemptsTotal: result.attemptsTotal, cost, tokens }
  }
  if (result.kind === "paused") {
    return { completed: false, attemptsCompleted: result.attemptsCompleted, attemptsTotal: result.attemptsTotal, reason: result.reason, cost, tokens }
  }
  return {
    completed: false,
    attemptsCompleted: result.view?.attempts.filter(({ status }) => status === "completed").length ?? 0,
    attemptsTotal: result.view?.attempts.length ?? 0,
    reason: result.failure.message,
    cost,
    tokens,
  }
}
