/**
 * Workflow Runner
 *
 * Encapsulates the full executor lifecycle: setup, execution, pause, abort, cleanup.
 * The shell creates one runner per workflow and wires its callbacks to signals.
 *
 * No UI imports — pure orchestration logic with callback-based notifications.
 */

import { prepareWorkflowDeps } from "../engines/workflow-deps"
import { buildQueueForSlashCommand } from "./queue-builder"
import { resolveTransports, buildExecutorDeps } from "./queue-orchestrator"
import { createStepExecutor, type StepExecutor, type StepExecutorResult } from "../queue/executor"
import { createQueuePersistence } from "../queue/persistence"
import { createGuardrails } from "../queue/guardrails"
import { createBudgetTracker, type BudgetTracker } from "../session/budget-tracker"
import { createOutputPersistence, type OutputFlusher } from "../session/output-persistence"
import { OpenTUIAdapter } from "../tui/adapters/opentui"
import { createStore as createUIStore } from "../tui/routes/work/context/ui-state/store"
import { EventBus, createFlywheelEmitter, type Unsubscribe } from "../events/event-bus"
import { ContextIndexer } from "../memory/indexer"
import { randomUUID } from "node:crypto"
import { Log } from "../utils/log"
import { formatStdinMessage } from "../worker/stdin-format"
import type { StdinHandle } from "../worker/spawner"
import type { Queue } from "../queue/types"
import type { SessionManager } from "../session/manager"
import type { AnyBlock } from "../tui/types"
import "../queue/steps/register-all"

const log = Log.create({ service: "workflow-runner" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

export interface WorkflowResult {
  completed: boolean
  stepsCompleted: number
  stepsTotal: number
  cost: number
  tokens: number
  reason?: string
}

export interface WorkflowRunner {
  /** Run the executor to completion. Resolves with result. */
  run(): Promise<WorkflowResult>
  /** Graceful pause — finish current step then stop. */
  pause(): void
  /** Force abort — kill worker immediately. */
  abort(): void
  /** Inject a user message into the running worker. Returns true if delivered or queued. */
  injectMessage(text: string): boolean
  /** Cancel a pending shutdown so execution continues after current step. */
  cancelShutdown(): void
  /** The session ID for this workflow. */
  readonly sessionId: string
  /** Clean up all resources. Called automatically after run() resolves. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
}): WorkflowRunner {
  const { sessionId, queue, description, callbacks, priorBlocks } = opts
  const projectCwd = process.cwd()

  // Prepare workflow deps (config, engine, etc.)
  const deps = prepareWorkflowDeps()

  // Event bus + emitter
  const eventBus = new EventBus()
  const emitter = createFlywheelEmitter(eventBus)
  const workflowIdRef = { current: randomUUID() }

  // Budget tracker
  const budgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })

  // Metrics poll
  const metricsTimer = setInterval(() => {
    callbacks.onTokens(budgetTracker.getTokensUsed())
    callbacks.onCost(budgetTracker.getTotalCost())
  }, 500)

  // Structured output pipeline
  const uiActions = createUIStore("workflow")
  uiActions.startWorkflow(description)
  const adapter = new OpenTUIAdapter({ actions: uiActions })
  adapter.connect(eventBus)

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

  // Initialize step display
  callbacks.onSteps(queue.steps.map(toStepState))

  // Build executor
  let executor: StepExecutor | null = null
  let disposed = false

  // Hoisted refs so injectMessage can access them outside run()
  const stdinHandleRef: { current: StdinHandle | null } = { current: null }
  const pendingInjection: { current: string | null } = { current: null }

  async function run(): Promise<WorkflowResult> {
    const { dispatcherTransport, evaluatorTransport } = await resolveTransports(
      deps, eventBus, workflowIdRef, "", sessionId, projectCwd,
    )

    if (!dispatcherTransport) {
      throw new Error("Dispatcher transport unavailable. Check your engine configuration.")
    }

    const contextIndexer = new ContextIndexer(projectCwd)

    const execDeps = buildExecutorDeps({
      deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
      contextIndexer, projectCwd, sessionObjective: description, queue, sessionId,
      stdinHandleRef,
      setShellQueueSteps: () => {},
      capturedWorkerSessionId: { current: undefined },
      pendingInjection,
      activeSessionRef: { current: null },
      budgetTracker,
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
      worker: execDeps.workerFn,
      evaluator: execDeps.evaluator,
      handoffReader: execDeps.handoffReader,
      budgetChecker: { isExhausted: () => false },
      persist: async (q) => { try { await persistence.save(q) } catch { /* best-effort */ } },
      accumulator: execDeps.contextAccumulator,
      maxRevisions: deps.config.max_revisions ?? 1,
      onStepCompleted: execDeps.compositeHook,
      guardrails,
      sessionObjective: description,
      onWorkerDispatched: () => budgetTracker.incrementInvocations(),
      onSessionName: callbacks.onSessionName,
    })

    const result = await executor.run()

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
    adapter.disconnect()
    budgetTracker.dispose()
    await outputFlusher.flush()
    outputFlusher.dispose()
    executor = null
  }

  return { run, pause, abort, injectMessage, cancelShutdown, sessionId, dispose }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStepState(s: { id: string; type: string; title: string; status: string }): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}
