/**
 * Queue execution runner — the queue execution pipeline.
 *
 *   - `executeQueue()` — resolves transports, builds executor, runs queue
 *   - `handleQueueResult()` — interprets executor result + side effects
 *   - `cleanupQueueExecution()` — common cleanup for success/failure paths
 *   - `runQueueOnSession()` — orchestrates the above for both start + resume
 *
 * Event wiring (setupQueueEventSubscriptions) is in queue-event-wiring.ts.
 *
 * All dependencies are injected — no SolidJS signals or component-level
 * state captured in closures.
 */

import { createFlywheelEmitter } from "../../events/event-bus"
import { createStepExecutor, type StepExecutor, type StepExecutorResult } from "../../queue/executor"
import { createGuardrails } from "../../queue/guardrails"
import { createQueuePersistence } from "../../queue/persistence"
import { resolveTransports, buildExecutorDeps } from "../../orchestration/queue-orchestrator"
import { setupQueueEventSubscriptions } from "./queue-event-wiring"
import { SubprocessLogger } from "../../utils/subprocess-logger.js"
import { TelemetryLogger, type TelemetryRecord } from "../../telemetry"
import { updateSession } from "../../session/persistence"
import { safeUpdateState } from "../../session/safe-transition"
import { handleQueueCompletion } from "../session/queue-completion"
import { SPRINT_EVALUATOR_ADDENDUM } from "../../queue/steps/sprint-work/evaluator"
import { Log } from "../../utils/log"

import type { Queue, QueueResult } from "../../queue/types"
import type { Unsubscribe } from "../../events/event-bus"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { BudgetTracker } from "../../session/budget-tracker"
import type { BudgetLimits } from "../../schemas"
import type { OutputFlusher } from "../../session/output-persistence"
import type { ContextIndexer } from "../../memory/indexer"
import type { StdinHandle } from "../../worker/spawner"
import type { QuestionService } from "../../queue/question-service"
import type { WorkflowSession } from "../../orchestration/workflow-session"
import type { QueueStepState } from "../types"
import type { QueueProgressInfo } from "../../orchestration/queue-builder"
import type { SprintIterationInfo } from "../utils/format"
import type { ConfirmBeforeInsert } from "../../queue/steps/plan-consolidate/hooks"
import type { SessionLifecycleManager } from "./session-lifecycle-runner"
import type { SessionRuntimeManager } from "../session/session-runtime"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { AppState } from "./shell-modes"

const log = Log.create({ service: "queue-runner" })

// Re-export for consumers that previously imported from this file
export { setupQueueEventSubscriptions } from "./queue-event-wiring"
export type { SetupQueueEventSubsOpts } from "./queue-event-wiring"

// ---------------------------------------------------------------------------
// executeQueue
// ---------------------------------------------------------------------------

export interface ExecuteQueueOptions {
  // Core inputs
  queue: Queue
  session: WorkflowSession
  deps: WorkflowDeps
  sessionId: string
  projectCwd: string
  sessionObjective?: string
  chatContext?: string

  // Queue event subscriptions (caller manages lifecycle)
  queueUnsubs: Unsubscribe[]

  // Budget
  budgetTracker: BudgetTracker | null
  budgetLimits: BudgetLimits | null

  // Context
  contextIndexer: ContextIndexer
  indexerStarted: { current: boolean }
  seedHandoff?: Record<string, unknown> | null

  // HITL
  questionService: QuestionService | null
  interactiveOverrides?: { plan?: boolean; review?: boolean }
  confirmBeforeInsert?: ConfirmBeforeInsert

  // Mutable refs (shared with shell for interrupt/injection)
  stdinHandleRef: { current: StdinHandle | null }
  capturedWorkerSessionId: { current: string | undefined }
  pendingInjection: { current: string | null }
  activeSessionRef: { current: WorkflowSession | null }

  // Signal setters for UI updates
  setShellQueueSteps: (updater: any) => void

  // Callbacks
  onSessionName?: (name: string) => void
  onExecutorCreated?: (executor: StepExecutor) => void
  onRegistration?: (executor: StepExecutor) => void

  // Resume: pre-fill completed step count for telemetry
  alreadyCompletedSteps?: number
}

