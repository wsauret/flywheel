/**
 * Subprocess callback factory — spawns the engine process for a queue step.
 *
 * Extracted from queue-orchestrator.ts to isolate the ~110-line subprocessFn
 * into a focused, testable unit.
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
import type { StdinHandle } from "./engines/subprocess/spawner.js"
import type { WorkflowSession } from "./workflow-session.js"
import type { Step } from "../workflows/queue/types.js"
import type { BudgetTracker } from "./session/budget-tracker.js"
import type { TraceEventHandler } from "./engines/subprocess/trace-event-handler.js"
import type { TranscriptWriter } from "./session/transcript-writer.js"
import { createObserverChain, createToolFailureObserver, createNoActionObserver } from "./engines/stream-observers.js"
import { createDoomLoopObserver } from "./engines/doom-loop.js"
import { mapNDJSONToEngineEvents } from "./engines/subprocess/ndjson-event-mapper.js"
import { SELF_REVIEW_CHECKLIST } from "../workflows/queue/post-turn-verification.js"

const log = Log.create({ service: "subprocess-callback" })

/** Step types that get self-review injection at the first turn boundary. */
const SELF_REVIEW_STEP_TYPES = new Set(["work", "debug"])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubprocessCallbackDeps {
  deps: WorkflowDeps
  emit: EmitFn
  workflowIdRef: { current: string }
  sessionId: string
  projectCwd: string
  /** Override the subprocess cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  subprocessCwd?: string
  stdinHandleRef?: { current: StdinHandle | null }
  capturedSubprocessSessionId: { current: string | undefined }
  pendingInjection: { queue: string[] }
  activeSessionRef: { current: WorkflowSession | null }
  budgetTracker?: BudgetTracker | null
  traceEventHandler?: TraceEventHandler | null
  transcriptWriter?: TranscriptWriter | null
  /** Optional pre-warmed subprocess pool. When provided, acquires a raw process
   * from the pool and wires the stream pipeline with step-specific callbacks.
   * When absent, falls back to `deps.spawner.spawn()`. */
  subprocessPool?: WarmPool<RawSpawnedProcess> | null
}

