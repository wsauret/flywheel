import { PooledSubprocessTransport } from "../workflows/dispatcher/subprocess-transport.js"
import { PooledSubprocessEvaluatorTransport } from "../workflows/evaluator/subprocess-transport.js"
import { createAgentEvaluatorFn } from "../workflows/evaluator/create-agent-evaluator.js"
import { readHandoff } from "../workflows/queue/shared/handoff-reader.js"
import { SubprocessHandoffSchema } from "../infra/handoff-schemas.js"
import { createContextAccumulator } from "../workflows/queue/context-accumulator.js"
import { createCompositeHook, type OnStepCompletedHook } from "../workflows/queue/shared/hooks.js"
import "../workflows/queue/steps/register-all"
import { resolveTierConfigs } from "./config/schema.js"
import type { EmitFn } from "../infra/event-bus.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { ContextIndexer } from "./memory/indexer.js"
import { createSubprocessCallback } from "./subprocess-callback.js"
import { createDispatcherCallback } from "./dispatcher-callback.js"
import type { WarmPool } from "./engines/pool/warm-pool.js"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import type { EventBus } from "../infra/event-bus.js"
import type { Queue } from "../workflows/queue/types.js"
import type { InjectionQueue } from "./engines/subprocess/injection-queue.js"

const log = Log.create({ service: "queue-orchestrator" })

interface ResolveTransportsInput {
  deps: WorkflowDeps
  emit: EmitFn
  workflowId: string
  sessionId: string
  baseDir: string
  evaluatorSystemPromptAddendum?: string
  dispatcherPool: WarmPool
  evaluatorPool?: WarmPool
  formatStdinMessage: (text: string) => string
}

export function resolveTransports(input: ResolveTransportsInput): { dispatcherTransport: PooledSubprocessTransport; evaluatorTransport: PooledSubprocessEvaluatorTransport | undefined } {
  const { deps, emit, workflowId, sessionId, baseDir, evaluatorSystemPromptAddendum, dispatcherPool, evaluatorPool, formatStdinMessage: fmtStdin } = input
  const engineName = deps.config.engine

  const dispatcherTransport = new PooledSubprocessTransport({
    pool: dispatcherPool,
    formatStdinMessage: fmtStdin,
    sessionId,
    baseDir,
    onStdout: (chunk) => emit("dispatcher:output", { workflowId, stream: "stdout" as const, data: chunk, engineName }),
    onStderr: (chunk) => emit("dispatcher:output", { workflowId, stream: "stderr" as const, data: chunk, engineName }),
  })
  log.info("queue dispatcher transport resolved", { label: "pooled", engine: engineName })

  // Always create evaluator transport when pool is available — the step-runner
  // decides whether to invoke it based on skipEvaluation + post-turn results.
  let evaluatorTransport: PooledSubprocessEvaluatorTransport | undefined
  if (evaluatorPool) {
    evaluatorTransport = new PooledSubprocessEvaluatorTransport({
      pool: evaluatorPool,
      formatStdinMessage: fmtStdin,
      sessionId,
      baseDir,
      systemPromptAddendum: evaluatorSystemPromptAddendum,
      onStdout: (chunk) => emit("evaluator:output", { workflowId, stream: "stdout" as const, data: chunk, engineName }),
      onStderr: (chunk) => emit("evaluator:output", { workflowId, stream: "stderr" as const, data: chunk, engineName }),
    })
    log.info("queue evaluator transport created", { label: "pooled", engine: engineName })
  }

  return { dispatcherTransport, evaluatorTransport }
}

interface ExecutorInfra {
  deps: WorkflowDeps;
  emit: EmitFn;
  eventBus: EventBus;
  workflowId: string;
  sessionId: string;
}

interface ExecutorTransports {
  dispatcherTransport?: PooledSubprocessTransport;
  evaluatorTransport?: PooledSubprocessEvaluatorTransport;
  subprocessPool?: WarmPool<RawSpawnedProcess> | null;
  observerChain?: { onTurnComplete(): string[]; reset(): void };
}

interface ExecutorContext {
  queue: Queue;
  projectCwd: string;
  /** Override the subprocess cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  subprocessCwd?: string;
  contextIndexer: ContextIndexer;
  sessionObjective?: string;
}

interface ExecutorExtensions {
  injectionQueue: InjectionQueue;
  seedHandoff?: Record<string, unknown> | null;
  chatContext?: string;
  externalHooks?: OnStepCompletedHook[];
}

export function buildExecutorDeps(
  infra: ExecutorInfra,
  transports: ExecutorTransports,
  context: ExecutorContext,
  extensions: ExecutorExtensions,
) {
  const tiers = resolveTierConfigs(infra.deps.config)

  const contextAccumulator = createContextAccumulator({
    windowSize: infra.deps.config.dispatcher_intelligence?.handoff_detail_window ?? 3,
  })
  if (extensions.seedHandoff) {
    contextAccumulator.accumulate(extensions.seedHandoff)
  }

  const evaluator = transports.evaluatorTransport
    ? createAgentEvaluatorFn({ transport: transports.evaluatorTransport })
    : null

  const compositeHook = createCompositeHook([...(extensions.externalHooks ?? [])])

  const dispatcherFn = createDispatcherCallback({
    maxRevisions: infra.deps.config.max_revisions, emit: infra.emit, workflowId: infra.workflowId,
    dispatcherTransport: transports.dispatcherTransport,
    contextIndexer: context.contextIndexer,
    contextAccumulator, projectCwd: context.projectCwd,
    sessionObjective: context.sessionObjective, queue: context.queue,
    dispatcherModel: tiers.dispatcher.model, subprocessModel: tiers.subprocess.model,
    chatContext: extensions.chatContext,
  })

  const subprocessFn = createSubprocessCallback({
    deps: infra.deps, emit: infra.emit, workflowId: infra.workflowId,
    sessionId: infra.sessionId, projectCwd: context.projectCwd,
    subprocessCwd: context.subprocessCwd,
    injectionQueue: extensions.injectionQueue,
    observerChain: transports.observerChain,
    subprocessPool: transports.subprocessPool,
  })

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