export interface ExecuteQueueResult {
  result: StepExecutorResult | undefined
  telemetryLogger: TelemetryLogger
  telemetryRecord: TelemetryRecord
}

/**
 * The unified executor run. Resolves transports, builds executor deps,
 * creates the executor, runs it, and returns the result + telemetry handles.
 *
 * Does NOT handle result interpretation — that stays in the shell
 * (via handleQueueResult).
 */
export async function executeQueue(opts: ExecuteQueueOptions): Promise<ExecuteQueueResult> {
  const {
    queue, session, deps, sessionId, projectCwd,
    sessionObjective, chatContext,
    queueUnsubs,
    budgetTracker, budgetLimits,
    contextIndexer, indexerStarted, seedHandoff,
    questionService, interactiveOverrides, confirmBeforeInsert,
    stdinHandleRef, capturedWorkerSessionId, pendingInjection, activeSessionRef,
    setShellQueueSteps,
    onSessionName, onExecutorCreated, onRegistration,
    alreadyCompletedSteps,
  } = opts

  // Start context indexing
  if (!indexerStarted.current) {
    try {
      await contextIndexer.startIndexing()
      indexerStarted.current = true
    } catch { /* silently fall back to empty context */ }
  }

  // Prune old subprocess log dirs
  const queueLogBaseDir = deps.config.project_cwd ?? process.cwd()
  try { SubprocessLogger.cleanup(queueLogBaseDir) } catch { /* best-effort */ }

  // Track current workflowId
  const workflowIdRef = { current: `queue-${sessionId}` }
  const workflowIdUnsub = session.eventBus.subscribeToType("queue:initialized", (ev) => {
    workflowIdRef.current = ev.workflowId
  })
  queueUnsubs.push(workflowIdUnsub)

  // Detect sprint/debug queue for evaluator addendum
  const isDebugQueue = queue.steps.some(s => s.type === "debug")
  const isSprintQueue = !isDebugQueue && queue.steps.some(s => s.type === "verify")
  const evalAddendum = isSprintQueue ? SPRINT_EVALUATOR_ADDENDUM : undefined

  // Resolve dispatcher and evaluator transports
  const { dispatcherTransport, evaluatorTransport } = await resolveTransports(
    deps, session.eventBus, workflowIdRef, queueLogBaseDir, sessionId, projectCwd, evalAddendum,
  )

  // Telemetry Logger
  const telemetryDir = `${projectCwd}/.flywheel/telemetry`
  const sessionTelemetryDir = sessionId ? `${projectCwd}/.flywheel/sessions/${sessionId}` : undefined
  const telemetryLogger = new TelemetryLogger(telemetryDir, 50, sessionTelemetryDir)
  const telemetryRecord = telemetryLogger.startRecord(
    queue.steps.map((s) => s.type).join("-"),
    workflowIdRef.current,
    {
      stepsTotal: queue.steps.length,
      dispatcherMode: dispatcherTransport ? "dispatcher" : "static",
    },
  )
  // Pre-fill completed step count (resume path)
  if (alreadyCompletedSteps && alreadyCompletedSteps > 0) {
    telemetryLogger.updateRecord(telemetryRecord, { steps_completed: alreadyCompletedSteps })
  }
  // Subscribe to queue events for telemetry updates
  queueUnsubs.push(
    session.eventBus.subscribeToType("queue:step-completed", () => {
      telemetryLogger.updateRecord(telemetryRecord, {
        steps_completed: telemetryRecord.steps_completed + 1,
      })
    }),
    session.eventBus.subscribeToType("queue:step-failed", (e) => {
      telemetryLogger.updateRecord(telemetryRecord, {
        errors: [{ step: telemetryRecord.steps_completed, kind: "step-failed", message: e.reason ?? "unknown" }],
      })
    }),
  )

  const emitter = createFlywheelEmitter(session.eventBus)
  const projectCwdForExec = deps.config.project_cwd ?? process.cwd()

  // Build shared executor dependencies
  const execDeps = buildExecutorDeps({
    deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
    contextIndexer, projectCwd: projectCwdForExec,
    sessionObjective, chatContext, queue,
    sessionId,
    stdinHandleRef,
    seedHandoff,
    questionService,
    reviewTriageInteractive: interactiveOverrides?.review,
    confirmBeforeInsert,
    setShellQueueSteps,
    capturedWorkerSessionId,
    pendingInjection,
    activeSessionRef,
    budgetTracker,
  })

  // Create guardrails
  const guardrails = createGuardrails({
    maxQueueLength: deps.config.queue?.max_steps ?? 50,
    maxMutationsPerStepCompletion: deps.config.dispatcher_intelligence?.max_mutations_per_step ?? 3,
    maxInsertedStepsPerSession: deps.config.dispatcher_intelligence?.max_inserted_steps ?? 20,
    sessionObjective: sessionObjective ?? "",
  })

  // Create step executor
  const stepExec = createStepExecutor({
    queue,
    workflowId: workflowIdRef.current,
    sessionId,
    emitter,
    dispatcher: execDeps.dispatcherFn,
    worker: execDeps.workerFn,
    evaluator: execDeps.evaluator,
    handoffReader: execDeps.handoffReader,
    budgetChecker: budgetTracker && budgetLimits
      ? { isExhausted: () => budgetTracker!.isExhausted(budgetLimits!) }
      : { isExhausted: () => false },
    persist: async (q) => {
      if (deps.config.queue?.persist_queue !== false) {
        try {
          const queuePersistence = createQueuePersistence({
            sessionId,
            baseDir: projectCwd,
          })
          await queuePersistence.save(q)
        } catch { /* best-effort */ }
      }
    },
    accumulator: execDeps.contextAccumulator,
    maxRevisions: deps.config.max_revisions ?? 1,
    onStepCompleted: execDeps.compositeHook,
    guardrails,
    sessionObjective: sessionObjective ?? "",
    persistAccumulatorState: deps.config.queue?.persist_queue !== false
      ? (state) => {
          try {
            const queuePersistence = createQueuePersistence({
              sessionId,
              baseDir: projectCwd,
            })
            queuePersistence.saveAccumulatorState(state as import("../../queue/context-accumulator").AccumulatorState)
          } catch { /* best-effort */ }
        }
      : null,
    onSessionName: onSessionName,
    onWorkerDispatched: budgetTracker ? () => budgetTracker!.incrementInvocations() : null,
  })

  // Notify shell of created executor
  if (onExecutorCreated) onExecutorCreated(stepExec)

  // Notify shell for registration in sessionControllers/runtimes
  if (onRegistration) onRegistration(stepExec)

  // Run executor
  const result = await stepExec.run()

  return { result, telemetryLogger, telemetryRecord }
}

