/**
 * Queue orchestrator — pure functions for resolving transports and building
 * executor dependencies. Extracted from flywheel-shell.tsx to reduce its size.
 *
 * These functions take all dependencies as parameters (no SolidJS signals).
 */

import { PooledSubprocessTransport } from "../workflows/dispatcher/subprocess-transport"
import { PooledSubprocessEvaluatorTransport } from "../workflows/evaluator/subprocess-transport"
import { createAgentEvaluatorFn } from "../workflows/evaluator/create-agent-evaluator"
import { readHandoff } from "../workflows/queue/shared/handoff-reader"
import { SubprocessHandoffSchema } from "../infra/handoff-schemas"
import { createContextAccumulator } from "../workflows/queue/context-accumulator"
import { createCompositeHook } from "../workflows/queue/shared/hooks"
import "../workflows/queue/steps/register-all"
import { resolveTierConfigs } from "./config/schema"
import { type EmitFn } from "../infra/event-bus"
import { Log } from "../infra/log"
import { errorMessage } from "../infra/error-message"
import { ContextIndexer } from "./memory/indexer"
import { createSubprocessCallback } from "./subprocess-callback"
import { createDispatcherCallback } from "./dispatcher-callback"
import type { WarmPool } from "./engines/pool/warm-pool"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { EventBus } from "../infra/event-bus"
import type { Queue } from "../workflows/queue/types"
import type { InjectionQueue } from "./engines/subprocess/injection-queue"

const log = Log.create({ service: "queue-orchestrator" })

// ── resolveTransports ──

export interface ResolveTransportsInput {
  deps: WorkflowDeps
  eventBus: EventBus
  workflowId: string
  sessionId: string
  baseDir: string
  evaluatorSystemPromptAddendum?: string
  dispatcherPool: WarmPool
  evaluatorPool?: WarmPool
  formatStdinMessage: (text: string) => string
}

/**
 * Resolve dispatcher and evaluator transports for queue execution.
 *
 * Creates PooledSubprocessTransport / PooledSubprocessEvaluatorTransport
 * from the provided warm pools.
 */
export function resolveTransports(input: ResolveTransportsInput) {
  const { deps, eventBus, workflowId, sessionId, baseDir, evaluatorSystemPromptAddendum, dispatcherPool, evaluatorPool, formatStdinMessage: fmtStdin } = input
  const engineName = deps.config.engine

  const dispatcherTransport: import("../workflows/dispatcher/transport").DispatcherTransport = new PooledSubprocessTransport({
    pool: dispatcherPool,
    formatStdinMessage: fmtStdin,
    sessionId,
    baseDir,
    onStdout: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
    onStderr: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
  })
  log.info("queue dispatcher transport resolved", { label: "pooled", engine: engineName })

  // Always create evaluator transport when pool is available — the step-runner
  // decides whether to invoke it based on skipEvaluation + post-turn results.
  let evaluatorTransport: import("../workflows/evaluator/transport").EvaluatorTransport | undefined
  if (evaluatorPool) {
    evaluatorTransport = new PooledSubprocessEvaluatorTransport({
      pool: evaluatorPool,
      formatStdinMessage: fmtStdin,
      sessionId,
      baseDir,
      systemPromptAddendum: evaluatorSystemPromptAddendum,
      onStdout: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
      onStderr: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
    })
    log.info("queue evaluator transport created", { label: "pooled", engine: engineName })
  }

  return { dispatcherTransport, evaluatorTransport }
}

// ── buildExecutorDeps ──

/** Infrastructure plumbing: workflow deps, event system, identity. */
export interface ExecutorInfra {
  deps: WorkflowDeps;
  emit: EmitFn;
  eventBus: EventBus;
  workflowId: string;
  sessionId: string;
}

/** Transport layer: dispatcher, evaluator, subprocess pool, observers. */
export interface ExecutorTransports {
  dispatcherTransport?: import("../workflows/dispatcher/transport").DispatcherTransport;
  evaluatorTransport?: import("../workflows/evaluator/transport").EvaluatorTransport;
  /** Pre-warmed subprocess pool for raw process spawning. */
  subprocessPool?: WarmPool<RawSpawnedProcess> | null;
  /** Observer chain for stream observers — created by workflow-runner, fed via EventBus.
   *  Passed to subprocess-callback for per-step reset and turn-complete injection. */
  observerChain?: { onTurnComplete(): string[]; reset(): void };
}

