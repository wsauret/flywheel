/**
 * Workflow Runner — full executor lifecycle: setup, execution, pause, abort, cleanup.
 * Pure orchestration logic with callback-based notifications.
 */

import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { resolveTransports, buildExecutorDeps } from "./queue-orchestrator"
import { createStepExecutor, type StepExecutor } from "../workflows/queue/executor"
import { createQueuePersistence } from "../workflows/queue/persistence"
import { createGuardrails } from "../workflows/queue/guardrails"
import { type BudgetTracker } from "./session/budget-tracker"
import { createOutputPersistence } from "./session/output-persistence"
import { createSessionInfra } from "./session/create-session-infra"
import { createWorkflowSession, destroyWorkflowSession, type WorkflowSession, type WorkflowStore } from "./workflow-session"
import { EventBus, createFlywheelEmitter, type Unsubscribe } from "../infra/event-bus"
import { ContextIndexer } from "./memory/indexer"
import type { TraceWriter } from "./session/trace-writer"
import type { TranscriptWriter } from "./session/transcript-writer"
import type { TraceCollector } from "./session/trace-collector"
import { createTraceEventHandler } from "./engines/subprocess/trace-event-handler"
import { createWarmPools } from "./engines/pool/create-warm-pools"
import type { WarmPool } from "./engines/pool/warm-pool"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline"
import { randomUUID } from "node:crypto"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import type { StdinHandle, SpawnResult } from "./engines/subprocess/spawner"
import type { Queue } from "../workflows/queue/types"
import type { AnyBlock } from "../infra/output-blocks"
import type { SessionRunner } from "./session-runner"
import { generateSessionTitle } from "./session-title"
import { createPostTurnVerificationHook } from "../workflows/queue/post-turn-verification"
import { createSprintHook } from "../workflows/queue/steps/sprint/hooks"
import { SPRINT_HINT } from "../workflows/queue/steps/sprint/types"
import type { OnStepCompletedHook } from "../workflows/queue/shared/hooks"
import "../workflows/queue/steps/register-all"


// ── Types ──

export type StepState = {
  id: string; type: string; title: string; status: string
  durationMs?: number; startedAt?: number; completedAt?: number
}

export interface WorkflowCallbacks {
  onBlocks: (blocks: AnyBlock[]) => void
  onSteps: (steps: StepState[]) => void
  onTokens: (n: number) => void
  onCost: (n: number) => void
  onSessionName: (name: string) => void
  onModelActivity?: (activity: import("../infra/events").ModelActivity) => void
}

export interface WorkflowResult {
  completed: boolean
  stepsCompleted: number
  stepsTotal: number
  cost: number
  tokens: number
  reason?: string
}

export interface WorkflowRunnerOverrides {
  projectCwd?: string
  /** Override the subprocess cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  subprocessCwd?: string
  eventBus?: EventBus
  contextIndexer?: ContextIndexer
  budgetTracker?: BudgetTracker
}

export interface WorkflowRunner extends SessionRunner {
  /** Run the executor to completion. Resolves with result. */
  run(): Promise<WorkflowResult>
  /** Graceful pause — finish current step then stop. */
  pause(): void
  /** Force abort — kill subprocess immediately. */
  abort(): void
  /** Inject a user message into the running subprocess. Returns true if delivered or queued. */
  injectMessage(text: string): boolean
  /** Cancel a pending shutdown so execution continues after current step. */
  cancelShutdown(): void
  /** The session ID for this workflow. */
  readonly sessionId: string
  /** Clean up all resources. Called automatically after run() resolves. */
  dispose(): Promise<void>
}

// ── Factory ──

/**
 * Create a workflow runner for a new or resumed session.
 *
 * @param opts.sessionId - Session ID (already created via manager.create or loaded for resume)
 * @param opts.queue - Queue to execute (fresh from buildQueueForSlashCommand or loaded from persistence)
 * @param opts.description - Human-readable session description
 * @param opts.callbacks - UI notification callbacks (blocks, steps, metrics)
 * @param opts.priorBlocks - Output blocks from a previous run (for resume — prepended to new output)
 */