// ---------------------------------------------------------------------------
// handleQueueResult
// ---------------------------------------------------------------------------

export interface HandleQueueResultOpts {
  result: StepExecutorResult | undefined
  error: Error | null
  userInitiatedPause: boolean
  interruptAbort: boolean
  sessionId: string | null
  queue: Queue

  // Callbacks for UI updates
  setAppState: (state: AppState) => void
  setShellQueueSteps: (updater: QueueStepState[] | ((prev: QueueStepState[]) => QueueStepState[])) => void
  toast: { show(opts: { message: string; variant: string; duration?: number }): void }
  activeStore: { setError(msg: string): void } | null
  updateState: (id: string, state: string) => void
  refreshList: () => void
  isStillViewed: () => boolean
  setIsQueueRunning: (v: boolean) => void
  setActiveStepExecutor: (v: null) => void
}

export interface HandleQueueResultReturn {
  wasInterrupted: boolean
}

/**
 * Interprets the executor result and performs side effects (toasts, state transitions).
 * Returns whether the run was interrupted (caller uses this to skip cleanup).
 */
export function handleQueueResult(opts: HandleQueueResultOpts): HandleQueueResultReturn {
  const {
    result, error, userInitiatedPause, interruptAbort, sessionId, queue,
    setAppState, setShellQueueSteps, toast, activeStore,
    updateState, refreshList, isStillViewed,
    setIsQueueRunning, setActiveStepExecutor,
  } = opts

  // Handle error path
  if (error) {
    if (userInitiatedPause) return { wasInterrupted: false }

    if (interruptAbort) {
      setIsQueueRunning(false)
      setActiveStepExecutor(null)
      toast.show({
        message: "Worker interrupted — type to resume, or Esc to kill",
        variant: "warning",
        duration: 5000,
      })
      log.info("queue interrupted (exception path) — staying in working state", { sessionId })
      return { wasInterrupted: true }
    }

    activeStore?.setError(String(error))
    if (sessionId) {
      safeUpdateState(updateState, sessionId, "work:paused")
      refreshList()
    }
    if (isStillViewed()) setAppState("completed")
    return { wasInterrupted: false }
  }

  // Handle result path
  if (!result) return { wasInterrupted: false }

  if (!result.completed && !userInitiatedPause) {
    const isBudgetExhausted = /budget[_ ]exhausted/i.test(result.reason ?? "")
    const isRateLimitPause = /rate limit/i.test(result.reason ?? "")

    if (interruptAbort) {
      setIsQueueRunning(false)
      setActiveStepExecutor(null)
      toast.show({
        message: "Worker interrupted — type to resume, or Esc to kill",
        variant: "warning",
        duration: 5000,
      })
      // Update the failed step's display to show "interrupted"
      setShellQueueSteps((prev: QueueStepState[]) =>
        prev.map((s) =>
          s.status === "failed"
            ? { ...s, status: "failed" as const, error: "interrupted" }
            : s,
        ),
      )
      log.info("queue interrupted — staying in working state for resume", {
        sessionId,
      })
      return { wasInterrupted: true }
    } else if (isRateLimitPause) {
      toast.show({
        message: "Queue paused — rate limit reached. Resume when limits lift.",
        variant: "warning",
        duration: 5000,
      })
    } else if (isBudgetExhausted) {
      toast.show({
        message: "Queue stopped — budget exhausted.",
        variant: "warning",
        duration: 5000,
      })
    } else {
      activeStore?.setError(result.reason ?? "Queue execution failed")
    }

    if (sessionId) {
      const targetState = isBudgetExhausted ? "budget_exhausted" : "work:paused"
      safeUpdateState(updateState, sessionId, targetState)
      refreshList()
    }
    if (isStillViewed()) setAppState("completed")
  }

  return { wasInterrupted: false }
}

