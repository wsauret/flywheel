import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { createExecutor } from "./executor-factory.js"
import type { StepExecutor } from "../workflows/queue/executor-types.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { createSessionInfra } from "./session/create-session-infra.js"
import { disposeSessionResources } from "./session/resources.js"
import { createAskHookServer, type AskHookServer } from "./ask-hook/server.js"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { CreateWorkflowAdapter } from "./session-store-types.js"
import { EventBus, createEmit, type EmitFn, type Unsubscribe } from "../infra/event-bus.js"
import { randomUUID } from "node:crypto"
import { InjectionQueue } from "./injection-queue.js"
import type { Queue, Step } from "../workflows/queue/types.js"
import { DEFAULT_BUDGET, toBudgetLimits } from "../workflows/schemas.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { WorkflowSessionEntry } from "./session-store-types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import { resolveTierConfigs } from "./config/schema.js"
import { generateSessionTitle } from "./session-title.js"
import type { StepState, WorkflowResult, WorkflowRunner } from "./workflow-runner-types.js"

type UpdateEntryFn = (sessionId: string, patch: Partial<WorkflowSessionEntry>) => void

interface WorkflowRunnerOverrides {
  projectCwd?: string
  workerCwd?: string
  workflowDeps?: WorkflowDeps
  chatContext?: string
}

export function createWorkflowRunner(opts: {
  sessionId: string
  queue: Queue
  description: string
  updateEntry: UpdateEntryFn
  createAdapter: CreateWorkflowAdapter
  priorBlocks?: AnyBlock[]
  overrides?: WorkflowRunnerOverrides
}): WorkflowRunner {
  const { sessionId, queue, description, updateEntry, priorBlocks } = opts
  const projectCwd = opts.overrides?.projectCwd ?? process.cwd()
  const workerCwd = opts.overrides?.workerCwd

  const deps = opts.overrides?.workflowDeps ?? prepareWorkflowDeps()

  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let currentBlocks: readonly AnyBlock[] = []
  const outputFlusher = outputPersistence.createFlusher(() => currentBlocks)

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

  const adapter = opts.createAdapter({ updateEntry: wrappedUpdateEntry, engineMetadata: deps.engine.metadata })
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
    budgetLimits: toBudgetLimits(DEFAULT_BUDGET),
  })
  const { budgetTracker, traceWriter, transcriptWriter, traceCollector } = infra
  let traceFinalized = false

  // Queue is an imperatively-mutated value (not reactive), so three subscribers
  // re-snapshot `queue.steps` on each lifecycle event. This is the idiomatic
  // event → compute → store pattern from ADR-006: the non-reactive domain value
  // is projected into the reactive store via explicit subscribers.
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

  let askHookServer: AskHookServer | null = null

  const injectionQueue = new InjectionQueue()

  async function run(): Promise<WorkflowResult> {
    if (deps.engine.metadata.id === "claude") {
      const socketPath = join(tmpdir(), `flywheel-ask-${sessionId}.sock`)
      askHookServer = await createAskHookServer(socketPath)
    }

    const created = await createExecutor({
      deps, eventBus, workflowId, sessionId, queue,
      projectCwd, workerCwd, infra, injectionQueue,
      chatContext: opts.overrides?.chatContext,
      metricsWriter: (patch) => updateEntry(sessionId, patch),
      askHookServer,
    })
    executor = created.executor
    pools = created.pools
    eventUnsubs.push(...created.eventUnsubs)

    generateSessionTitle(
      description,
      (title) => updateEntry(sessionId, { description: title }),
      { engine: deps.engine, auth: deps.auth, projectCwd, model: resolveTierConfigs(deps.config).worker.model },
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

  function answerQuestion(toolUseId: string, answers: Record<string, string>): void {
    adapter.answerQuestion?.(toolUseId, answers)
    askHookServer?.deliver(toolUseId, answers)
  }

  function cancelQuestion(toolUseId: string): void {
    adapter.cancelQuestion?.(toolUseId)
    askHookServer?.cancel(toolUseId)
  }

  function cancelShutdown(): void {
    executor?.cancelShutdown()
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    eventUnsubs.forEach((u) => u())

    await pools?.shutdown()

    if (askHookServer) {
      try { await askHookServer.close() } catch { /* best-effort */ }
      askHookServer = null
    }

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

  return { run, pause, abort, injectMessage, answerQuestion, cancelQuestion, cancelShutdown, sessionId, dispose }
}

function toStepState(s: Step): StepState {
  return { id: s.id, type: s.type, title: s.title, status: s.status }
}

