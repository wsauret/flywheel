/**
 * Workflow Runner — full executor lifecycle: setup, execution, pause, abort, cleanup.
 * Pure orchestration logic with callback-based notifications.
 */

import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { resolveTransports, buildExecutorDeps } from "./queue-orchestrator"
import { createStepExecutor, type StepExecutor } from "../workflows/queue/executor"
import { createQueuePersistence } from "../workflows/queue/persistence"
import { createGuardrails } from "../workflows/queue/guardrails"
import { createBudgetTracker, type BudgetTracker } from "./session/budget-tracker"
import { createOutputPersistence } from "./session/output-persistence"
import { OpenTUIAdapter } from "../tui/adapters/opentui"
import { createStore as createUIStore } from "../tui/routes/work/context/ui-state/store"
import { EventBus, createFlywheelEmitter, type Unsubscribe } from "../infra/event-bus"
import { ContextIndexer } from "./memory/indexer"
import { createTraceWriter, type TraceWriter } from "./session/trace-writer"
import { createTranscriptWriter, type TranscriptWriter } from "./session/transcript-writer"
import { createTraceCollector, type TraceCollector } from "./session/trace-collector"
import { createTraceEventHandler } from "./engines/subprocess/trace-event-handler"
import { createWarmPools } from "./engines/pool/create-warm-pools"
import type { WarmPool } from "./engines/pool/warm-pool"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline"
import { randomUUID } from "node:crypto"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import type { StdinHandle, SpawnResult } from "./engines/subprocess/spawner"
import type { Queue } from "../workflows/queue/types"
import type { AnyBlock } from "../tui/types"
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

export interface WorkflowRunner {
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

  // Event bus + emitter
  const eventBus = opts.overrides?.eventBus ?? new EventBus()
  const emitter = createFlywheelEmitter(eventBus)
  const workflowIdRef = { current: randomUUID() }

  // Budget tracker
  const budgetTracker = opts.overrides?.budgetTracker ?? createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Tracing (gated by config)
  let traceWriter: TraceWriter | null = null
  let transcriptWriter: TranscriptWriter | null = null
  let traceCollector: TraceCollector | null = null
  let traceFinalized = false

  if (deps.config.tracing.enabled) {
    traceWriter = createTraceWriter({
      sessionId,
      baseDir: projectCwd,
      maxTraces: deps.config.tracing.max_traces,
    })
    transcriptWriter = createTranscriptWriter({ sessionId, baseDir: projectCwd })
    traceCollector = createTraceCollector({
      writer: traceWriter,
      sessionId,
      workflowName: description,
    })
  }

