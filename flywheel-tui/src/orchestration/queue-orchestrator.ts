/**
 * Queue orchestrator — pure functions for resolving transports and building
 * executor dependencies. Extracted from flywheel-shell.tsx to reduce its size.
 *
 * These functions take all dependencies as parameters (no SolidJS signals).
 */

import { autoDetectTransport } from "../workflows/dispatcher/auto-detect"
import { createEvaluatorTransport } from "../workflows/evaluator/create-transport"
import { createAgentEvaluatorFn } from "../workflows/evaluator/create-agent-evaluator"
import { readHandoff } from "../workflows/queue/shared/handoff-reader"
import { WorkerHandoffSchema } from "../infra/handoff-schemas"
import { createContextAccumulator } from "../workflows/queue/context-accumulator"
import { createCompositeHook } from "../workflows/queue/shared/hooks"
import "../workflows/queue/steps/register-all"
import { resolveTierConfigs } from "./config/loader"
import { getEngine } from "./engines/core/registry"
import { createEnvFilter } from "./worker/env-filter"
import { createFlywheelEmitter } from "../infra/event-bus"
import { Log } from "../infra/log"
import { errorMessage } from "../infra/error-message"
import { ContextIndexer } from "./memory/indexer"
import { createWorkerCallback } from "./worker-callback"
import { createDispatcherCallback } from "./dispatcher-callback"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { EventBus } from "../infra/event-bus"
import type { Queue } from "../workflows/queue/types"
import type { StdinHandle } from "./worker/spawner"
import type { WorkflowSession } from "./workflow-session"

const log = Log.create({ service: "shell" })

// ── resolveTransports ──

/**
 * Resolve dispatcher and evaluator transports for queue execution.
 * Shared between startQueueExecution and resumeSession queue paths.
 */
export async function resolveTransports(deps: WorkflowDeps, eventBus: EventBus, workflowIdRef: { current: string }, logBaseDir: string, sessionId?: string, baseDir?: string, evaluatorSystemPromptAddendum?: string) {
  const engineName = deps.config.engine

  const tiers = resolveTierConfigs(deps.config)
  const engine = getEngine(engineName)
  const envFilter = createEnvFilter()

  let dispatcherTransport: import("../workflows/dispatcher/transport").DispatcherTransport | undefined
  try {
    const resolved = await autoDetectTransport({
      spawner: deps.spawner,
      engine,
      envFilter,
      tierConfig: tiers.dispatcher,
      buildCommand: (opts) => engine.buildDispatcherCommand(opts),
      onStdout: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
      onStderr: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
      logBaseDir,
      sessionId,
      baseDir,
    })
    dispatcherTransport = resolved.transport
    log.info("queue dispatcher transport resolved", { label: resolved.label, engine: engineName })
  } catch (err) {
    log.warn("queue dispatcher transport auto-detect failed", {
      error: errorMessage(err),
    })
  }

  let evaluatorTransport: import("../workflows/evaluator/transport").EvaluatorTransport | undefined
  if (!deps.config.skip_evaluation) {
    try {
      evaluatorTransport = await createEvaluatorTransport({
        spawner: deps.spawner,
        engine,
        envFilter,
        tierConfig: tiers.evaluator,
        buildCommand: (opts) => engine.buildEvaluatorCommand(opts),
        onStdout: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
        onStderr: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
        logBaseDir,
        sessionId,
        baseDir,
        systemPromptAddendum: evaluatorSystemPromptAddendum,
      })
      log.info("queue evaluator transport created", { engine: engineName })
    } catch (err) {
      log.warn("queue evaluator transport creation failed", {
        error: errorMessage(err),
      })
    }
  }

  return { dispatcherTransport, evaluatorTransport }
}

// ── buildExecutorDeps ──

