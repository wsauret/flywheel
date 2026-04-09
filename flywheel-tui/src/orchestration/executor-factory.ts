/**
 * Executor Factory — extracts the ~100 lines of executor setup from
 * workflow-runner.ts run() into a focused factory function.
 *
 * Creates: sprint hooks, warm pools, transports, context indexer,
 * trace event handler, observer chain, EventBus subscriber wiring,
 * post-turn verification, executor deps, guardrails, persistence,
 * and finally the StepExecutor.
 */

import { resolveTransports, buildExecutorDeps } from "./queue-orchestrator"
import { createStepExecutor, type StepExecutor } from "../workflows/queue/executor"
import { createQueuePersistence } from "../workflows/queue/persistence"
import { createGuardrails } from "../workflows/queue/guardrails"
import { ContextIndexer } from "./memory/indexer"
import { createTraceEventHandler } from "./engines/subprocess/trace-event-handler"
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
import type { BudgetTracker } from "./session/budget-tracker"
import type { TranscriptWriter } from "./session/transcript-writer"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { InjectionQueue } from "./engines/subprocess/injection-queue"
import type { SpawnResult } from "./engines/subprocess/spawner"
import { extractContextUpdate } from "./engines/providers/claude-context"
import type { Queue } from "../workflows/queue/types"


// ── Types ──

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
  /** Budget tracker (already created in the runner) */
  budgetTracker: BudgetTracker
  /** Transcript writer (optional, gated by tracing config) */
  transcriptWriter: TranscriptWriter | null
  /** Injection queue for turn-boundary message delivery */
  injectionQueue: InjectionQueue
  /** Optional context indexer override */
  contextIndexer?: ContextIndexer
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

/**
 * Build the full executor: sprint hooks, warm pools, transports, observers,
 * EventBus wiring, verification, guardrails, persistence, and StepExecutor.
 *
 * Extracted from workflow-runner.ts run() to keep that function focused on
 * execution lifecycle (title generation, running, finalization, cleanup).
 */
export function createExecutor(input: CreateExecutorInput): CreateExecutorResult {
  const {
    deps, emit, eventBus, workflowId, sessionId, queue, description,
    projectCwd, subprocessCwd, budgetTracker, transcriptWriter,
    injectionQueue, contextIndexer: contextIndexerOverride,
  } = input

  const eventUnsubs: Unsubscribe[] = []

  // ── 1. Sprint detection and hook creation ──
  const isSprint = queue.steps.some((s) => s.dispatcherHint === SPRINT_HINT)
  const externalHooks: OnStepCompletedHook[] = []
  if (isSprint) {
    const { hook } = createSprintHook(deps.config.sprint)
    externalHooks.push(hook)
  }

  // ── 2. Warm pool creation ──
  const pools = createWarmPools(deps, projectCwd, subprocessCwd, isSprint ? "sprint" : undefined)
  const dispatcherPool = pools.dispatcher
  const evaluatorPool = pools.evaluator
  const subprocessPool = pools.subprocess

  // ── 3. Stdin formatter ──
  const stdinFormatter = (text: string) => formatStdinMessage(deps.engine.metadata.id, text)

  // ── 4. Sprint evaluator addendum ──
  const evaluatorAddendum = isSprint
    ? "You are evaluating sprint mode work. Evaluate against the 6-point self-review checklist " +
      "(diff review, task alignment, completeness, test coverage, regression, edge cases). " +
      "PASS work that meets the task requirements. " +
      "Only FAIL for hard evidence: tests failing, critical deliverables missing, or fundamentally broken output."
    : undefined

  // ── 5. Transport resolution ──
  const { dispatcherTransport, evaluatorTransport } = resolveTransports(
    deps, eventBus, workflowId, sessionId, projectCwd,
    evaluatorAddendum,
    { dispatcherPool, evaluatorPool: evaluatorPool ?? undefined, formatStdinMessage: stdinFormatter },
  )

  // ── 6. Context indexer ──
  const contextIndexer = contextIndexerOverride ?? new ContextIndexer(projectCwd)

  // ── 7. Trace event handler ──
  const traceEventHandler = deps.config.tracing.enabled
    ? createTraceEventHandler({ emit, workflowId })
    : null

  // ── 8. Observer chain ──
  const observerChain = createObserverChain([
    createDoomLoopObserver(),
    createToolFailureObserver(),
    createNoActionObserver(),
  ])

  // ── 9. Wire EventBus subscribers ──
  // Budget: reset cumulative-cost baselines when a new subprocess spawns
  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:spawned", () => {
      budgetTracker.onNewSubprocess()
    }),
  )
  // Budget tracking: NDJSON events drive cost/token accounting
  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      budgetTracker.handleEvent(e.ndjsonEvent)
    }),
  )
  // Context utilization: extract prompt size / context window from NDJSON events
  // and feed into budget tracker so contextPercent updates for workflow sessions.
  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      const ctxUpdate = extractContextUpdate(e.ndjsonEvent)
      if (ctxUpdate) {
        budgetTracker.updateContextUtilization(ctxUpdate.promptTokens, ctxUpdate.contextWindow)
      }
    }),
  )
  // Tracing: NDJSON events are converted to trace spans
  if (traceEventHandler) {
    eventUnsubs.push(
      eventBus.subscribeToType("subprocess:ndjson", (e) => {
        traceEventHandler.handleEvent(e.ndjsonEvent)
      }),
    )
  }
  // Transcript: raw NDJSON events persisted for analysis
  if (transcriptWriter) {
    eventUnsubs.push(
      eventBus.subscribeToType("subprocess:ndjson", (e) => {
        transcriptWriter.handleEvent(e.ndjsonEvent)
      }),
    )
  }
  // Observers: NDJSON events mapped to engine events, fed to observer chain
  eventUnsubs.push(
    eventBus.subscribeToType("subprocess:ndjson", (e) => {
      for (const engineEvent of mapNDJSONToEngineEvents(e.ndjsonEvent)) {
        observerChain.onEvent(engineEvent)
      }
    }),
  )

  // ── 10. Post-turn verification hook ──
  const postTurnVerification = createPostTurnVerificationHook({
    nativeChecks: true,
    nativeCheckTypes: ["build", "test", "has-changes"],
    selfReview: false,
    maxFixAttempts: 2,
    projectCwd,
  })

  // ── 11. Build executor deps ──
  const execDeps = buildExecutorDeps(
    { deps, emit, eventBus, workflowId, sessionId },
    { dispatcherTransport, evaluatorTransport, subprocessPool, observerChain },
    { queue, projectCwd, subprocessCwd, contextIndexer, sessionObjective: description },
    { injectionQueue, externalHooks },
  )

  // ── 12. Guardrails ──
  const guardrails = createGuardrails({
    maxQueueLength: deps.config.queue?.max_steps ?? 50,
    maxMutationsPerStepCompletion: deps.config.dispatcher_intelligence?.max_mutations_per_step ?? 3,
    maxInsertedStepsPerSession: deps.config.dispatcher_intelligence?.max_inserted_steps ?? 20,
  })

  // ── 13. Persistence ──
  const persistence = createQueuePersistence({ sessionId, baseDir: projectCwd })

  // ── 14. Create step executor ──
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