  // Metrics poll
  const metricsTimer = setInterval(() => {
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())
  }, 500)

  // Structured output pipeline
  const uiActions = createUIStore("workflow")
  uiActions.startWorkflow(description)
  const adapter = new OpenTUIAdapter({ actions: uiActions, engineMetadata: deps.engine.metadata })
  adapter.connect(eventBus)

  // Wire store → model activity callback
  let execUnsub: (() => void) | null = null
  if (callbacks.onModelActivity) {
    let lastActivity = uiActions.getState().modelActivity;
    execUnsub = uiActions.subscribeExecution!(() => {
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
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks as any[])

  // Wire store → blocks callback
  const storeUnsub = uiActions.subscribe(() => {
    const newBlocks = uiActions.getState().outputBlocks ?? []
    currentBlocks = priorBlocks ? [...priorBlocks, ...newBlocks] : newBlocks
    callbacks.onBlocks(currentBlocks)
    outputFlusher.schedule()
  })

  // Wire step events
  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(
    eventBus.subscribe((event) => {
      if (event.type === "queue:step-started") {
        const e = event as any
        callbacks.onSteps(queue.steps.map((s) => ({
          ...toStepState(s),
          ...(s.id === e.stepId ? { status: "running", startedAt: Date.now() } : {}),
        })))
      }
      if (event.type === "queue:step-completed" || event.type === "queue:step-failed") {
        callbacks.onSteps(queue.steps.map(toStepState))
      }
    }),
  )

  // Wire trace collector to event bus
  if (traceCollector) {
    const traceUnsubs = traceCollector.subscribeToEvents(eventBus)
    eventUnsubs.push(...traceUnsubs)
  }

  // Initialize step display
  callbacks.onSteps(queue.steps.map(toStepState))

  // Build executor
  let executor: StepExecutor | null = null
  let disposed = false

  // Hoisted refs so injectMessage can access them outside run()
  const stdinHandleRef: { current: StdinHandle | null } = { current: null }
  const pendingInjection: { current: string | null } = { current: null }

  // Pool refs — created inside run(), shut down in dispose()
  let dispatcherPool: WarmPool<SpawnResult> | null = null
  let evaluatorPool: WarmPool<SpawnResult> | null = null
  let subprocessPool: WarmPool<RawSpawnedProcess> | null = null

  async function run(): Promise<WorkflowResult> {
    // Create warm pools for dispatcher, evaluator, and subprocess (session-scoped)
    const pools = createWarmPools(deps, projectCwd, subprocessCwd)
    dispatcherPool = pools.dispatcher
    evaluatorPool = pools.evaluator
    subprocessPool = pools.subprocess

    const stdinFormatter = (text: string) => formatStdinMessage(deps.engine.metadata.id, text)

    const { dispatcherTransport, evaluatorTransport } = resolveTransports(
      deps, eventBus, workflowIdRef, "", sessionId, projectCwd,
      undefined, // evaluatorSystemPromptAddendum
      { dispatcherPool, evaluatorPool: evaluatorPool ?? undefined, formatStdinMessage: stdinFormatter },
    )

    const contextIndexer = opts.overrides?.contextIndexer ?? new ContextIndexer(projectCwd)

    // Create trace event handler (gated by tracing config)
    const traceEventHandler = deps.config.tracing.enabled
      ? createTraceEventHandler({ emitter, workflowIdRef })
      : null

    const execDeps = buildExecutorDeps({
      deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
      contextIndexer, projectCwd, subprocessCwd, sessionObjective: description, queue, sessionId,
      stdinHandleRef,
      setShellQueueSteps: () => {},
      capturedSubprocessSessionId: { current: undefined },
      pendingInjection,
      activeSessionRef: { current: null },
      budgetTracker,
      traceEventHandler,
      transcriptWriter,
      subprocessPool,
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
      handoffReader: execDeps.handoffReader,
      budgetChecker: { isExhausted: () => false },
      persist: async (q) => { try { await persistence.save(q) } catch { /* best-effort */ } },
      accumulator: execDeps.contextAccumulator,
      maxRevisions: deps.config.max_revisions ?? 1,
      onStepCompleted: execDeps.compositeHook,
      guardrails,
      sessionObjective: description,
      onSubprocessDispatched: () => budgetTracker.incrementInvocations(),
      onSessionName: callbacks.onSessionName,
    })

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
      const handle = stdinHandleRef.current as any
      if (handle.isOpen !== false) {
        try {
          handle.write(formatted)
          return true
        } catch { /* fall through to queuing */ }
      }
    }

    // Queue for turn-boundary injection
    pendingInjection.current = text
    return true
  }

  function cancelShutdown(): void {
    executor?.cancelShutdown()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    clearInterval(metricsTimer)
    eventUnsubs.forEach((u) => u())
    storeUnsub()
    execUnsub?.()
    adapter.disconnect()
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
    await outputFlusher.flush()
    outputFlusher.dispose()
    executor = null
  }

  return { run, pause, abort, injectMessage, cancelShutdown, sessionId, dispose }
}

// ── Helpers ──

function toStepState(s: { id: string; type: string; title: string; status: string }): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}