/** Core dependencies for building executor deps. */
export interface BuildExecutorCoreDeps {
  deps: WorkflowDeps;
  emitter: ReturnType<typeof createFlywheelEmitter>;
  workflowIdRef: { current: string };
  queue: Queue;
  /** Session ID for session-scoped file paths. */
  sessionId: string;
  projectCwd: string;
  /** Override the worker process cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  workerCwd?: string;
  contextIndexer: ContextIndexer;
  /** Setter for TUI queue step state (SolidJS signal setter passed from shell). */
  setShellQueueSteps: (updater: any) => void;
  /** Mutable ref tracking captured worker session ID for resume/interrupt. */
  capturedWorkerSessionId: { current: string | undefined };
  /** Mutable ref for pending injection message at turn boundaries. */
  pendingInjection: { current: string | null };
  /** Ref to the active workflow session (for event bus access in turn-complete callback). */
  activeSessionRef: { current: WorkflowSession | null };
}

/** Optional extensions for building executor deps. */
export interface BuildExecutorExtensions {
  dispatcherTransport?: import("../workflows/dispatcher/transport").DispatcherTransport;
  evaluatorTransport?: import("../workflows/evaluator/transport").EvaluatorTransport;
  sessionObjective?: string;
  /** Chat conversation context captured before workflow transition (not prepended to description). */
  chatContext?: string;
  /** Mutable ref to store the active worker's stdin handle for mid-execution injection. */
  stdinHandleRef?: { current: StdinHandle | null };
  /** Pre-seed context accumulator with fixture handoff (for /test command). */
  seedHandoff?: Record<string, unknown> | null;
  /** Budget tracker for cost/token tracking from worker NDJSON events. */
  budgetTracker?: import("./session/budget-tracker").BudgetTracker | null;
}

/** Full options = core + extensions. */
export type BuildExecutorDepsOpts = BuildExecutorCoreDeps & BuildExecutorExtensions;

/**
 * Build the shared executor dependencies (dispatcher, accumulator, evaluator,
 * hooks, worker callback, handoff reader) used by both startQueueExecution
 * and resumeSession. Eliminates ~150 lines of duplication between the two paths.
 */
export function buildExecutorDeps(opts: BuildExecutorDepsOpts) {
  const {
    deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
    contextIndexer, projectCwd, sessionObjective, queue, stdinHandleRef,
    seedHandoff, sessionId: execSessionId,
    setShellQueueSteps,
    capturedWorkerSessionId, pendingInjection, activeSessionRef,
    budgetTracker,
  } = opts
  const tiers = resolveTierConfigs(deps.config)

  // Context accumulator (windowed detail strategy)
  const contextAccumulator = createContextAccumulator({
    windowSize: deps.config.dispatcher_intelligence?.handoff_detail_window ?? 3,
  })
  if (seedHandoff) {
    contextAccumulator.accumulate(seedHandoff)
  }

  // Agent-based evaluator (if evaluation not skipped and transport available)
  const evaluator = !deps.config.skip_evaluation && evaluatorTransport
    ? createAgentEvaluatorFn({ transport: evaluatorTransport })
    : null

  // Composite hook: TUI step refresh callback
  const compositeHook = createCompositeHook([
    async (step, status, q, _handoffData) => {
      if (status === "completed") {
        const updatedQueueStepStates = q.steps.map(s => ({
          id: s.id,
          type: s.type,
          title: s.title,
          status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
        }))
        setShellQueueSteps(updatedQueueStepStates)
      }
      return { continueExecution: false }
    },
  ])

  // Dispatcher callback (real dispatcher with fallback to step metadata)
  const dispatcherFn = createDispatcherCallback({
    deps, emitter, workflowIdRef, dispatcherTransport, contextIndexer,
    contextAccumulator, projectCwd, sessionObjective, queue,
    dispatcherModel: tiers.dispatcher.model, workerModel: tiers.worker.model,
  })

  // Worker callback (spawn engine process)
  const workerFn = createWorkerCallback({
    deps, emitter, workflowIdRef, sessionId: execSessionId, projectCwd,
    workerCwd: opts.workerCwd,
    stdinHandleRef, capturedWorkerSessionId, pendingInjection,
    activeSessionRef, budgetTracker,
  })

  // Handoff reader callback
  const handoffReader = async (handoffPath: string) => {
    if (!handoffPath) return null
    try {
      const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
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
    workerFn,
    handoffReader,
  }
}
