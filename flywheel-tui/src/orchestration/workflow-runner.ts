/**
 * Workflow Runner — full executor lifecycle: setup, execution, pause, abort, cleanup.
 * Pure orchestration logic with callback-based notifications.
 */

import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { createExecutor } from "./executor-factory"
import type { StepExecutor } from "../workflows/queue/executor-types"
import { createOutputPersistence } from "./session/output-persistence"
import { createSessionInfra } from "./session/create-session-infra"
import { disposeSessionResources, type SessionResources } from "./session/resources"
import { createWorkflowSession, destroyWorkflowSession, type WorkflowSessionFactories } from "./workflow-session"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus"
import type { WarmPool } from "./engines/pool/warm-pool"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline"
import { randomUUID } from "node:crypto"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import { InjectionQueue } from "./engines/subprocess/injection-queue"
import type { SpawnResult } from "./engines/subprocess/spawner"
import type { Queue } from "../workflows/queue/types"
import { toBudgetLimits } from "../workflows/schemas"
import type { AnyBlock } from "../infra/output-blocks"
import type { SessionRunner } from "./session-runner"
import { generateSessionTitle } from "./session-title"
import "../workflows/queue/steps/register-all"


// ── Types ──

export type StepState = {
  id: string; type: string; title: string; status: string
  durationMs?: number; startedAt?: number; completedAt?: number
}

/** Function to update a session entry in the reactive store. */
type UpdateEntryFn = (sessionId: string, patch: Partial<import("./session-store-types").WorkflowSessionEntry>) => void

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
  /** Pre-computed workflow deps — avoids redundant config/engine/spawner creation. */
  workflowDeps?: import("./engines/workflow-deps").WorkflowDeps
  /** Recent chat conversation preceding this workflow. */
  chatContext?: string
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
 * @param opts.updateEntry - Function to write updates directly to the reactive session store
 * @param opts.priorBlocks - Output blocks from a previous run (for resume — prepended to new output)
 */