// ---------------------------------------------------------------------------
// cleanupQueueExecution
// ---------------------------------------------------------------------------

export interface CleanupQueueExecutionOpts {
  // Budget
  budgetTracker: BudgetTracker | null
  activeBudgetTrackerRef: { current: BudgetTracker | null }

  // Session
  sessionId: string | null
  sessionControllers: Map<string, { shutdown(): Promise<void> }>
  runtimes: { remove(id: string): void }

  // Queue result handling
  result: StepExecutorResult | undefined
  userInitiatedPause: boolean
  queue: Queue
  flusher: OutputFlusher | null

  // Orchestrator for completion
  orchestrator: {
    handleAutoArchive(id: string, results: { workflow: string; completed: boolean }[]): Promise<void>
  }
  toast: { show(opts: { message: string; variant: string }): void }
  updateState: (id: string, state: string) => void
  refreshList: () => void

  // Telemetry
  telemetryLogger: TelemetryLogger
  telemetryRecord: TelemetryRecord

  // Queue running flag
  setIsQueueRunning: (v: boolean) => void
}

/**
 * Common cleanup for both success and failure paths. Runs in the `finally` block.
 * Disposes budget tracker, removes from controllers/runtimes, handles completion,
 * and persists telemetry.
 */
export async function cleanupQueueExecution(opts: CleanupQueueExecutionOpts): Promise<void> {
  const {
    budgetTracker, activeBudgetTrackerRef,
    sessionId, sessionControllers, runtimes,
    result, userInitiatedPause, queue, flusher,
    orchestrator, toast, updateState, refreshList,
    telemetryLogger, telemetryRecord,
    setIsQueueRunning,
  } = opts

  setIsQueueRunning(false)

  if (budgetTracker) {
    budgetTracker.dispose()
    if (activeBudgetTrackerRef.current === budgetTracker) {
      activeBudgetTrackerRef.current = null
    }
  }

  if (sessionId) {
    sessionControllers.delete(sessionId)
    runtimes.remove(sessionId)
  }

  // Handle completion
  if (result && !userInitiatedPause) {
    try {
      const queueResultCompat: QueueResult = {
        completed: result.completed,
        stepsCompleted: result.stepsCompleted,
        stepsTotal: result.stepsTotal,
        reason: result.reason,
        stepResults: queue.steps
          .filter((s) => s.status === "completed")
          .map((s) => ({
            workflow: s.type as any,
            completed: true,
          })),
      }
      await handleQueueCompletion(queueResultCompat, {
        orchestrator,
        sessionId,
        flusher,
        toast,
        updateState,
        refreshList,
      })
    } catch (completionErr) {
      log.error("queue completion failed", {
        error: completionErr instanceof Error ? completionErr : String(completionErr),
      })
    }
  }

  // Persist telemetry record
  try {
    telemetryLogger.updateRecord(telemetryRecord, {
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - new Date(telemetryRecord.started_at).getTime(),
    })
    await telemetryLogger.persist(telemetryRecord)
  } catch (telErr) {
    log.warn("telemetry persist failed", {
      error: telErr instanceof Error ? telErr.message : String(telErr),
    })
  }
}

