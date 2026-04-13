import { resolveTransports, buildExecutorDeps } from "./queue-orchestrator"
import { createStepExecutor } from "../workflows/queue/executor"
import type { StepExecutor } from "../workflows/queue/executor-types"
import { createQueuePersistence } from "../workflows/queue/persistence"
import { createGuardrails } from "../workflows/queue/guardrails"
import { ContextIndexer } from "./memory/indexer"
import { createWarmPools } from "./engines/pool/create-warm-pools"
import type { WarmPool } from "./engines/pool/warm-pool"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"
import { createPostTurnVerificationHook } from "../workflows/queue/post-turn-verification"
import { createSprintHook } from "../workflows/queue/steps/sprint/hooks"
import { SPRINT_HINT } from "../workflows/queue/steps/sprint/types"
import type { OnStepCompletedHook } from "../workflows/queue/shared/hooks"
import { createObserverChain, createToolFailureObserver, createNoActionObserver } from "./engines/stream-observers"
import { createDoomLoopObserver } from "./engines/doom-loop"
import { mapNDJSONToEngineEvents } from "./engines/subprocess/ndjson-event-mapper"
import type { EmitFn, EventBus, Unsubscribe } from "../infra/event-bus"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { InjectionQueue } from "./engines/subprocess/injection-queue"
import type { SpawnResult } from "./engines/subprocess/spawner"
import type { Queue } from "../workflows/queue/types"
import { wireSessionSubscribers, type MetricsWriter } from "./session/create-session-infra"

export interface CreateExecutorInput {
  /** Prepared workflow deps (config, engine, etc.) */
  deps: WorkflowDeps
  /** Typed event emitter */
  emit: EmitFn
  /** EventBus for subscriber wiring */
  eventBus: EventBus
  /** Unique workflow identifier */
  workflowId: string
  /** Session ID */
  sessionId: string
  /** Queue to execute */
  queue: Queue
  /** Human-readable session description (used as session objective) */
  description: string
  /** Project working directory */
  projectCwd: string
  /** Override subprocess cwd (for /test, worktrees) */
  subprocessCwd?: string
  /** Session infrastructure (budget, transcript, tracing) — created by the runner. */
  infra: Pick<import("./session/create-session-infra").SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">
  /** Injection queue for turn-boundary message delivery */
  injectionQueue: InjectionQueue
  /** Optional context indexer override */
  contextIndexer?: ContextIndexer
  /** Recent chat conversation preceding this workflow. */
  chatContext?: string
  /** Callback to write budget metrics to the session store. */
  metricsWriter?: MetricsWriter
}

export interface CreateExecutorResult {
  /** The step executor, ready to run */
  executor: StepExecutor
  /** Warm pools — caller must shut these down on dispose */
  pools: {
    dispatcher: WarmPool<SpawnResult> | null
    evaluator: WarmPool<SpawnResult> | null
    subprocess: WarmPool<RawSpawnedProcess> | null
  }
  /** EventBus unsubscribe functions for all wired subscribers */
  eventUnsubs: Unsubscribe[]
}

export async function createExecutor(input: CreateExecutorInput): Promise<CreateExecutorResult> {
  const {
    deps, emit, eventBus, workflowId, sessionId, queue, description,
    projectCwd, subprocessCwd, infra,
    injectionQueue, contextIndexer: contextIndexerOverride, chatContext,
  } = input
  const { budgetTracker } = infra

  const eventUnsubs: Unsubscribe[] = []

  const isSprint = queue.steps.some((s) => s.dispatcherHint === SPRINT_HINT)
  const externalHooks: OnStepCompletedHook[] = []
  if (isSprint) {
    const { hook } = createSprintHook(deps.config.sprint)
    externalHooks.push(hook)
  }

  const pools = createWarmPools(deps, projectCwd, subprocessCwd, isSprint ? "sprint" : undefined)
  const dispatcherPool = pools.dispatcher
  const evaluatorPool = pools.evaluator
  const subprocessPool = pools.subprocess

  const evaluatorAddendum = isSprint
    ? "You are evaluating sprint mode work. Evaluate against the 7-point self-review checklist " +
      "(diff review, task alignment, completeness, test coverage, regression, edge cases, elegance). " +
      "PASS work that meets the task requirements. " +
      "Only FAIL for hard evidence: tests failing, critical deliverables missing, or fundamentally broken output."
    : undefined

  const { dispatcherTransport, evaluatorTransport } = resolveTransports({
    deps, emit, workflowId, sessionId, baseDir: projectCwd,
    evaluatorSystemPromptAddendum: evaluatorAddendum,
    dispatcherPool, evaluatorPool: evaluatorPool ?? undefined, formatStdinMessage,
  })

  const contextIndexer = contextIndexerOverride ?? new ContextIndexer(projectCwd)
  await contextIndexer.startIndexing()

  const observerChain = createObserverChain([
    createDoomLoopObserver(),
    createToolFailureObserver(),
    createNoActionObserver(),
  ])

  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, workflowId, infra, input.metricsWriter))

  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      for (const engineEvent of mapNDJSONToEngineEvents(e.ndjsonEvent)) {
        observerChain.onEvent(engineEvent)
      }
    }),
  )

  const postTurnVerification = createPostTurnVerificationHook({
    nativeCheckTypes: ["build", "test", "has-changes"],
    maxFixAttempts: 2,
    projectCwd,
  })

  const execDeps = buildExecutorDeps(
    { deps, emit, eventBus, workflowId, sessionId },
    { dispatcherTransport, evaluatorTransport, subprocessPool, observerChain },
    { queue, projectCwd, subprocessCwd, contextIndexer, sessionObjective: description },
    { injectionQueue, externalHooks, chatContext },
  )

  const guardrails = createGuardrails({
    maxQueueLength: deps.config.queue?.max_steps ?? 50,
    maxMutationsPerStepCompletion: deps.config.dispatcher_intelligence?.max_mutations_per_step ?? 3,
    maxInsertedStepsPerSession: deps.config.dispatcher_intelligence?.max_inserted_steps ?? 20,
  })

  const persistence = createQueuePersistence({ sessionId, baseDir: projectCwd })

  const executor = createStepExecutor({
    queue,
    workflowId,
    sessionId,
    emit,
    dispatcher: execDeps.dispatcherFn,
    worker: execDeps.subprocessFn,
    evaluator: execDeps.evaluator,
    skipEvaluation: deps.config.skip_evaluation ?? false,
    handoffReader: execDeps.handoffReader,
    persist: async (q) => { try { await persistence.save(q) } catch { /* best-effort */ } },
    accumulator: execDeps.contextAccumulator,
    maxRevisions: deps.config.max_revisions ?? 1,
    onStepCompleted: execDeps.compositeHook,
    guardrails,
    sessionObjective: description,
    onSubprocessDispatched: () => budgetTracker.incrementInvocations(),
    postTurnVerification,
  })

  return {
    executor,
    pools: {
      dispatcher: dispatcherPool,
      evaluator: evaluatorPool,
      subprocess: subprocessPool,
    },
    eventUnsubs,
  }
}