export function createWorkflowRunner(opts: {
  sessionId: string
  queue: Queue
  description: string
  updateEntry: UpdateEntryFn
  factories: WorkflowSessionFactories
  priorBlocks?: AnyBlock[]
  overrides?: WorkflowRunnerOverrides
}): WorkflowRunner {
  const { sessionId, queue, description, updateEntry, priorBlocks } = opts
  const projectCwd = opts.overrides?.projectCwd ?? process.cwd()
  const subprocessCwd = opts.overrides?.subprocessCwd

  const deps = opts.overrides?.workflowDeps ?? prepareWorkflowDeps()

  // Output persistence — set up BEFORE session so the adapter captures the wrapper
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let currentBlocks: readonly AnyBlock[] = []
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks)

  // Persistence-aware updateEntry: prepends priorBlocks and schedules disk persistence.
  const priorBlocksPrefix = priorBlocks ?? []
  const wrappedUpdateEntry = (patch: Partial<import("./session-store-types").WorkflowSessionEntry>) => {
    if (patch.outputBlocks) {
      currentBlocks = priorBlocksPrefix.length > 0
        ? priorBlocksPrefix.concat(patch.outputBlocks)
        : patch.outputBlocks
      updateEntry(sessionId, { ...patch, outputBlocks: currentBlocks })
      outputFlusher.schedule()
      return
    }
    updateEntry(sessionId, patch)
  }

  // Session resources (timer, adapter, event bus)
  const session = createWorkflowSession({
    description,
    engineMetadata: deps.engine.metadata,
    factories: opts.factories,
    updateEntry: wrappedUpdateEntry,
  })
  const { eventBus } = session
  const emit = createEmit(eventBus)
  const workflowId = randomUUID()

  // Shared session infrastructure (budget, traces, transcripts)
  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config: deps.config,
    description,
    emitter: emit,
    workflowId,
    budgetLimits: toBudgetLimits(deps.config.budget),
  })
  const { budgetTracker, traceWriter, transcriptWriter, traceCollector } = infra
  let traceFinalized = false

  // Wire event subscriptions: step events write directly to session store.
  // Metrics propagation (budget:metrics-changed → store) is handled by
  // wireSessionSubscribers in executor-factory via metricsWriter.
  const eventUnsubs: Unsubscribe[] = []
  eventUnsubs.push(
    eventBus.subscribeToType("queue:step-started", (event) => {
      updateEntry(sessionId, {
        steps: queue.steps.map((s) => ({
          ...toStepState(s),
          ...(s.id === event.stepId ? { status: "running", startedAt: Date.now() } : {}),
        })),
      })
    }),
    eventBus.subscribeToType("queue:step-completed", () => {
      updateEntry(sessionId, { steps: queue.steps.map(toStepState) })
    }),
    eventBus.subscribeToType("queue:step-failed", () => {
      updateEntry(sessionId, { steps: queue.steps.map(toStepState) })
    }),
  )

  // Initialize step display
  updateEntry(sessionId, { steps: queue.steps.map(toStepState) })

  let executor: StepExecutor | null = null
  let disposed = false

  // InjectionQueue — constructed here (after prepareWorkflowDeps) so injectMessage can access it outside run()
  const injectionQueue = new InjectionQueue(
    formatStdinMessage,
  )

  // Pool refs — created inside run(), shut down in dispose()
  let dispatcherPool: WarmPool<SpawnResult> | null = null
  let evaluatorPool: WarmPool<SpawnResult> | null = null
  let subprocessPool: WarmPool<RawSpawnedProcess> | null = null

  async function run(): Promise<WorkflowResult> {
    // Build the full executor (sprint hooks, pools, transports, observers, wiring, guardrails, persistence)
    const created = await createExecutor({
      deps, emit, eventBus, workflowId, sessionId, queue, description,
      projectCwd, subprocessCwd, infra, injectionQueue,
      chatContext: opts.overrides?.chatContext,
      metricsWriter: (patch) => updateEntry(sessionId, patch),
    })
    executor = created.executor
    dispatcherPool = created.pools.dispatcher
    evaluatorPool = created.pools.evaluator
    subprocessPool = created.pools.subprocess
    eventUnsubs.push(...created.eventUnsubs)

    // Generate session title via haiku in parallel — doesn't block execution
    generateSessionTitle(
      description,
      (title) => updateEntry(sessionId, { description: title }),
      { engine: deps.engine, spawner: deps.spawner, projectCwd },
    )

    const result = await executor.run()

    // Finalize trace with result status
    if (traceCollector && !traceFinalized) {
      traceFinalized = true
      traceCollector.finalize(result.completed ? "ok" : "error")
    }

    // Final step states
    updateEntry(sessionId, { steps: queue.steps.map(toStepState) })

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
    const ok = injectionQueue.deliverOrEnqueue(text, true)
    if (ok) {
      emit("subprocess:injected", { workflowId, message: text, origin: "user", pending: true })
    }
    return ok
  }

  function cancelShutdown(): void {
    executor?.cancelShutdown()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // 1. Unsubscribe event listeners
    eventUnsubs.forEach((u) => u())

    // 2. Shut down warm pools
    await Promise.all([
      dispatcherPool?.shutdown(),
      evaluatorPool?.shutdown(),
      subprocessPool?.shutdown(),
    ])
    dispatcherPool = null
    evaluatorPool = null
    subprocessPool = null

    // 3. Unified resource disposal (finalize → flush → dispose)
    //    If traces were already finalized in run(), pass null traceCollector
    //    to skip double-finalize. For the abort path, pass the collector so
    //    open spans get closed with "error" status.
    const resources = {
      budgetTracker,
      traceWriter,
      transcriptWriter,
      traceCollector: traceFinalized ? null : traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, traceFinalized ? "ok" : "error")

    // 4. Destroy reactive root LAST (per P1 Finding 1)
    destroyWorkflowSession(session)
    executor = null
  }

  return { run, pause, abort, injectMessage, cancelShutdown, sessionId, dispose }
}

// ── Helpers ──

function toStepState(s: { id: string; type: string; title: string; status: string }): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}

