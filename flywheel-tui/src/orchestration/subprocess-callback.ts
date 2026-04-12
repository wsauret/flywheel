/**
 * Subprocess callback factory — spawns the engine process for a queue step.
 *
 * Single-use factory justified by SRP: scaffolding setup, warm-pool acquisition,
 * stream pipeline wiring, stdin injection, and observer coordination form a
 * cohesive concern distinct from queue orchestration.
 */

import { randomUUID } from "node:crypto"
import { buildScaffolding, type ScaffoldingPaths } from "../workflows/queue/shared/scaffolding.js"
import {
  sessionDir,
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
import type { EventBus } from "../infra/event-bus.js"
import type { InjectionQueue } from "./engines/subprocess/injection-queue.js"
import type { Step } from "../workflows/queue/types.js"
import { SELF_REVIEW_CHECKLIST } from "../workflows/queue/shared/self-review-checklist.js"

const log = Log.create({ service: "subprocess-callback" })

/** Step types that get self-review injection at the first turn boundary. */
const SELF_REVIEW_STEP_TYPES = new Set(["work", "debug"])

// ---------------------------------------------------------------------------
// Pure prompt builder
// ---------------------------------------------------------------------------

export interface StepPromptResult {
  fullPrompt: string
  handoffPath: string
  scaffoldingPaths: ScaffoldingPaths
}

/**
 * Build the full prompt for a subprocess step.
 *
 * Pure function — no side effects, no I/O. Computes the handoff path,
 * scaffolding paths, and assembles preamble + prompt + postamble.
 */
// Exported for test validation (tests/build-step-prompt.test.ts)
export function buildStepPrompt(
  step: Step,
  prompt: string,
  sessionId: string,
  projectCwd: string,
): StepPromptResult {
  const handoffPath = buildSubprocessHandoffPath(sessionId, step.type, step.id, projectCwd)
  const scaffoldingPaths: ScaffoldingPaths = {
    handoffPath,
    planPath: `${sessionDir(sessionId)}/plan.json`,
    researchPath: `${sessionDir(sessionId)}/research.md`,
    reviewPath: `${sessionDir(sessionId)}/review.md`,
    contextPath: `${sessionDir(sessionId)}/context.md`,
  }
  const scaffolding = buildScaffolding(step, scaffoldingPaths)
  const parts: string[] = []
  if (scaffolding.preamble) parts.push(scaffolding.preamble)
  parts.push(prompt)
  if (scaffolding.postamble) parts.push(scaffolding.postamble)
  const fullPrompt = parts.join("\n\n")

  return { fullPrompt, handoffPath, scaffoldingPaths }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  eventBus: EventBus
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubprocessCallback(
  opts: SubprocessCallbackDeps,
): (step: Step, prompt: string) => Promise<SubprocessCallbackResult> {
  const {
    deps, emit, workflowId, sessionId, projectCwd,
    injectionQueue,
    eventBus, observerChain, subprocessPool,
  } = opts
  const useStdinPipe = deps.engine.metadata.supportsStreamingInput

  return async (step: Step, prompt: string, signal?: AbortSignal): Promise<SubprocessCallbackResult> => {
    // Reset observer state between steps so doom-loop history, consecutive
    // error counts, and no-action flags don't bleed across step boundaries.
    observerChain?.reset()
    let selfReviewInjected = false

    const invocationId = randomUUID()

    // Build prompt + compute paths (pure, no I/O)
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

    // Compose initial stdin content (engine-specific format)
    let stdinContent: string | undefined
    if (useStdinPipe && rawStdinContent) {
      stdinContent = formatStdinMessage(rawStdinContent)
    } else {
      stdinContent = rawStdinContent
    }

    // Turn-complete callback: when the subprocess finishes a turn (result event)
    // and the stdin pipe is still open, either inject a pending message or
    // close the pipe to let the step advance.
    const onTurnComplete = useStdinPipe ? (_subprocessSessionId: string | undefined) => {
      // Collect observer injection messages and enqueue
      const observerMessages = observerChain?.onTurnComplete() ?? []
      for (const msg of observerMessages) {
        injectionQueue.enqueue(msg)
      }
      // Self-review: inject checklist on first turn-complete for code steps.
      if (!selfReviewInjected && SELF_REVIEW_STEP_TYPES.has(step.type)) {
        injectionQueue.enqueue(SELF_REVIEW_CHECKLIST)
        selfReviewInjected = true
      }
      // Drain one item (or close handle if empty)
      const delivered = injectionQueue.drainAtTurnBoundary()
      if (delivered !== null) {
        log.info("turn-boundary injection sent to subprocess", { userSteering: delivered.userSteering })
        if (!delivered.userSteering) {
          // Observer/self-review messages need a new block in the UI
          emit("subprocess:injected", {
            workflowId: workflowId,
            message: delivered.message,
            origin: "system",
          })
        }
        // User-steering messages already have a pending block — no event needed.
        // Pending state is resolved when the agent starts outputting.
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
      onSessionId: undefined,
      stdoutTransform: undefined as undefined,
      onStdout: (chunk: string) => {
        emit("subprocess:output", { workflowId: workflowId, stream: "stdout", data: chunk, engineId: deps.engine.metadata.id })
      },
      onStderr: (chunk: string) => {
        emit("subprocess:output", { workflowId: workflowId, stream: "stderr", data: chunk, engineId: deps.engine.metadata.id })
      },
      onNDJSONEvent: (event: import("../infra/subprocess-types").NDJSONEvent) => {
        // Emit to EventBus — subscribers in workflow-runner handle budget, tracing, transcript, observers
        emit("subprocess:ndjson", { workflowId: workflowId, ndjsonEvent: event });
      },
    }

    // Acquire from pool or fall back to deps.spawner.spawn()
    let spawnResult: import("./engines/subprocess/spawner").SpawnResult
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

    // Write a boundary marker so transcript analysis can segment per-subprocess.
    // Emitted as subprocess:ndjson — the transcript subscriber persists it alongside real events.
    {
      const boundaryPayload = {
        type: "flywheel:subprocess_boundary",
        timestamp: new Date().toISOString(),
        workflowId: workflowId,
        stepId: step.id,
      }
      emit("subprocess:ndjson", {
        workflowId: workflowId,
        ndjsonEvent: {
          type: "flywheel:subprocess_boundary",
          data: boundaryPayload,
          raw: JSON.stringify(boundaryPayload),
        },
      })
    }

    // Bind stdinHandle to injection queue for mid-execution injection (user steering)
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
      // Unbind handle when subprocess finishes (pipe is closed)
      injectionQueue.bindStdin(null)
      // Return raw process to pool for cleanup and replacement
      if (subprocessPool && rawProc) {
        subprocessPool.release(rawProc)
      }
    }
  }
}
