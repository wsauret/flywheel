import { Effect } from "effect"
import { DebugLog } from "../../infra/debug-log.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { errorMessage } from "../../infra/error-message.js"
import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { WorkflowView } from "../view/types.js"
import { resolveWorkflowAgents } from "../agent-resolution.js"
import { attemptConversations } from "./attempt-conversations.js"
import type { AttemptRunOutcome } from "./attempt-runner.js"
import type { WorkflowTransitionResult } from "./commands.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import type { NewWorkflowProposalEvent } from "./events.js"
import { resumesFailedAgents, workflowInsertionRefusalReason } from "./fact-fold.js"
import {
  WorkflowAttemptRefusedError,
  WorkflowHostFollowUpError,
  WorkflowHostInterruptionError,
  WorkflowHostWorkerError,
  WorkflowMalformedStateError,
  type WorkflowVmHost,
  type WorkflowVmHostDeps,
  type WorkflowVmHostDisposeResult,
  type WorkflowVmHostFailure,
  type WorkflowVmHostRunResult,
} from "./host-types.js"
import { validateWorkflowBootstrap } from "./bootstrap-validation.js"
import { createWorkflowHostChildController, type WorkflowHostChildSettlement } from "./host-child-controller.js"
import { runningAttemptCount, waitingAttemptCount } from "./frontier.js"
import { createWorkflowHostCommitController } from "./host-commit-controller.js"
import { failureResult, lifecycleError, publicFailureCause, terminalResult, toPublicFailure } from "./host-failures.js"
import { disposeWorkflowHostLifecycle } from "./host-lifecycle.js"
import { createWorkflowRuntimePublisher } from "./host-publication.js"
import { continueWorkflowReplay } from "./replay.js"
import { parseWorkflowSessionFact, workflowAggregateId } from "./session-facts.js"
import { admissionCommand, nextWorkflowCommand, transitionDecodedWorkflow } from "./transition.js"

const COMMAND_QUANTUM = 8
const log = Log.create({ service: "workflow-vm-host" })

/** The one control the host queues from outside: the runtime teardown's
 *  ABORT. PAUSE reaches the machine only from the pre-attempt policy. */
type HostInput = Extract<NewWorkflowProposalEvent, {
  type: "ABORT"
}>

interface DrivenTransition {
  readonly event: NewWorkflowProposalEvent
  readonly result: WorkflowTransitionResult
}



/** The workflow's facts, of which none may be corrupt. */
function storedFacts(facts: readonly (StoredFact | CorruptEventRowError)[]): readonly StoredFact[] {
  return facts.map((fact) => {
    if (fact instanceof CorruptEventRowError) throw fact
    return fact
  })
}