// ---------------------------------------------------------------------------
// runQueueOnSession
// ---------------------------------------------------------------------------

export interface RunQueueOnSessionOptions {
  // Session + queue
  session: WorkflowSession
  queue: Queue
  sessionId: string | null
  deps: WorkflowDeps
  budgetTracker: BudgetTracker | null
  budgetLimits: BudgetLimits | null
  sessionObjective?: string
  chatContext?: string
  interactiveOverrides?: { plan?: boolean; review?: boolean }
  seedHandoff?: Record<string, unknown> | null
  alreadyCompletedSteps?: number
}

export interface RunQueueOnSessionDeps {
  // Lifecycle manager
  lifecycle: SessionLifecycleManager

  // Signal setters
  setShellQueueSteps: (v: QueueStepState[] | ((prev: QueueStepState[]) => QueueStepState[])) => void
  setFocusedSessionId: (id: string | null) => void
  setViewedSessionId: (id: string | null) => void
  setAppState: (state: AppState) => void
  setActiveQueueInfo: (info: QueueProgressInfo | null) => void
  setActiveSprintInfo: (info: SprintIterationInfo | null) => void
  setActiveWorkflowName: (name: string) => void

  // Registries
  sessionControllers: Map<string, { shutdown(): Promise<void> }>
  runtimes: SessionRuntimeManager
  sessionStores: Map<string, UIActions>

  // Mutable refs
  activeStdinHandleRef: { current: StdinHandle | null }
  capturedWorkerSessionId: { current: string | undefined }
  pendingInjection: { current: string | null }
  activeSessionRef: { current: WorkflowSession | null }
  isQueueRunningRef: { current: boolean }

  // Queue unsubs (mutable array managed by shell)
  queueUnsubs: { current: Unsubscribe[] }

  // State flags (read/write via getters)
  getUserInitiatedPause: () => boolean
  setUserInitiatedPause: (v: boolean) => void
  getInterruptAbort: () => boolean
  setInterruptAbort: (v: boolean) => void
  getIndexerStarted: () => boolean
  setIndexerStarted: (v: boolean) => void

  // Callbacks
  getOrCreateContextIndexer: () => ContextIndexer
  sessionCtx: {
    manager: { updateState(id: string, state: string): void }
    refreshList: () => void
  }
  orchestrator: {
    handleAutoArchive(id: string, results: { workflow: string; completed: boolean }[]): Promise<void>
  }
  toast: { show(opts: { message: string; variant: string; duration?: number }): void }
  viewedSessionId: () => string | null
  activeStore: () => UIActions | null

  // Executor tracking
  setActiveStepExecutor: (v: StepExecutor | null) => void

  // Plan confirmation HITL
  confirmPlanBeforeInsert?: ConfirmBeforeInsert

  // Queue subscriptions cleanup
  cleanupQuestionSubscriptions: () => void
  cleanupQueueSubscriptions: () => void
}

/**
 * Shared wiring for steps 6-13 of queue execution (both new + resumed sessions).
 *
 * Steps performed:
 *   6. Set queue steps on store + shell signal
 *   7. Set appState to "working"
 *   8. Cache store in sessionStores
 *   9. Set up queue event subscriptions
 *  10. Set up context indexer
 *  11. Set flags (_isQueueRunning, etc.)
 *  12. Register in sessionControllers + runtimes (via onRegistration callback)
 *  13. Launch queueMicrotask -> executeQueue -> handleQueueResult -> cleanupQueueExecution
 */
