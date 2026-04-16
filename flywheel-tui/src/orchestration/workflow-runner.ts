import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { createExecutor } from "./executor-factory.js"
import type { StepExecutor } from "../workflows/queue/executor-types.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { createSessionInfra } from "./session/create-session-infra.js"
import { disposeSessionResources } from "./session/resources.js"
import type { WorkflowSessionFactories } from "./session-store-types.js"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus.js"
import { randomUUID } from "node:crypto"
import { InjectionQueue } from "./injection-queue.js"
import type { Queue, StepStatus, Step } from "../workflows/queue/types.js"
import { toBudgetLimits } from "../workflows/schemas.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { WorkflowSessionEntry } from "./session-store-types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import { generateSessionTitle } from "./session-title.js"


export type StepState = {
  id: string; type: Step["type"]; title: string; status: StepStatus
  durationMs?: number; startedAt?: number; completedAt?: number
}

type UpdateEntryFn = (sessionId: string, patch: Partial<WorkflowSessionEntry>) => void

export interface WorkflowResult {
  completed: boolean
  stepsCompleted: number
  stepsTotal: number
  cost: number
  tokens: number
  reason?: string
}

interface WorkflowRunnerOverrides {
  projectCwd?: string
  /** Override the worker cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the worker process runs here. */
  workerCwd?: string
  /** Pre-computed workflow deps — avoids redundant config/engine/spawner creation. */
  workflowDeps?: WorkflowDeps
  /** Recent chat conversation preceding this workflow. */
  chatContext?: string
}

export interface WorkflowRunner {
  run(): Promise<WorkflowResult>
  pause(): void
  abort(): void
  injectMessage(text: string): boolean
  cancelShutdown(): void
  readonly sessionId: string
  dispose(): Promise<void>
}

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
  const workerCwd = opts.overrides?.workerCwd

  // Why fallback: the controller always injects workflowDeps, but the runner
  // self-resolves as a safety net (fresh config read from disk per session).
  const deps = opts.overrides?.workflowDeps ?? prepareWorkflowDeps()

  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  // Why a local copy instead of reading from the store: the flusher's
  // getBlocks callback fires on a schedule, and coupling it to the reactive
  // store proxy would require a reactive scope. The local variable is always
  // written in the same code path that writes the store, so they stay in sync.
  let currentBlocks: readonly AnyBlock[] = []
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks)

  // Why not shared with chat-runner: workflow adds persistence scheduling and
  // currentBlocks tracking; chat does neither. The 3 shared lines of priorBlocks
  // prepending don't justify an abstraction over the runner-specific extensions.
  const priorBlocksPrefix = priorBlocks ?? []
  const wrappedUpdateEntry = (patch: Partial<WorkflowSessionEntry>) => {
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

  const adapter = opts.factories.createAdapter({ updateEntry: wrappedUpdateEntry, engineMetadata: deps.engine.metadata })
  const eventBus = new EventBus()
  adapter.connect(eventBus)
  const emit = createEmit(eventBus)
  const workflowId = randomUUID()

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

  updateEntry(sessionId, { steps: queue.steps.map(toStepState) })

  let executor: StepExecutor | null = null
  let pools: { shutdown(): Promise<void> } | null = null
  let disposed = false

  const injectionQueue = new InjectionQueue()

  async function run(): Promise<WorkflowResult> {
    const created = await createExecutor({
      deps, eventBus, workflowId, sessionId, queue,
      projectCwd, workerCwd, infra, injectionQueue,
      chatContext: opts.overrides?.chatContext,
      metricsWriter: (patch) => updateEntry(sessionId, patch),
    })
    executor = created.executor
    pools = created.pools
    eventUnsubs.push(...created.eventUnsubs)

    generateSessionTitle(
      description,
      (title) => updateEntry(sessionId, { description: title }),
      { engine: deps.engine, projectCwd },
    )

    const result = await executor.run()

    if (traceCollector && !traceFinalized) {
      traceFinalized = true
      traceCollector.finalize(result.completed ? "ok" : "error")
    }

    updateEntry(sessionId, { steps: queue.steps.map(toStepState) })

    budgetTracker.flush()
    return {
      ...result,
      cost: budgetTracker.getTotalCost(),
      tokens: budgetTracker.getTokensUsed(),
    }
  }

  function pause(): void {
    executor?.requestShutdown()
  }

  function abort(): void {
    executor?.abort()
  }

  function injectMessage(text: string): boolean {
    injectionQueue.enqueue(text, true)
    emit("engine:injected", { workflowId, message: text, origin: "user", pending: true })
    return true
  }

  function cancelShutdown(): void {
    executor?.cancelShutdown()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    eventUnsubs.forEach((u) => u())

    await pools?.shutdown()

    // Pass null traceCollector if already finalized in run() to skip double-finalize.
    // For the abort path, pass the collector so open spans close with "error" status.
    const resources = {
      budgetTracker,
      traceWriter,
      transcriptWriter,
      traceCollector: traceFinalized ? null : traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, traceFinalized ? "ok" : "error")

    adapter.disconnect()
    executor = null
  }

  return { run, pause, abort, injectMessage, cancelShutdown, sessionId, dispose }
}

function toStepState(s: Step): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}

