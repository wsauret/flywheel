import { randomUUID } from "node:crypto"
import { buildScaffolding, type ScaffoldingPaths } from "../workflows/queue/shared/scaffolding.js"
import {
  buildSubprocessHandoffPath,
  ensureSessionDir,
} from "../infra/paths.js"
import { formatStdinMessage } from "./engines/subprocess/stdin-format.js"
import { Log } from "../infra/log.js"
import { wireStreamPipeline } from "./engines/subprocess/stream-pipeline.js"
import type { RawSpawnedProcess } from "./engines/subprocess/stream-pipeline.js"
import type { WarmPool } from "./engines/pool/warm-pool.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import type { EmitFn } from "../infra/event-bus.js"
import type { InjectionQueue } from "./engines/subprocess/injection-queue.js"
import type { Step } from "../workflows/queue/types.js"
import type { NDJSONEvent } from "../infra/subprocess-types.js"
import type { SpawnResult } from "./engines/subprocess/spawner.js"
import { SELF_REVIEW_CHECKLIST } from "../workflows/queue/shared/self-review-checklist.js"

const log = Log.create({ service: "subprocess-callback" })

/** Step types that get self-review injection at the first turn boundary. */
const SELF_REVIEW_STEP_TYPES = new Set(["work", "debug"])

interface StepPromptResult {
  fullPrompt: string
  handoffPath: string
  scaffoldingPaths: ScaffoldingPaths
}

function buildStepPrompt(
  step: Step,
  prompt: string,
  sessionId: string,
  projectCwd: string,
): StepPromptResult {
  const handoffPath = buildSubprocessHandoffPath(sessionId, step.type, step.id, projectCwd)
  const scaffoldingPaths = {
    handoffPath,
  }
  const scaffolding = buildScaffolding(step, scaffoldingPaths)
  const parts: string[] = []
  if (scaffolding.preamble) parts.push(scaffolding.preamble)
  parts.push(prompt)
  if (scaffolding.postamble) parts.push(scaffolding.postamble)
  const fullPrompt = parts.join("\n\n")

  return { fullPrompt, handoffPath, scaffoldingPaths }
}

interface SubprocessCallbackDeps {
  deps: WorkflowDeps
  emit: EmitFn
  workflowId: string
  sessionId: string
  projectCwd: string
  /** Override the subprocess cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  subprocessCwd?: string
  injectionQueue: InjectionQueue
  /** Observer chain for stream observers — created by workflow-runner, fed via EventBus.
   *  Subprocess-callback owns reset (per-step) and turn-complete (injection). */
  observerChain?: { onTurnComplete(): string[]; reset(): void }
  /** Optional pre-warmed subprocess pool. When provided, acquires a raw process
   * from the pool and wires the stream pipeline with step-specific callbacks.
   * When absent, falls back to `deps.spawner.spawn()`. */
  subprocessPool?: WarmPool<RawSpawnedProcess> | null
}

interface SubprocessCallbackResult {
  output: string
  handoffPath: string
  durationMs: number
  sessionId: string | undefined
}

export function createSubprocessCallback(
  opts: SubprocessCallbackDeps,
): (step: Step, prompt: string) => Promise<SubprocessCallbackResult> {
  const {
    deps, emit, workflowId, sessionId, projectCwd,
    injectionQueue, observerChain, subprocessPool,
  } = opts
  const useStdinPipe = deps.engine.metadata.supportsStreamingInput

  return async (step: Step, prompt: string, signal?: AbortSignal): Promise<SubprocessCallbackResult> => {
    observerChain?.reset()
    let selfReviewInjected = false

    const invocationId = randomUUID()

    const { fullPrompt, handoffPath } = buildStepPrompt(step, prompt, sessionId, projectCwd)
    ensureSessionDir(sessionId, projectCwd)

    const engineCmd = deps.engine.buildCommand({
      model: deps.config.subprocess?.model ?? deps.config.model,
      effort: deps.config.subprocess?.effort ?? deps.config.effort ?? undefined,
      toolScoping: step.toolScoping ?? undefined,
    })
    const startTime = Date.now()
    const rawStdinContent = engineCmd.stdinPrompt
      ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
      : undefined

    let stdinContent: string | undefined
    if (useStdinPipe && rawStdinContent) {
      stdinContent = formatStdinMessage(rawStdinContent)
    } else {
      stdinContent = rawStdinContent
    }

    const onTurnComplete = useStdinPipe ? (_subprocessSessionId: string | undefined) => {
      const observerMessages = observerChain?.onTurnComplete() ?? []
      for (const msg of observerMessages) injectionQueue.enqueue(msg)

      if (!selfReviewInjected && SELF_REVIEW_STEP_TYPES.has(step.type)) {
        injectionQueue.enqueue(SELF_REVIEW_CHECKLIST)
        selfReviewInjected = true
      }

      const delivered = injectionQueue.drainAtTurnBoundary()
      if (delivered !== null) {
        log.info("turn-boundary injection sent to subprocess", { userSteering: delivered.userSteering })
        // Observer/self-review messages need a new block; user-steering messages
        // already have a pending block that resolves when the agent outputs.
        if (!delivered.userSteering) {
          emit("subprocess:injected", { workflowId, message: delivered.message, origin: "system" })
        }
      }
    } : undefined

    const spawnOptions = {
      cwd: opts.subprocessCwd ?? projectCwd,
      invocationId,
      sessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      signal,
      onTurnComplete,
      onStdout: (chunk: string) => {
        emit("subprocess:output", { workflowId, stream: "stdout", data: chunk, engineId: deps.engine.metadata.id })
      },
      onStderr: (chunk: string) => {
        emit("subprocess:output", { workflowId, stream: "stderr", data: chunk, engineId: deps.engine.metadata.id })
      },
      onNDJSONEvent: (event: NDJSONEvent) => {
        emit("subprocess:ndjson", { workflowId, ndjsonEvent: event });
      },
    }

    let spawnResult: SpawnResult
    let rawProc: RawSpawnedProcess | null = null

    if (subprocessPool) {
      rawProc = await subprocessPool.acquire()
      const timeoutMs = deps.config.timeout_minutes
        ? deps.config.timeout_minutes * 60_000
        : 60 * 60_000
      spawnResult = wireStreamPipeline(rawProc, { timeoutMs, spawnOptions })
    } else {
      spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, spawnOptions)
    }

    // Boundary marker for transcript segmentation per-subprocess
    {
      const boundaryPayload = {
        type: "flywheel:subprocess_boundary",
        timestamp: new Date().toISOString(),
        workflowId,
        stepId: step.id,
      }
      emit("subprocess:ndjson", {
        workflowId,
        ndjsonEvent: {
          type: "flywheel:subprocess_boundary",
          data: boundaryPayload,
          raw: JSON.stringify(boundaryPayload),
        },
      })
    }

    if (spawnResult.stdinHandle) {
      injectionQueue.bindStdin(spawnResult.stdinHandle)
    }

    try {
      const subprocessResult = await spawnResult.result
      return {
        output: subprocessResult.exitCode === 0 ? "completed" : (subprocessResult.failure?.message ?? "failed"),
        handoffPath: subprocessResult.handoffPath ?? "",
        durationMs: Date.now() - startTime,
        sessionId: subprocessResult.sessionId,
      }
    } finally {
      injectionQueue.bindStdin(null)
      if (subprocessPool && rawProc) {
        subprocessPool.release(rawProc)
      }
    }
  }
}
