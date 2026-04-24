import { createAgentEvaluatorFn } from "../workflows/evaluator/create-agent-evaluator.js"
import type { AskHookServer } from "./ask-hook/server.js"
import { readHandoff } from "../workflows/queue/shared/handoff-reader.js"
import { WorkerHandoffSchema } from "../infra/handoff-schemas.js"
import { createContextAccumulator } from "../workflows/queue/context-accumulator.js"
import { createCompositeHook, type OnStepCompletedHook } from "../workflows/queue/shared/hooks.js"
import { resolveTierConfigs } from "./config/schema.js"
import { validateResolvedModels } from "./config/model-tiers.js"
import { createStepExecutor } from "../workflows/queue/executor.js"
import type { StepExecutor } from "../workflows/queue/executor-types.js"
import { createQueuePersistence } from "../workflows/queue/persistence.js"
import { createGuardrails } from "../workflows/queue/guardrails.js"
import { ContextIndexer } from "./memory/indexer.js"
import { createPostTurnVerificationHook } from "../workflows/queue/post-turn-verification.js"
import { createSprintHook } from "../workflows/queue/steps/sprint/hooks.js"
import { SPRINT_HINT } from "../workflows/queue/steps/sprint/types.js"
import { SPRINT_EVALUATOR_ADDENDUM } from "../workflows/queue/steps/sprint/prompts.js"
import { createWorkerCallback } from "./worker-callback.js"
import { createDispatcherCallback } from "./dispatcher-callback.js"
import { createEngineDispatcherTransport, createEngineEvaluatorTransport } from "./engine-transports.js"
import { createClaudeWarmPools } from "./engines/providers/claude/pool/create-warm-pools.js"
import { createPooledDispatcherTransport, createPooledEvaluatorTransport } from "./engines/providers/claude/pool/pooled-transports.js"
import { createObserverChain, createToolFailureObserver, createBudgetAwarenessObserver, createContextPressureObserver } from "./engines/stream-observers.js"
import { DEFAULT_BUDGET } from "../workflows/schemas.js"
import { createDoomLoopObserver } from "./engines/doom-loop.js"
import { mapNDJSONToEngineEvents } from "./engines/ndjson-event-mapper.js"
import { createEmit, type EventBus, type Unsubscribe } from "../infra/event-bus.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { getEngine } from "./engines/core/registry.js"
import type { Engine } from "./engines/core/types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import type { InjectionQueue } from "./injection-queue.js"
import type { Queue } from "../workflows/queue/types.js"
import { wireSessionSubscribers, type MetricsWriter, type SessionInfra } from "./session/create-session-infra.js"

const log = Log.create({ service: "executor-factory" })

interface CreateExecutorInput {
  deps: WorkflowDeps
  eventBus: EventBus
  workflowId: string
  sessionId: string
  queue: Queue
  projectCwd: string
  workerCwd?: string
  infra: Pick<SessionInfra, "budgetTracker" | "transcriptWriter" | "traceCollector">
  injectionQueue: InjectionQueue
  chatContext?: string
  metricsWriter?: MetricsWriter
  askHookServer?: AskHookServer | null
}

interface CreateExecutorResult {
  executor: StepExecutor
  pools: { shutdown(): Promise<void> } | null
  eventUnsubs: Unsubscribe[]
}