/** Execute the pure workflow protocol while keeping durable facts as the only publication boundary. */
export function createWorkflowVmHost(deps: WorkflowVmHostDeps): WorkflowVmHost {
  const aggregateId = workflowAggregateId(deps.sessionId)
  const { workflow } = deps
  const resolvedAgents = resolveWorkflowAgents(workflow)
  // What each agent record reads and passes on, from the definitions the
  // run is pinned to, so a Resume reruns the finished readers of work that
  // runs again.
  const readers = Object.fromEntries([...resolvedAgents].map(([id, agent]) => [id, {
    reads: agent.reads.map(({ nodeId }) => nodeId),
    transient: agent.writes.some(({ lifetime }) => lifetime === "transient"),
  }]))
  const children = createWorkflowHostChildController<AttemptRunOutcome, WorkflowHostWorkerError>()
  const inputs: HostInput[] = []
  let current: DrivenTransition | null = null
  let activeRun: Promise<WorkflowVmHostRunResult> | null = null
  let disposePromise: Promise<WorkflowVmHostDisposeResult> | null = null
  let acceptingInputs = true
  let stopping = false
  let abortState: "idle" | "accepted" | "committed" = "idle"
  let lastPauseReason = "Workflow paused"
  const interruptedAttempts = new Map<string, { readonly attemptId: string; readonly agentName: string; readonly reason: string }>()
  // The proposals that pause the run, held in arrival order until no other
  // attempt runs. While one is held, admission starts nothing, and every
  // attempt in flight finishes and commits its result, so a pause loses no
  // settled work. Only an abort or a host
  // failure interrupts an attempt in flight.
  const stops: NewWorkflowProposalEvent[] = []
  // The attempts that the current admission decision started.
  let admitted = 0

  async function queue(): Promise<WorkflowView> {
    const value = await deps.queueStore.loadQueue()
    if (!value) throw lifecycleError("preflight", "Workflow queue projection requires queue.created")
    return value
  }

  async function applyStoredFacts(events: readonly StoredFact[]): Promise<void> {
    await deps.queueStore.applyStoredFact(events)
    await deps.contextStore.applyStoredFact(events)
  }

  const publisher = createWorkflowRuntimePublisher({
    emit: deps.emit,
    queue,
    setPauseReason: (reason) => { lastPauseReason = reason },
  })
  const commits = createWorkflowHostCommitController({ host: deps, resolvedAgents, publisher, queue, applyStoredFacts })

  async function commitTransition(transition: DrivenTransition): Promise<DrivenTransition> {
    const committed = await commits.commit(transition)
    if (transition.event.type === "ABORT" && committed.result.command.kind !== "commit") abortState = "committed"
    return committed
  }

  async function performPreflight(): Promise<void> {
    if (current) return
    const { facts } = await deps.reader.readSlice({ aggregateId }, true)
    const plan = validateWorkflowBootstrap(facts)
    if (!plan.executable) throw new WorkflowMalformedStateError({
      sessionId: deps.sessionId,
      message: `Workflow session ${deps.sessionId} has non-executable durable state: ${plan.reasons.map(({ kind }) => kind).join(", ")}`,
    })
    const replayed = plan.control
    // Refuse before the start event, because RESUME and RECOVER both commit
    // control: a refused Resume must leave a paused row paused.
    if (replayed.followUp?.pendingInput) throw refusedFollowUp(replayed.followUp)
    let event: NewWorkflowProposalEvent = deps.startMode === "launch" ? { type: "START" } : { type: "RESUME", readers }
    if (deps.startMode === "operator_resume" && replayed.status !== "paused" && !resumesFailedAgents(storedFacts(facts), replayed)) {
      // RESUME is legal from a paused lifecycle and from a run that ended on
      // the failure of an agent. Every other replayed status resumes as
      // RECOVER: a crashed run replays into a state that accepts it,
      // completed control ignores it, and other failed control settles as a
      // terminal run.
      event = await recoverEvent(storedFacts(facts), replayed, deps.servedConversations)
    }
    const result = await continueWorkflowReplay(replayed, event, deps)
    if (deps.startMode === "operator_resume") {
      const command = nextWorkflowCommand(result)
      if (command.kind === "prepare_attempt") {
        const reason = await deps.preAttemptPolicy?.(command.attempt)
        if (reason) throw new WorkflowAttemptRefusedError({ attemptId: command.attempt.attemptId, message: reason })
      }
    }
    await queue()
    try {
      await deps.onPostPreflight?.()
    } catch (error) {
      if (error instanceof WorkflowMalformedStateError) throw error
      throw lifecycleError("post_preflight", errorMessage(error))
    }
    current = { event, result }
    await publisher.emitInitialized()
  }


  async function prepareAttempt(transition: DrivenTransition): Promise<DrivenTransition> {
    const command = transition.result.command
    if (command.kind !== "prepare_attempt") throw lifecycleError("protocol", "Expected prepare_attempt command")
    const pauseReason = await deps.preAttemptPolicy?.(command.attempt)
    if (pauseReason) {
      // The refusal stops admission; the attempts in flight still finish.
      stops.push({ type: "PAUSE", reason: pauseReason })
      return { event: transition.event, result: { state: transition.result.state, command: { kind: "none" } } }
    }
    const conversationId = command.attempt.conversationId
      ?? deps.conversationId?.(command.attempt)
      ?? `agent-${crypto.randomUUID()}`
    return drive(transition.result, {
      type: "ATTEMPT_STARTED",
      attemptId: command.attempt.attemptId,
      conversationId,
    })
  }

  /** Fork the attempt that the last commit started, then ask admission for
   *  the next one, so every attempt that waits on no other starts before the
   *  host waits for any result. */
  function startAttempt(transition: DrivenTransition): DrivenTransition {
    const command = transition.result.command
    if (command.kind !== "run_attempts" || command.attempts.length !== 1) {
      throw lifecycleError("protocol", "Workflow host requires one started attempt per commit")
    }
    const input = command.attempts[0]
    if (!input) throw lifecycleError("protocol", "Workflow host received an empty attempt batch")
    const conversationId = requireConversationId(input)
    children.fork(
      input.attemptId,
      (signal) => deps.attemptRunner.run(input, {
        workflowSessionId: deps.sessionId,
        conversationId,
        signal,
        committedControl: () => {
          if (!current) throw lifecycleError("protocol", "Workflow host lost committed control during an attempt")
          return current.result.state.context.committed
        },
        conversationsOf: async (attemptId) => {
          if (!current) throw lifecycleError("protocol", "Workflow host lost committed control during an attempt")
          return attemptConversations(deps.reader, deps.sessionId, current.result.state.context.committed, attemptId)
        },
      }),
      (error) => error instanceof WorkflowHostWorkerError ? error : new WorkflowHostWorkerError({ attemptId: input.attemptId, message: errorMessage(error) }),
    )
    admitted += 1
    return { event: transition.event, result: { state: transition.result.state, command: admissionCommand(transition.result.state) } }
  }

  /** One record per admission decision, once admission starts no more. */
  function recordAdmission(): void {
    if (admitted === 0 || !current) return
    const control = current.result.state.context.committed
    DebugLog.record({
      type: "workflow.attempts.admitted",
      sessionId: deps.sessionId,
      payload: {
        admitted,
        running: runningAttemptCount(control),
        waiting: waitingAttemptCount(control),
        cap: control.guardrails.maxParallel ?? null,
      },
    })
    admitted = 0
  }

  /** Interrupt every child whose attempt committed control no longer runs:
   *  the siblings of an attempt whose result failed the run, and every
   *  attempt that an abort stopped. Their ends are discarded, and a Resume
   *  starts each again in its conversation. A pause never stops a child,
   *  because the host commits a pause only when no other child runs. */
  function interruptStoppedChildren(): void {
    if (!current) return
    const running = new Set(current.result.state.context.committed.attempts.flatMap(({ id, state }) => state._tag === "running" ? [id] : []))
    for (const attemptId of children.inFlight()) {
      if (!running.has(attemptId)) children.interrupt(attemptId)
    }
  }

  /** The transition that one child's end proposes, or null when the end
   *  changes nothing now: the host stops, an abort interrupted the attempt,
   *  committed control stopped the attempt before it ended, or the end
   *  pauses the run while other children run, so it waits in `stops`. */
  async function settleChild(end: WorkflowHostChildSettlement<AttemptRunOutcome, WorkflowHostWorkerError>): Promise<DrivenTransition | null> {
    if (stopping || !current) return null
    const attempt = current.result.state.context.committed.attempts.find(({ id }) => id === end.attemptId)
    if (end.kind !== "value") {
      if (abortState !== "idle") {
        const row = (await queue()).attempts.find(({ id }) => id === end.attemptId)
        if (!row) throw lifecycleError("projection", `Workflow view has no interrupted attempt "${end.attemptId}"`)
        interruptedAttempts.set(row.id, { attemptId: row.id, agentName: row.name, reason: lastPauseReason })
        return null
      }
      if (attempt?.state._tag !== "running") return null
      throw end.kind === "error" ? end.error : new WorkflowHostWorkerError({ attemptId: end.attemptId, message: "The attempt was interrupted" })
    }
    if (attempt?.state._tag !== "running") return null
    const outcome = end.value
    if (outcome.kind === "success") {
      return drive(current.result, {
        type: "ATTEMPT_SUCCEEDED",
        outcome: {
          attemptId: outcome.attemptId,
          conversationId: outcome.conversationId,
          handoff: outcome.handoff,
          reassessment: outcome.reassessment,
          ...(outcome.toolUses === undefined ? {} : { toolUses: outcome.toolUses }),
        },
      })
    }
    const failure: NewWorkflowProposalEvent = { type: "ATTEMPT_FAILED", failure: outcome }
    const proposed = drive(current.result, failure)
    if (children.inFlight().size > 0 && proposed.result.state.context.pending?.proposedCommitted.status === "paused") {
      stops.push(failure)
      return null
    }
    lastPauseReason = outcome.reason
    return proposed
  }

  /** The first held stop, proposed once no child runs. The first stop that
   *  commits pauses the run, which puts the attempt of every later held
   *  failure back to pending with its conversation, as an abort does, so a
   *  Resume runs each of them again. */
  function proposeHeldStop(transition: DrivenTransition): DrivenTransition {
    const stop = stops.shift()
    const { lifecycle } = transition.result.state
    if (!stop || (lifecycle !== "executing" && lifecycle !== "ready")) {
      stops.length = 0
      return transition
    }
    lastPauseReason = stop.type === "PAUSE" ? stop.reason : stop.type === "ATTEMPT_FAILED" ? stop.failure.reason : lastPauseReason
    return drive(transition.result, stop)
  }

  /** Follow-up input belongs to the parent chat (PI-INTERACTION-022). The startup
   *  migration moves what history left pending there, so control that still
   *  holds it is history the migration could not move. The workflow never
   *  runs it as its own turn: the run fails, writes nothing, and says where
   *  to continue. */
  function refusedFollowUp(followUp: { readonly conversationId: string; readonly requestSequence: number }): WorkflowHostFollowUpError {
    log.info("workflow refused historical follow-up input", { sessionId: deps.sessionId, conversationId: followUp.conversationId, requestSequence: followUp.requestSequence })
    return new WorkflowHostFollowUpError({
      conversationId: followUp.conversationId,
      message: "This workflow holds follow-up input from an earlier version of Flywheel. A workflow no longer runs follow-up turns of its own: continue in its parent chat.",
    })
  }

  async function loop(): Promise<WorkflowVmHostRunResult> {
    try {
      const preflightFailure = await preflight()
      if (preflightFailure) return failureResult(preflightFailure)
      let commandsSinceYield = 0
      while (current) {
        if (stopping) throw new WorkflowHostInterruptionError({ operation: "host", message: "Workflow host disposed" })
        const command = current.result.command
        if (command.kind !== "commit") {
          const input = inputs.shift()
          if (input) {
            current = drive(current.result, input)
            continue
          }
        }

        if (command.kind === "commit") {
          current = await commitTransition(current)
          interruptStoppedChildren()
        } else if (command.kind === "prepare_attempt" && stops.length === 0) current = await prepareAttempt(current)
        else if (command.kind === "run_attempts") current = startAttempt(current)
        else if (command.kind === "run_follow_up") {
          // Preflight refuses committed follow-up input, and no host input
          // requests a follow-up, so this command cannot arise in a run.
          throw lifecycleError("protocol", "Workflow host met follow-up input that preflight refuses")
        } else if (children.inFlight().size > 0) {
          // Every attempt that can start runs; wait for the first to end.
          recordAdmission()
          const next = await settleChild(await children.next())
          if (next) current = next
          continue
        } else if (stops.length > 0) {
          current = proposeHeldStop(current)
          continue
        } else {
          recordAdmission()
          return terminalResult(
            current.result,
            await queue(),
            lastPauseReason,
            current.result.state.lifecycle === "failed"
              ? workflowInsertionRefusalReason(storedFacts((await deps.reader.readSlice({ aggregateId })).facts))
              : undefined,
          )
        }

        commandsSinceYield += 1
        if (command.kind === "commit" || commandsSinceYield >= COMMAND_QUANTUM) {
          commandsSinceYield = 0
          await Effect.runPromise(Effect.yieldNow)
        }
      }
      throw lifecycleError("protocol", "Workflow host lost its machine transition")
    } catch (error) {
      // No result of an attempt in flight can commit any more, so none of
      // them may keep calling a provider or editing the project.
      children.interrupt()
      stops.length = 0
      return failureResult(toPublicFailure(error))
    }
  }

  async function preflight(): Promise<WorkflowVmHostFailure | null> {
    try {
      await performPreflight()
      return null
    } catch (error) {
      return toPublicFailure(error)
    }
  }

  function run(): Promise<WorkflowVmHostRunResult> {
    if (activeRun) return activeRun
    if (disposePromise) return Promise.resolve(failureResult({
      kind: "lifecycle",
      operation: "run",
      message: "Workflow host is disposed",
      failures: [],
    }))
    const promise = loop().finally(() => {
      if (activeRun === promise) activeRun = null
    })
    activeRun = promise
    return promise
  }

  async function drainAcceptedControls(): Promise<WorkflowVmHostRunResult> {
    let result = await (activeRun ?? run())
    if (abortState === "accepted" && result.kind !== "failed") result = await run()
    return result
  }

  async function abort(reason: string): Promise<boolean> {
    if (!acceptingInputs || abortState !== "idle") return false
    // Parent reconciliation can keep the runner live after the VM failed; a
    // completed VM still accepts ABORT from its completed wait.
    if (!activeRun && current?.result.state.lifecycle === "failed") return false
    lastPauseReason = reason
    abortState = "accepted"
    inputs.push({ type: "ABORT", reason })
    children.interrupt()
    const result = await drainAcceptedControls()
    if (result.kind === "failed") throw publicFailureCause(result.failure)
    if (abortState === "accepted") throw lifecycleError("abort", `Abort settled as ${result.kind} before its commit`)
    if (result.kind !== "paused") throw lifecycleError("abort", `Abort settled as ${result.kind}`)
    return true
  }

  async function disposeHost(): Promise<WorkflowVmHostDisposeResult> {
    acceptingInputs = false
    if (abortState === "accepted") {
      children.interrupt()
      await drainAcceptedControls()
    }
    stopping = true
    children.interrupt()
    const result = await disposeWorkflowHostLifecycle(
      deps.lifecycle,
      async () => {
        await children.settle()
        for (const interrupted of interruptedAttempts.values()) await deps.emit({ type: "workflow.attempt.interrupted", data: interrupted })
        interruptedAttempts.clear()
      },
      async () => { await activeRun },
    )
    await children.close()
    inputs.length = 0
    return result
  }

  function dispose(): Promise<WorkflowVmHostDisposeResult> {
    disposePromise ??= disposeHost()
    return disposePromise
  }

  function hasRunnableWork(): boolean {
    if (stopping) return false
    if (!current) return true
    const command = current.result.command
    if (command.kind === "commit") return true
    if (command.kind === "prepare_attempt") return stops.length === 0
    return command.kind === "run_attempts" && command.attempts.some(({ attemptId }) => !children.inFlight().has(attemptId))
  }

  return { preflight, run, abort, dispose, hasRunnableWork }
}

