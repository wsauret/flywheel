/**
 * Interrupt controller — extracted from flywheel-shell.tsx
 *
 * Handles resuming a worker after an interrupt by either:
 *   1. Writing to an open stdinHandle (SDK path — session stayed alive)
 *   2. Spawning a new worker process with --resume (CLI path)
 *
 * All dependencies are injected via the `deps` parameter — no SolidJS
 * signals or component-level state captured in closures.
 */

import { randomUUID } from "node:crypto"
import { createFlywheelEmitter } from "../../events/event-bus"
import { formatClaudeStdinMessage } from "../../worker/stdin-format"
import { Log } from "../../utils/log"

import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { StdinHandle } from "../../worker/spawner"
import type { WorkflowSession } from "../session/workflow-session"
import type { Queue } from "../../queue/types"
import type { StepExecutor } from "../../queue/executor"
import type { EscapeHandler } from "../utils/escape-handler"
import type { QueueStepState } from "../routes/work/state/types"

const log = Log.create({ service: "shell" })

// ---------------------------------------------------------------------------
// Toast type (duck-typed to avoid importing the context provider)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// Dependency bundle for resumeWorkerWithMessage
// ---------------------------------------------------------------------------

export interface InterruptControllerDeps {
  activeStdinHandleRef: { current: StdinHandle | null }
  getDepsOrWarn: () => WorkflowDeps | null
  getActiveSession: () => WorkflowSession | null
  getActiveQueue: () => Queue | null
  getActiveStepExecutor: () => StepExecutor | null
  stopWorkflow: () => Promise<void>
  toast: ToastLike
  escapeHandler: EscapeHandler
  capturedWorkerSessionId: { current: string | undefined }
  pendingInjection: { current: string | null }
  setShellQueueSteps: (fn: (prev: QueueStepState[]) => QueueStepState[]) => void
  setEscHint: (hint: string) => void
  setIsInterrupted: (value: boolean) => void
}

// ---------------------------------------------------------------------------
// resumeWorkerWithMessage
// ---------------------------------------------------------------------------

/**
 * Resume the worker after an interrupt.
 *
 * Called when the user types text while in the interrupted state (after first Esc).
 * Either writes directly to an open stdinHandle (SDK path) or spawns a new
 * worker process with --resume (CLI path), then transitions back to "working".
 */