export function runQueueOnSession(
  init: RunQueueOnSessionOptions,
  d: RunQueueOnSessionDeps,
): void {
  const {
    session, queue, sessionId: queueSessionId, deps,
    budgetTracker: queueBudgetTracker, budgetLimits: queueBudgetLimits,
    sessionObjective, chatContext, interactiveOverrides, seedHandoff,
    alreadyCompletedSteps,
  } = init

  // Step 6: Set queue steps on the session store + direct reactive signal
  const queueStepStates: QueueStepState[] = queue.steps.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title,
    status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
  }))
  session.store.setQueueSteps(queueStepStates)
  d.setShellQueueSteps(queueStepStates)

  // Step 7: Set appState to "working"
  if (queueSessionId) {
    d.setFocusedSessionId(queueSessionId)
    d.setViewedSessionId(queueSessionId)
  }
  d.setAppState("working")

  // Step 8: Cache store for sidebar/viewport
  if (queueSessionId) {
    d.sessionStores.set(queueSessionId, session.store)
    d.sessionCtx.refreshList()
  }

  // Step 9: Queue event subscriptions (via extracted runner)
  d.setShellQueueSteps(queueStepStates)
  /** Getter-based ref so the runner's flush callbacks see the current activeFlusher. */
  const flusherRef: { current: OutputFlusher | null } = Object.defineProperty(
    {} as { current: OutputFlusher | null },
    "current",
    { get: () => d.lifecycle.getActiveFlusher(), set: () => {} },
  )
  const eventSubs = setupQueueEventSubscriptions({
    eventBus: session.eventBus,
    queue,
    config: deps.config,
    setActiveQueueInfo: d.setActiveQueueInfo,
    setActiveSprintInfo: d.setActiveSprintInfo,
    setActiveWorkflowName: d.setActiveWorkflowName,
    setShellQueueSteps: d.setShellQueueSteps,
    activeFlusher: flusherRef,
    initialStepCount: alreadyCompletedSteps,
  })
  d.queueUnsubs.current.push(...eventSubs)

  // Step 10: Shared context indexer
  const queueContextIndexer = d.getOrCreateContextIndexer()

  // Step 11: Set flags
  const capturedProjectCwd = deps.config.project_cwd ?? "."
  d.isQueueRunningRef.current = true
  d.setUserInitiatedPause(false)
  d.setInterruptAbort(false)

  const capturedFlusher = d.lifecycle.getActiveFlusher()

  // Step 13: Launch async execution via queueMicrotask
  queueMicrotask(async () => {
    const isStillViewed = () => d.viewedSessionId() === queueSessionId
    const effectiveSessionId = queueSessionId ?? crypto.randomUUID()
    const indexerStartedRef = {
      get current() { return d.getIndexerStarted() },
      set current(v: boolean) { d.setIndexerStarted(v) },
    }

    let execResult: Awaited<ReturnType<typeof executeQueue>> | undefined
    let execError: Error | null = null
    let wasInterruptedRun = false
    try {
      execResult = await executeQueue({
        queue,
        session,
        deps,
        sessionId: effectiveSessionId,
        projectCwd: capturedProjectCwd,
        sessionObjective,
        chatContext,
        queueUnsubs: d.queueUnsubs.current,
        budgetTracker: queueBudgetTracker,
        budgetLimits: queueBudgetLimits,
        contextIndexer: queueContextIndexer,
        indexerStarted: indexerStartedRef,
        seedHandoff,
        questionService: d.lifecycle.getActiveQuestionWiring()?.service ?? null,
        interactiveOverrides,
        confirmBeforeInsert: interactiveOverrides?.plan ? d.confirmPlanBeforeInsert : undefined,
        stdinHandleRef: d.activeStdinHandleRef,
        capturedWorkerSessionId: d.capturedWorkerSessionId,
        pendingInjection: d.pendingInjection,
        activeSessionRef: d.activeSessionRef,
        setShellQueueSteps: d.setShellQueueSteps,
        alreadyCompletedSteps,
        onSessionName: (name) => {
          if (queueSessionId) {
            updateSession(queueSessionId, { name, label: name }, capturedProjectCwd)
          }
          session.store.setPlanName(name)
          d.sessionCtx.refreshList()
        },
        onExecutorCreated: (stepExec) => {
          d.setActiveStepExecutor(stepExec)
        },
        // Step 12: Register in sessionControllers + runtimes
        onRegistration: (stepExec) => {
          if (queueSessionId) {
            d.sessionControllers.set(queueSessionId, {
              shutdown: async () => { stepExec.requestShutdown() },
            })
            d.runtimes.register(queueSessionId, {
              kind: "running" as const,
              sessionId: queueSessionId,
              session,
              flusher: d.lifecycle.getActiveFlusher()!,
              budgetTracker: queueBudgetTracker!,
              storeUnsub: d.lifecycle.getStoreUnsub()!,
              questionCleanup: () => d.cleanupQuestionSubscriptions(),
              queueCleanup: () => d.cleanupQueueSubscriptions(),
              contextIndexer: queueContextIndexer,
              workerPid: null,
              stepExecutor: stepExec,
              queue,
            })
          }
        },
      })

      // Interpret the result
      const resultHandled = handleQueueResult({
        result: execResult.result,
        error: null,
        userInitiatedPause: d.getUserInitiatedPause(),
        interruptAbort: d.getInterruptAbort(),
        sessionId: queueSessionId,
        queue,
        setAppState: d.setAppState,
        setShellQueueSteps: d.setShellQueueSteps,
        toast: d.toast,
        activeStore: d.activeStore() ?? null,
        updateState: (id, s) => d.sessionCtx.manager.updateState(id, s),
        refreshList: () => d.sessionCtx.refreshList(),
        isStillViewed,
        setIsQueueRunning: (v) => { d.isQueueRunningRef.current = v },
        setActiveStepExecutor: () => { d.setActiveStepExecutor(null) },
      })
      d.setInterruptAbort(false)
      wasInterruptedRun = resultHandled.wasInterrupted
      if (wasInterruptedRun) return
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err))
      const resultHandled = handleQueueResult({
        result: undefined,
        error: execError,
        userInitiatedPause: d.getUserInitiatedPause(),
        interruptAbort: d.getInterruptAbort(),
        sessionId: queueSessionId,
        queue,
        setAppState: d.setAppState,
        setShellQueueSteps: d.setShellQueueSteps,
        toast: d.toast,
        activeStore: d.activeStore() ?? null,
        updateState: (id, s) => d.sessionCtx.manager.updateState(id, s),
        refreshList: () => d.sessionCtx.refreshList(),
        isStillViewed,
        setIsQueueRunning: (v) => { d.isQueueRunningRef.current = v },
        setActiveStepExecutor: () => { d.setActiveStepExecutor(null) },
      })
      d.setInterruptAbort(false)
      wasInterruptedRun = resultHandled.wasInterrupted
      if (wasInterruptedRun) return
    } finally {
      if (wasInterruptedRun) return

      await cleanupQueueExecution({
        budgetTracker: queueBudgetTracker,
        activeBudgetTrackerRef: {
          get current() { return d.lifecycle.getActiveBudgetTracker() },
          set current(v) { d.lifecycle.setActiveBudgetTracker(v) },
        },
        sessionId: queueSessionId,
        sessionControllers: d.sessionControllers,
        runtimes: d.runtimes,
        result: execResult?.result,
        userInitiatedPause: d.getUserInitiatedPause(),
        queue,
        flusher: capturedFlusher,
        orchestrator: d.orchestrator,
        toast: d.toast,
        updateState: (id, s) => d.sessionCtx.manager.updateState(id, s),
        refreshList: () => d.sessionCtx.refreshList(),
        telemetryLogger: execResult?.telemetryLogger ?? new TelemetryLogger(`${capturedProjectCwd}/.flywheel/telemetry`, 50),
        telemetryRecord: execResult?.telemetryRecord ?? { started_at: new Date().toISOString(), steps_completed: 0 } as any,
        setIsQueueRunning: (v) => { d.isQueueRunningRef.current = v },
      })
    }
  })
}