export function createWorkflowRunner(opts: {
  sessionId: string
  queue: Queue
  description: string
  callbacks: WorkflowCallbacks
  priorBlocks?: AnyBlock[]
  projectCwd?: string
  overrides?: WorkflowRunnerOverrides
}): WorkflowRunner {
  const { sessionId, queue, description, callbacks, priorBlocks } = opts
  const projectCwd = opts.overrides?.projectCwd ?? opts.projectCwd ?? process.cwd()
  const subprocessCwd = opts.overrides?.subprocessCwd

  // Prepare workflow deps (config, engine, etc.)
  const deps = prepareWorkflowDeps()

  // Session resources (timer, store, adapter, event bus)
  const session = createWorkflowSession({
    description,
    engineMetadata: deps.engine.metadata,
    eventBus: opts.overrides?.eventBus,
  })
  const { eventBus, store: uiActions } = session
  const activeSessionRef: { current: WorkflowSession | null } = { current: session }

  const emitter = createFlywheelEmitter(eventBus)
  const workflowIdRef = { current: randomUUID() }

  // Shared session infrastructure (budget, traces, transcripts)
  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config: deps.config,
    description,
    budgetTracker: opts.overrides?.budgetTracker,
  })
  const { budgetTracker, traceWriter, transcriptWriter, traceCollector } = infra
  let traceFinalized = false

  // Wire metrics, model activity, and output persistence
  const wiring = wireMetricsAndUI(budgetTracker, uiActions, callbacks, sessionId, projectCwd, priorBlocks)

  // Wire step and trace event subscriptions
  const eventUnsubs = wireEventSubscriptions(eventBus, queue, callbacks, traceCollector ?? undefined)

  // Initialize step display
  callbacks.onSteps(queue.steps.map(toStepState))

  // Build executor
  let executor: StepExecutor | null = null
  let disposed = false

  // Hoisted refs so injectMessage can access them outside run()
  const stdinHandleRef: { current: StdinHandle | null } = { current: null }
  const pendingInjection: { queue: string[] } = { queue: [] }

  // Pool refs — created inside run(), shut down in dispose()
  let dispatcherPool: WarmPool<SpawnResult> | null = null
  let evaluatorPool: WarmPool<SpawnResult> | null = null
  let subprocessPool: WarmPool<RawSpawnedProcess> | null = null

  async function run(): Promise<WorkflowResult> {
    // Sprint detection: if any step has SPRINT_HINT, wire the sprint hook.
    // Sprint tier config ([sprint.worker], [sprint.evaluator], etc.) is resolved
    // by resolveTierConfigs when mode="sprint" — no config cloning needed.
    const isSprint = queue.steps.some((s) => s.dispatcherHint === SPRINT_HINT)
    const externalHooks: OnStepCompletedHook[] = []
    if (isSprint) {
      const { hook } = createSprintHook(deps.config.sprint)
      externalHooks.push(hook)
    }

    // Create warm pools — passes mode so resolveTierConfigs applies sprint overrides
    const pools = createWarmPools(deps, projectCwd, subprocessCwd, isSprint ? "sprint" : undefined)
    dispatcherPool = pools.dispatcher
    evaluatorPool = pools.evaluator
    subprocessPool = pools.subprocess

    const stdinFormatter = (text: string) => formatStdinMessage(deps.engine.metadata.id, text)

    // Sprint evaluator uses Opus — override the 60s speed pressure with quality focus
    const evaluatorAddendum = isSprint
      ? "You are evaluating sprint mode work. Evaluate against the 6-point self-review checklist " +
        "(diff review, task alignment, completeness, test coverage, regression, edge cases). " +
        "PASS work that meets the task requirements. " +
        "Only FAIL for hard evidence: tests failing, critical deliverables missing, or fundamentally broken output."
      : undefined

    const { dispatcherTransport, evaluatorTransport } = resolveTransports(
      deps, eventBus, workflowIdRef, "", sessionId, projectCwd,
      evaluatorAddendum,
      { dispatcherPool, evaluatorPool: evaluatorPool ?? undefined, formatStdinMessage: stdinFormatter },
    )

    const contextIndexer = opts.overrides?.contextIndexer ?? new ContextIndexer(projectCwd)

    // Create trace event handler (gated by tracing config)
    const traceEventHandler = deps.config.tracing.enabled
      ? createTraceEventHandler({ emitter, workflowIdRef })
      : null

    // Post-turn verification applies to all workflow types, not just sprint.
    // Native checks re-run commands from the handoff independently via Bun.spawn
    // after the worker exits. Self-review injection happens at the turn boundary
    // in subprocess-callback.ts (same mechanism as observer injection —
    // pushed to pendingInjection.queue).
    const postTurnVerification = createPostTurnVerificationHook({
      nativeChecks: true,
      nativeCheckTypes: ["build", "test", "has-changes"],
      selfReview: false, // self-review is handled at turn boundary in subprocess-callback, not here
      maxFixAttempts: 2,
      projectCwd,
    })

    const execDeps = buildExecutorDeps({
      deps: deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
      contextIndexer, projectCwd, subprocessCwd, sessionObjective: description, queue, sessionId,
      stdinHandleRef,
      capturedSubprocessSessionId: { current: undefined },
      pendingInjection,
      activeSessionRef,
      budgetTracker,
      traceEventHandler,
      transcriptWriter,
      subprocessPool,
      externalHooks,
    })

    const guardrails = createGuardrails({
      maxQueueLength: deps.config.queue?.max_steps ?? 50,
      maxMutationsPerStepCompletion: deps.config.dispatcher_intelligence?.max_mutations_per_step ?? 3,
      maxInsertedStepsPerSession: deps.config.dispatcher_intelligence?.max_inserted_steps ?? 20,
    })

    const persistence = createQueuePersistence({ sessionId, baseDir: projectCwd })

    executor = createStepExecutor({
      queue,
      workflowId: workflowIdRef.current,
      sessionId,
      emitter,
      dispatcher: execDeps.dispatcherFn,
      worker: execDeps.subprocessFn,
      evaluator: execDeps.evaluator,
      skipEvaluation: deps.config.skip_evaluation ?? false,
      handoffReader: execDeps.handoffReader,
      budgetChecker: { isExhausted: () => false },
      persist: async (q) => { try { await persistence.save(q) } catch { /* best-effort */ } },
      accumulator: execDeps.contextAccumulator,
      maxRevisions: deps.config.max_revisions ?? 1,
      onStepCompleted: execDeps.compositeHook,
      guardrails,
      sessionObjective: description,
      onSubprocessDispatched: () => budgetTracker.incrementInvocations(),
      postTurnVerification,
    })

    // Generate session title via haiku in parallel — doesn't block execution
    generateSessionTitle(description, (title) => callbacks.onSessionName(title))

    const result = await executor.run()

    // Finalize trace with result status
    if (traceCollector && !traceFinalized) {
      traceFinalized = true
      traceCollector.finalize(result.completed ? "ok" : "error")
    }

    // Final step states
    callbacks.onSteps(queue.steps.map(toStepState))

    budgetTracker.flush()
    return {
      completed: result.completed,
      stepsCompleted: result.stepsCompleted,
      stepsTotal: result.stepsTotal,
      cost: budgetTracker.getTotalCost(),
      tokens: budgetTracker.getTokensUsed(),
      reason: result.reason,
    }
  }

  function pause(): void {
    executor?.requestShutdown()
  }

  function abort(): void {
    executor?.abort()
  }

  function injectMessage(text: string): boolean {
    const engineId = deps.engine?.metadata?.id ?? "claude"
    const formatted = formatStdinMessage(engineId, text)

    // Try direct write if pipe is open
    if (stdinHandleRef.current) {
      if (stdinHandleRef.current.isOpen) {
        try {
          stdinHandleRef.current.write(formatted)
          return true
        } catch { /* fall through to queuing */ }
      }
    }

    // Queue for turn-boundary injection
    pendingInjection.queue.push(text)
    return true
  }

  function cancelShutdown(): void {
    executor?.cancelShutdown()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    clearInterval(wiring.metricsTimer)
    eventUnsubs.forEach((u) => u())
    wiring.storeUnsub()
    wiring.execUnsub?.()
    destroyWorkflowSession(session)
    activeSessionRef.current = null
    // Finalize trace if not already finalized (abort path)
    if (traceCollector && !traceFinalized) {
      traceFinalized = true
      traceCollector.finalize("error")
    }
    traceWriter?.dispose()
    transcriptWriter?.dispose()
    budgetTracker.dispose()
    // Shut down warm pools (covers complete, abort, and error paths)
    await Promise.all([
      dispatcherPool?.shutdown(),
      evaluatorPool?.shutdown(),
      subprocessPool?.shutdown(),
    ])
    dispatcherPool = null
    evaluatorPool = null
    subprocessPool = null
    await wiring.outputFlusher.flush()
    wiring.outputFlusher.dispose()
    executor = null
  }

  return { run, pause, abort, injectMessage, cancelShutdown, sessionId, dispose }
}

