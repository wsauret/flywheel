/**
 * Worker callback factory — spawns the engine process for a queue step.
 *
 * Extracted from queue-orchestrator.ts to isolate the ~110-line workerFn
 * into a focused, testable unit.
 */

import { randomUUID } from "node:crypto"
import { buildScaffolding, type ScaffoldingPaths } from "../workflows/queue/shared/scaffolding"
import {
  sessionDir,
  buildWorkerHandoffPath,
  ensureSessionDir,
} from "../infra/paths"
import { formatStdinMessage } from "./worker/stdin-format"
import { Log } from "../infra/log"
import type { WorkflowDeps } from "./engines/workflow-deps"
import type { FlywheelEmitter } from "../infra/event-bus"
import type { StdinHandle } from "./worker/spawner"
import type { WorkflowSession } from "./workflow-session"
import type { Step } from "../workflows/queue/types"
import type { BudgetTracker } from "./session/budget-tracker"

const log = Log.create({ service: "worker-callback" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerCallbackDeps {
  deps: WorkflowDeps
  emitter: FlywheelEmitter
  workflowIdRef: { current: string }
  sessionId: string
  projectCwd: string
  /** Override the worker process cwd. Defaults to projectCwd.
   * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
   * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
  workerCwd?: string
  stdinHandleRef?: { current: StdinHandle | null }
  capturedWorkerSessionId: { current: string | undefined }
  pendingInjection: { current: string | null }
  activeSessionRef: { current: WorkflowSession | null }
  budgetTracker?: BudgetTracker | null
}

export interface WorkerCallbackResult {
  output: string
  handoffPath: string
  durationMs: number
  sessionId: string | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkerCallback(
  opts: WorkerCallbackDeps,
): (step: Step, prompt: string) => Promise<WorkerCallbackResult> {
  const {
    deps, emitter, workflowIdRef, sessionId, projectCwd,
    stdinHandleRef, capturedWorkerSessionId, pendingInjection,
    activeSessionRef, budgetTracker,
  } = opts
  const useStdinPipe = deps.engine.metadata.supportsStreamingInput

  return async (step: Step, prompt: string): Promise<WorkerCallbackResult> => {
    const invocationId = randomUUID()

    // Compute handoff path BEFORE spawning — session-scoped with meaningful name
    const handoffPath = buildWorkerHandoffPath(sessionId, step.type, step.id, projectCwd)
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
      prompt: fullPrompt,
      model: deps.config.worker?.model ?? deps.config.model,
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

    // Turn-complete callback: when the worker finishes a turn (result event)
    // and the stdin pipe is still open, either inject a pending message or
    // close the pipe to let the step advance.
    const onTurnComplete = useStdinPipe ? (workerSessionId: string | undefined) => {
      capturedWorkerSessionId.current = workerSessionId
      if (pendingInjection.current && stdinHandleRef?.current?.isOpen) {
        const message = pendingInjection.current
        pendingInjection.current = null
        const written = stdinHandleRef.current.write(formatStdinMessage(deps.engine.metadata.id, message))
        if (written) {
          log.info("turn-boundary injection sent to worker", { length: message.length })
          if (activeSessionRef.current) {
            activeSessionRef.current.eventBus.emit({
              type: "worker:injected",
              workflowId: workflowIdRef.current,
              message,
              timestamp: new Date().toISOString(),
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
    budgetTracker?.onNewWorker()

    const spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: opts.workerCwd ?? projectCwd,
      invocationId,
      sessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      onTurnComplete,
      onSessionId: (id) => {
        capturedWorkerSessionId.current = id
      },
      stdoutTransform: undefined,
      onStdout: (chunk) => {
        emitter.workerOutput(workflowIdRef.current, "stdout", chunk, deps.engine.metadata.id)
      },
      onStderr: (chunk) => {
        emitter.workerOutput(workflowIdRef.current, "stderr", chunk, deps.engine.metadata.id)
      },
      onNDJSONEvent: budgetTracker ? (event) => budgetTracker.handleEvent(event) : undefined,
    })

    // Expose stdinHandle for mid-execution injection (user steering)
    if (stdinHandleRef && spawnResult.stdinHandle) {
      stdinHandleRef.current = spawnResult.stdinHandle
    }

    try {
      const workerResult = await spawnResult.result
      // Capture session ID from worker result (fallback for non-streaming engines)
      if (workerResult.sessionId) {
        capturedWorkerSessionId.current = workerResult.sessionId
      }
      return {
        output: workerResult.exitCode === 0 ? "completed" : (workerResult.failure?.message ?? "failed"),
        handoffPath: workerResult.handoffPath ?? "",
        durationMs: Date.now() - startTime,
        sessionId: workerResult.sessionId,
      }
    } finally {
      // Clear handle when worker finishes (pipe is closed)
      if (stdinHandleRef) {
        stdinHandleRef.current = null
      }
    }
  }
}