export interface SubprocessCallbackResult {
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
    deps, emit, workflowIdRef, sessionId, projectCwd,
    stdinHandleRef, capturedSubprocessSessionId, pendingInjection,
    activeSessionRef, budgetTracker, traceEventHandler, transcriptWriter, subprocessPool,
  } = opts
  const useStdinPipe = deps.engine.metadata.supportsStreamingInput

  // Stream observers — always active for workflow mode
  const observerChain = createObserverChain([
    createDoomLoopObserver(),
    createToolFailureObserver(),
    createNoActionObserver(),
  ])

  return async (step: Step, prompt: string, signal?: AbortSignal): Promise<SubprocessCallbackResult> => {
    // Reset observer state between steps so doom-loop history, consecutive
    // error counts, and no-action flags don't bleed across step boundaries.
    observerChain.reset()
    let selfReviewInjected = false

    const invocationId = randomUUID()

    // Compute handoff path BEFORE spawning — session-scoped with meaningful name
    const handoffPath = buildSubprocessHandoffPath(sessionId, step.type, step.id, projectCwd)
    ensureSessionDir(sessionId, projectCwd)

    // Build session-scoped paths for scaffolding
    const scaffoldingPaths: ScaffoldingPaths = {
      handoffPath,
      planPath: `${sessionDir(sessionId)}/plan.json`,
      researchPath: `${sessionDir(sessionId)}/research.md`,
      reviewPath: `${sessionDir(sessionId)}/review.md`,
      contextPath: `${sessionDir(sessionId)}/context.md`,
    }

    // Build deterministic scaffolding (preamble before task_content, postamble after)
    const scaffolding = buildScaffolding(step, scaffoldingPaths)
    const parts: string[] = []
    if (scaffolding.preamble) parts.push(scaffolding.preamble)
    parts.push(prompt)
    if (scaffolding.postamble) parts.push(scaffolding.postamble)
    const fullPrompt = parts.join("\n\n")

    const engineCmd = deps.engine.buildCommand({
      model: deps.config.subprocess?.model ?? deps.config.model,
      effort: deps.config.subprocess?.effort ?? undefined,
      toolScoping: step.toolScoping ?? undefined,
    })
    const startTime = Date.now()
    const rawStdinContent = engineCmd.stdinPrompt
      ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
      : undefined

    // Compose initial stdin content (engine-specific format)
    let stdinContent: string | undefined
    if (useStdinPipe && rawStdinContent) {
      stdinContent = formatStdinMessage(deps.engine.metadata.id, rawStdinContent)
    } else {
      stdinContent = rawStdinContent
    }

    // Turn-complete callback: when the subprocess finishes a turn (result event)
    // and the stdin pipe is still open, either inject a pending message or
    // close the pipe to let the step advance.
    const onTurnComplete = useStdinPipe ? (subprocessSessionId: string | undefined) => {
      capturedSubprocessSessionId.current = subprocessSessionId
      // Collect observer injection messages and push to queue
      const observerMessages = observerChain.onTurnComplete()
      for (const msg of observerMessages) {
        pendingInjection.queue.push(msg)
      }
      // Self-review: inject checklist on first turn-complete for code steps.
      // Uses the same injection mechanism as observers — no new infrastructure.
      if (!selfReviewInjected && SELF_REVIEW_STEP_TYPES.has(step.type)) {
        pendingInjection.queue.push(SELF_REVIEW_CHECKLIST)
        selfReviewInjected = true
      }
      if (pendingInjection.queue.length > 0 && stdinHandleRef?.current?.isOpen) {
        const message = pendingInjection.queue.shift()!
        const written = stdinHandleRef.current.write(formatStdinMessage(deps.engine.metadata.id, message))
        if (written) {
          log.info("turn-boundary injection sent to subprocess", { length: message.length })
          if (activeSessionRef.current) {
            activeSessionRef.current.eventBus.emit({
              type: "subprocess:injected",
              workflowId: workflowIdRef.current,
              message,
              timestamp: Date.now(),
            })
          }
        } else {
          log.warn("turn-boundary injection failed — pipe closed")
        }
      } else {
        stdinHandleRef?.current?.close()
      }
    } : undefined

    // Reset cumulative-cost baselines before each spawn so delta accounting
    // starts from zero for this new process.
    budgetTracker?.onNewSubprocess()

    const spawnOptions = {
      cwd: opts.subprocessCwd ?? projectCwd,
      invocationId,
      sessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      signal,
      onTurnComplete,
      onSessionId: (id: string) => {
        capturedSubprocessSessionId.current = id
      },
      stdoutTransform: undefined as undefined,
      onStdout: (chunk: string) => {
        emit("subprocess:output", { workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineId: deps.engine.metadata.id })
      },
      onStderr: (chunk: string) => {
        emit("subprocess:output", { workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineId: deps.engine.metadata.id })
      },
      onNDJSONEvent: (event: import("./engines/subprocess/ndjson-parser").NDJSONEvent) => {
        budgetTracker?.handleEvent(event);
        traceEventHandler?.handleEvent(event);
        transcriptWriter?.handleEvent(event);
        // Feed observers
        for (const engineEvent of mapNDJSONToEngineEvents(event)) {
          observerChain.onEvent(engineEvent);
        }
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

    // Write a boundary marker so transcript analysis can segment per-subprocess
    if (transcriptWriter) {
      const boundaryPayload = {
        type: "flywheel:subprocess_boundary",
        timestamp: new Date().toISOString(),
        workflowId: workflowIdRef.current,
        stepId: step.id,
      }
      transcriptWriter.handleEvent({
        // as any: Synthetic boundary event — "unknown" is not in NDJSONEventType union;
        // using cast to avoid extending the type for a non-NDJSON internal marker event.
        type: "unknown" as any,
        data: boundaryPayload,
        raw: JSON.stringify(boundaryPayload),
      })
    }

    // Expose stdinHandle for mid-execution injection (user steering)
    if (stdinHandleRef && spawnResult.stdinHandle) {
      stdinHandleRef.current = spawnResult.stdinHandle
    }

    try {
      const subprocessResult = await spawnResult.result
      // Capture session ID from subprocess result (fallback for non-streaming engines)
      if (subprocessResult.sessionId) {
        capturedSubprocessSessionId.current = subprocessResult.sessionId
      }
      return {
        output: subprocessResult.exitCode === 0 ? "completed" : (subprocessResult.failure?.message ?? "failed"),
        handoffPath: subprocessResult.handoffPath ?? "",
        durationMs: Date.now() - startTime,
        sessionId: subprocessResult.sessionId,
      }
    } finally {
      // Clear handle when subprocess finishes (pipe is closed)
      if (stdinHandleRef) {
        stdinHandleRef.current = null
      }
      // Return raw process to pool for cleanup and replacement
      if (subprocessPool && rawProc) {
        subprocessPool.release(rawProc)
      }
    }
  }
}