// ── Helpers ──

function toStepState(s: { id: string; type: string; title: string; status: string }): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}

// ── Metrics + UI wiring ──

interface MetricsWiring {
  metricsTimer: ReturnType<typeof setInterval>
  execUnsub: (() => void) | null
  storeUnsub: () => void
  outputFlusher: { schedule(): void; flush(): Promise<void>; dispose(): void }
  getCurrentBlocks: () => AnyBlock[]
}

function wireMetricsAndUI(
  budgetTracker: BudgetTracker,
  uiActions: WorkflowStore,
  callbacks: WorkflowCallbacks,
  sessionId: string,
  projectCwd: string,
  priorBlocks: AnyBlock[] | undefined,
): MetricsWiring {
  // Metrics poll
  const metricsTimer = setInterval(() => {
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())
  }, 500)

  // Wire store → model activity
  let execUnsub: (() => void) | null = null
  if (callbacks.onModelActivity) {
    let lastActivity = uiActions.getState().modelActivity;
    execUnsub = uiActions.subscribeExecution(() => {
      const activity = uiActions.getState().modelActivity;
      if (activity !== lastActivity) {
        lastActivity = activity;
        callbacks.onModelActivity!(activity);
      }
    });
  }

  // Output persistence
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let currentBlocks: AnyBlock[] = []
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks)

  // Wire store → blocks callback
  const storeUnsub = uiActions.subscribe(() => {
    const newBlocks = uiActions.getState().outputBlocks ?? []
    currentBlocks = priorBlocks ? [...priorBlocks, ...newBlocks] : newBlocks
    callbacks.onBlocks(currentBlocks)
    outputFlusher.schedule()
  })

  return { metricsTimer, execUnsub, storeUnsub, outputFlusher, getCurrentBlocks: () => currentBlocks }
}

// ── Event subscription wiring ──

function wireEventSubscriptions(
  eventBus: import("../infra/event-bus").EventBus,
  queue: Queue,
  callbacks: WorkflowCallbacks,
  traceCollector: TraceCollector | undefined,
): Unsubscribe[] {
  const unsubs: Unsubscribe[] = []

  // Step events
  unsubs.push(
    eventBus.subscribe((event) => {
      if (event.type === "queue:step-started") {
        callbacks.onSteps(queue.steps.map((s) => ({
          ...toStepState(s),
          ...(s.id === event.stepId ? { status: "running", startedAt: Date.now() } : {}),
        })))
      }
      if (event.type === "queue:step-completed" || event.type === "queue:step-failed") {
        callbacks.onSteps(queue.steps.map(toStepState))
      }
    }),
  )

  // Trace collector events
  if (traceCollector) {
    unsubs.push(...traceCollector.subscribeToEvents(eventBus))
  }

  return unsubs
}