/** The RECOVER of a crashed run. It names each attempt in flight whose
 *  conversation recorded a served response after the attempt's latest
 *  start. Every recovery restarts each attempt in flight, so that start is
 *  also later than the run's previous recovery. */
async function recoverEvent(
  facts: readonly StoredFact[],
  control: CommittedWorkflowControl,
  servedConversations: WorkflowVmHostDeps["servedConversations"],
): Promise<NewWorkflowProposalEvent> {
  const startedAt = new Map<string, number>()
  for (const stored of facts) {
    if (stored.type !== "attempt.started") continue
    const fact = parseProjectionFact(stored, parseWorkflowSessionFact)
    if (fact.type === "attempt.started") startedAt.set(fact.payload.attemptId, stored.position)
  }
  const inFlight = control.attempts.flatMap(({ id, state, conversationId }) => state._tag === "running" && conversationId !== null ? [{ id, conversationId }] : [])
  const served = await servedConversations(new Map(inFlight.map(({ id, conversationId }) => [conversationId, startedAt.get(id) ?? 0])))
  return { type: "RECOVER", progressed: inFlight.filter(({ conversationId }) => served.has(conversationId)).map(({ id }) => id) }
}

// The state came from the machine one transition earlier and the event is
// built typed in this module, so both are already inside the strict boundary
// that replay parsed. Re-parsing here would violate the parse-at-
// replay contract transition.ts documents.
function drive(result: WorkflowTransitionResult, event: NewWorkflowProposalEvent): DrivenTransition {
  return { event, result: transitionDecodedWorkflow(result.state, event) }
}

function requireConversationId(input: { readonly conversationId: string | null; readonly attemptId: string }): string {
  if (input.conversationId) return input.conversationId
  throw lifecycleError("protocol", `Running attempt "${input.attemptId}" has no committed conversation id`)
}