export async function createExecutor(input: CreateExecutorInput): Promise<CreateExecutorResult> {
  const {
    deps, eventBus, workflowId, sessionId, queue,
    projectCwd, workerCwd, infra,
    injectionQueue, chatContext,
  } = input
  const emit = createEmit(eventBus)
  const { budgetTracker } = infra

  const eventUnsubs: Unsubscribe[] = []

  const isSprint = queue.steps.some((s) => s.dispatcherHint === SPRINT_HINT)
  const externalHooks: OnStepCompletedHook[] = []
  if (isSprint) {
    const { hook } = createSprintHook(deps.config.sprint)
    externalHooks.push(hook)
  }

  const evaluatorAddendum = isSprint ? SPRINT_EVALUATOR_ADDENDUM : undefined

  const tiers = resolveTierConfigs(deps.config)

  const dispatcherEngine = getEngine(tiers.dispatcher.engine)
  const evaluatorEngine = getEngine(tiers.evaluator.engine)
  const workerEngine = getEngine(tiers.worker.engine)

  const dispatcherModel = tiers.dispatcher.model
  const evaluatorModel = tiers.evaluator.model
  const workerModel = tiers.worker.model

  const validationErrors = validateResolvedModels([
    { component: "dispatcher", model: dispatcherModel, engineId: dispatcherEngine.metadata.id },
    { component: "evaluator", model: evaluatorModel, engineId: evaluatorEngine.metadata.id },
    { component: "worker", model: workerModel, engineId: workerEngine.metadata.id },
  ], deps.auth)
  if (validationErrors.length > 0) {
    const details = validationErrors.map(e => `  ${e.component} (${e.model}): ${e.issue}`).join("\n")
    throw new Error(`Model configuration errors:\n${details}`)
  }

  const pools = (dispatcherEngine.metadata.supportsPooling || evaluatorEngine.metadata.supportsPooling)
    ? createClaudeWarmPools({
        cwd: projectCwd,
        dispatcher: dispatcherEngine.metadata.supportsPooling
          ? {
              model: dispatcherModel, effort: tiers.dispatcher.effort,
              onEvent: (event) => emit("dispatcher:ndjson", { workflowId, ndjsonEvent: event }),
            }
          : undefined,
        evaluator: evaluatorEngine.metadata.supportsPooling
          ? {
              model: evaluatorModel, effort: tiers.evaluator.effort,
              onEvent: (event) => emit("evaluator:ndjson", { workflowId, ndjsonEvent: event }),
            }
          : undefined,
      })
    : null

  const dispatcherTransport = pools?.dispatcher
    ? createPooledDispatcherTransport({ pool: pools.dispatcher, sessionId, projectCwd })
    : createEngineDispatcherTransport({
        engine: dispatcherEngine, sessionId, projectCwd,
        model: dispatcherModel, effort: tiers.dispatcher.effort,
        emit, workflowId,
        auth: deps.auth,
      })

  const evaluatorTransport = pools?.evaluator
    ? createPooledEvaluatorTransport({ pool: pools.evaluator, sessionId, projectCwd, systemPromptAddendum: evaluatorAddendum })
    : createEngineEvaluatorTransport({
        engine: evaluatorEngine, sessionId, projectCwd,
        model: evaluatorModel, effort: tiers.evaluator.effort,
        systemPromptAddendum: evaluatorAddendum,
        emit, workflowId,
        auth: deps.auth,
      })

  const contextIndexer = new ContextIndexer(projectCwd)
  await contextIndexer.startIndexing()

  const budgetAwareness = createBudgetAwarenessObserver(() => {
    const { max_invocations, max_tokens } = DEFAULT_BUDGET
    if (max_invocations === 0 && max_tokens === 0) return null
    return {
      remainingCalls: max_invocations > 0 ? Math.max(0, max_invocations - budgetTracker.getInvocationsUsed()) : Infinity,
      remainingTokens: max_tokens > 0 ? Math.max(0, max_tokens - budgetTracker.getTokensUsed()) : Infinity,
    }
  })
  const contextPressure = createContextPressureObserver(() =>
    budgetTracker.getContextUtilization().percent,
  )

  const observerChain = createObserverChain([
    createDoomLoopObserver(),
    createToolFailureObserver(),
    budgetAwareness,
    contextPressure,
  ])

  eventUnsubs.push(...wireSessionSubscribers(eventBus, emit, workflowId, infra, input.metricsWriter))

  eventUnsubs.push(
    eventBus.subscribeToType("engine:ndjson", (e) => {
      for (const engineEvent of mapNDJSONToEngineEvents(e.ndjsonEvent)) {
        observerChain.onEvent(engineEvent)
      }
    }),
  )

  const postTurnVerification = createPostTurnVerificationHook({
    checkGitDiff: true,
    maxFixAttempts: 2,
    projectCwd,
  })

  const contextAccumulator = createContextAccumulator({
    windowSize: 3,
  })
  const evaluator = createAgentEvaluatorFn(evaluatorTransport)
  const compositeHook = createCompositeHook([...externalHooks])
  const dispatcherFn = createDispatcherCallback({
    maxRevisions: deps.config.max_revisions, emit, workflowId,
    dispatcherTransport,
    contextIndexer,
    contextAccumulator, projectCwd,
    queue,
    workerModel,
    dispatcherModel,
    chatContext,
  })
  const workerFn = createWorkerCallback({
    engine: workerEngine,
    auth: deps.auth,
    model: workerModel,
    effort: tiers.worker.effort,
    emit, workflowId,
    sessionId, projectCwd,
    workerCwd,
    injectionQueue,
    observerChain,
    askHookServer: input.askHookServer,
  })
  const handoffReader = async (handoffPath: string) => {
    if (!handoffPath) return null
    try {
      const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
      return handoff as Record<string, unknown>
    } catch (err) {
      log.warn("handoff read failed, continuing without handoff", {
        path: handoffPath,
        error: errorMessage(err),
      })
      return null
    }
  }

  const guardrails = createGuardrails({
    maxQueueLength: deps.config.queue?.max_steps ?? 50,
    maxMutationsPerStepCompletion: 3,
    maxInsertedStepsPerSession: 20,
  })

  const persistence = createQueuePersistence({ sessionId, baseDir: projectCwd })

  const executor = createStepExecutor({
    queue,
    workflowId,
    sessionId,
    emit,
    dispatcher: dispatcherFn,
    worker: workerFn,
    evaluator,
    skipEvaluation: deps.config.skip_evaluation ?? false,
    handoffReader,
    persist: async (q) => { await persistence.save(q) },
    accumulator: contextAccumulator,
    maxRevisions: deps.config.max_revisions ?? 1,
    onStepCompleted: compositeHook,
    guardrails,
    onWorkerInvoked: () => budgetTracker.incrementInvocations(),
    postTurnVerification,
  })

  return {
    executor,
    pools,
    eventUnsubs,
  }
}