/** Execution context: queue, paths, indexer, objective. */
export interface ExecutorContext {
  queue: Queue;
  projectCwd: string;
  /** Override the subprocess cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  subprocessCwd?: string;
  contextIndexer: ContextIndexer;
  sessionObjective?: string;
}

/** Optional extensions: injection, seeding, hooks. */
export interface ExecutorExtensions {
  /** Injection queue for turn-boundary message delivery. */
  injectionQueue: InjectionQueue;
  /** Pre-seed context accumulator with fixture handoff (for /test command). */
  seedHandoff?: Record<string, unknown> | null;
  /** Recent chat conversation preceding this workflow (forwarded to dispatcher input). */
  chatContext?: string;
  /** External hooks to include in the composite step-completed hook.
   *  Caller-provided (e.g. sprint hook from workflow-runner). */
  externalHooks?: Array<import("../workflows/queue/shared/hooks").OnStepCompletedHook>;
}

/**
 * Build the shared executor dependencies (dispatcher, accumulator, evaluator,
 * hooks, subprocess callback, handoff reader) from 4 composable sub-objects.
 *
 * The 4-interface split (Infra, Transports, Context, Extensions) is intentional
 * Interface Segregation (ADR-006): callers assemble only the slices they own,
 * and each interface can be satisfied independently in tests.
 */
export function buildExecutorDeps(
  infra: ExecutorInfra,
  transports: ExecutorTransports,
  context: ExecutorContext,
  extensions: ExecutorExtensions,
) {
  const tiers = resolveTierConfigs(infra.deps.config)

  // Context accumulator (windowed detail strategy)
  const contextAccumulator = createContextAccumulator({
    windowSize: infra.deps.config.dispatcher_intelligence?.handoff_detail_window ?? 3,
  })
  if (extensions.seedHandoff) {
    contextAccumulator.accumulate(extensions.seedHandoff)
  }

  // Agent-based evaluator — always created when transport is available.
  // The step-runner decides whether to invoke it based on skipEvaluation + post-turn results.
  const evaluator = transports.evaluatorTransport
    ? createAgentEvaluatorFn({ transport: transports.evaluatorTransport })
    : null

  // Composite hook (extensible — includes caller-provided hooks like sprint hook)
  const compositeHook = createCompositeHook([...(extensions.externalHooks ?? [])])

  // Dispatcher callback (real dispatcher with fallback to step metadata)
  const dispatcherFn = createDispatcherCallback({
    deps: infra.deps, emit: infra.emit, workflowId: infra.workflowId,
    dispatcherTransport: transports.dispatcherTransport,
    contextIndexer: context.contextIndexer,
    contextAccumulator, projectCwd: context.projectCwd,
    sessionObjective: context.sessionObjective, queue: context.queue,
    dispatcherModel: tiers.dispatcher.model, subprocessModel: tiers.subprocess.model,
    chatContext: extensions.chatContext,
  })

  // Subprocess callback (spawn engine process — uses pool when available)
  // Budget, tracing, and transcript are handled by EventBus subscribers wired
  // in workflow-runner.ts — subprocess-callback only emits subprocess:ndjson.
  const subprocessFn = createSubprocessCallback({
    deps: infra.deps, emit: infra.emit, workflowId: infra.workflowId,
    sessionId: infra.sessionId, projectCwd: context.projectCwd,
    subprocessCwd: context.subprocessCwd,
    injectionQueue: extensions.injectionQueue,
    eventBus: infra.eventBus,
    observerChain: transports.observerChain,
    subprocessPool: transports.subprocessPool,
  })

  // Handoff reader callback
  const handoffReader = async (handoffPath: string) => {
    if (!handoffPath) return null
    try {
      const handoff = await readHandoff(handoffPath, SubprocessHandoffSchema)
      return handoff as unknown as Record<string, unknown>
    } catch (err) {
      log.warn("handoff read failed, continuing without handoff", {
        path: handoffPath,
        error: errorMessage(err),
      })
      return null
    }
  }

  return {
    contextAccumulator,
    evaluator,
    compositeHook,
    dispatcherFn,
    subprocessFn,
    handoffReader,
  }
}