export function resumeWorkerWithMessage(
  message: string,
  deps: InterruptControllerDeps,
): void {
  const {
    activeStdinHandleRef,
    getDepsOrWarn,
    getActiveSession,
    getActiveQueue,
    getActiveStepExecutor,
    stopWorkflow,
    toast,
    escapeHandler,
    capturedWorkerSessionId,
    pendingInjection,
    setShellQueueSteps,
    setEscHint,
    setIsInterrupted,
  } = deps

  const activeSession = getActiveSession()
  const activeQueue = getActiveQueue()
  const activeStepExecutor = getActiveStepExecutor()

  // ── SDK path ──
  // If the stdinHandle is still open (SDK session stayed alive after
  // interrupt), just send the message directly — no respawn needed.
  const handle = activeStdinHandleRef.current
  if (handle?.isOpen) {
    setIsInterrupted(false)
    setEscHint("")
    escapeHandler.reset()
    pendingInjection.current = null

    if (activeSession?.adapter) {
      activeSession.adapter.suppressQueueError = false
    }

    log.info("resuming SDK session via stdinHandle.write", {
      sessionId: capturedWorkerSessionId.current,
      messageLength: message.length,
    })

    // Emit a system message to show the resume in the output
    if (activeSession) {
      activeSession.eventBus.emit({
        type: "worker:output",
        workflowId: "resume",
        stream: "stderr",
        data: `▶ Resuming with message: ${message.slice(0, 100)}${message.length > 100 ? "…" : ""}\n`,
        timestamp: new Date().toISOString(),
      })
    }

    const written = handle.write(message)
    if (written) {
      log.info("SDK resume message sent", { sessionId: capturedWorkerSessionId.current })
    } else {
      log.warn("SDK resume write failed — handle closed unexpectedly")
      toast.show({ message: "Resume failed — session closed", variant: "error" })
    }
    return
  }

  // ── CLI path: spawn a new process with --resume ──
  const resumeSessionId = capturedWorkerSessionId.current
  if (!resumeSessionId) {
    log.warn("no captured session ID for resume — cannot resume worker")
    toast.show({ message: "Cannot resume — no session ID captured", variant: "error" })
    // Fall back to queuing the message
    pendingInjection.current = message
    setIsInterrupted(false)
    setEscHint("")
    escapeHandler.reset()
    return
  }

  // Reset interrupt state
  setIsInterrupted(false)
  setEscHint("")
  escapeHandler.reset()
  pendingInjection.current = null

  // Reset suppressQueueError so normal errors are shown again
  if (activeSession?.adapter) {
    activeSession.adapter.suppressQueueError = false
  }

  const wfDeps = getDepsOrWarn()
  if (!wfDeps) {
    toast.show({ message: "Failed to load config for resume", variant: "error" })
    return
  }

  const projectCwd = wfDeps.config.project_cwd ?? "."

  log.info("resuming worker with --resume", {
    resumeSessionId,
    messageLength: message.length,
  })

  // Emit a system message to show the resume in the output
  if (activeSession) {
    activeSession.eventBus.emit({
      type: "worker:output",
      workflowId: "resume",
      stream: "stderr",
      data: `▶ Resuming worker with message: ${message.slice(0, 100)}${message.length > 100 ? "…" : ""}\n`,
      timestamp: new Date().toISOString(),
    })
  }

  // Spawn a new worker process with --resume
  const useStdinPipe = wfDeps.engine.metadata.supportsStreamingInput
  const engineCmd = wfDeps.engine.buildCommand({
    prompt: message,
    model: wfDeps.config.worker?.model ?? wfDeps.config.model,
    resumeSessionId,
  })

  const stdinContent = useStdinPipe
    ? formatClaudeStdinMessage(message)
    : (engineCmd.stdinPrompt
        ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + message : message)
        : undefined)

  const emitter = activeSession
    ? createFlywheelEmitter(activeSession.eventBus)
    : null

  const workflowIdRef = `resume-${resumeSessionId}`

  // Update queue step display to show "running" again
  setShellQueueSteps((prev) =>
    prev.map((s) =>
      s.error === "interrupted"
        ? { ...s, status: "running" as const, error: undefined }
        : s,
    ),
  )

  // Fire-and-forget async spawn
  queueMicrotask(async () => {
    try {
      const onTurnComplete = useStdinPipe ? (sessionId: string | undefined) => {
        // Capture new session ID
        if (sessionId) capturedWorkerSessionId.current = sessionId
        // Check for pending injection
        if (pendingInjection.current && activeStdinHandleRef.current?.isOpen) {
          const injectMsg = pendingInjection.current
          pendingInjection.current = null
          const written = activeStdinHandleRef.current.write(formatClaudeStdinMessage(injectMsg))
          if (written) {
            log.info("turn-boundary injection sent to resumed worker", { length: injectMsg.length })
          }
        } else {
          activeStdinHandleRef.current?.close()
        }
      } : undefined

      const spawnResult = await wfDeps.spawner.spawn(engineCmd.command, engineCmd.args, {
        cwd: projectCwd,
        invocationId: randomUUID(),
        stdin: stdinContent,
        stdinPipe: useStdinPipe && stdinContent !== undefined,
        onTurnComplete,
        onSessionId: (sessionId) => {
          capturedWorkerSessionId.current = sessionId
        },
        onStdout: (chunk) => {
          emitter?.workerOutput(workflowIdRef, "stdout", chunk, wfDeps.engine.metadata.id)
        },
        onStderr: (chunk) => {
          emitter?.workerOutput(workflowIdRef, "stderr", chunk, wfDeps.engine.metadata.id)
        },
      })

      // Store stdin handle for mid-execution injection
      if (spawnResult.stdinHandle) {
        activeStdinHandleRef.current = spawnResult.stdinHandle
      }

      const workerResult = await spawnResult.result

      // Capture session ID from result (fallback for non-streaming engines)
      if (workerResult.sessionId) {
        capturedWorkerSessionId.current = workerResult.sessionId
      }

      // Clear stdin handle
      activeStdinHandleRef.current = null

      if (workerResult.exitCode === 0) {
        // Worker completed successfully — mark the interrupted step as completed
        setShellQueueSteps((prev) =>
          prev.map((s) =>
            s.status === "running"
              ? { ...s, status: "completed" as const }
              : s,
          ),
        )
        toast.show({ message: "Worker completed", variant: "info", duration: 3000 })

        // Check if there are remaining pending steps in the queue
        const hasPendingSteps = activeQueue?.steps.some((s) => s.status === "pending")
        if (hasPendingSteps) {
          // TODO: restart step executor for remaining steps
          log.info("resumed worker completed, pending steps remain — pausing")
        }

        // No executor to continue remaining steps — transition to completed
        // so the runtime doesn't stay stuck in "working" with nothing running
        if (!hasPendingSteps || !activeStepExecutor) {
          await stopWorkflow()
        }
      } else {
        // Worker failed after resume — clean up and transition to completed
        setShellQueueSteps((prev) =>
          prev.map((s) =>
            s.status === "running"
              ? { ...s, status: "failed" as const, error: workerResult.failure?.message ?? "failed" }
              : s,
          ),
        )
        toast.show({
          message: `Worker failed: ${workerResult.failure?.message ?? "unknown error"}`,
          variant: "error",
          duration: 5000,
        })
        await stopWorkflow()
      }
    } catch (err) {
      activeStdinHandleRef.current = null
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error("resume worker spawn failed", { error: errMsg })
      setShellQueueSteps((prev) =>
        prev.map((s) =>
          s.status === "running"
            ? { ...s, status: "failed" as const, error: errMsg }
            : s,
        ),
      )
      toast.show({ message: `Resume failed: ${errMsg}`, variant: "error" })
      await stopWorkflow()
    }
  })
}

// ---------------------------------------------------------------------------
// resetInterruptState — resets all interrupt-related mutable refs
// ---------------------------------------------------------------------------

/**
 * Reset interrupt-related mutable state back to clean defaults.
 * Call this when transitioning away from the interrupted state
 * (e.g., starting a new workflow, cleaning up after completion).
 */
export function resetInterruptState(refs: {
  setIsInterrupted: (value: boolean) => void
  pendingInjection: { current: string | null }
  capturedWorkerSessionId: { current: string | undefined }
}): void {
  refs.setIsInterrupted(false)
  refs.pendingInjection.current = null
  refs.capturedWorkerSessionId.current = undefined
}
