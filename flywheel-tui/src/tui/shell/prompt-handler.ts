/**
 * Prompt handler — extracted from flywheel-shell.tsx
 *
 * Contains the prompt input handling logic as a factory function.
 * All dependencies are injected via the `PromptHandlerDeps` parameter —
 * no SolidJS signals or component-level state captured in closures.
 *
 * Exports:
 *   - `createPromptHandler(deps)` — factory returning handlePromptInput,
 *     handleCommand, and handleApprovalDecision
 */

import { parseCommand } from "../utils/command-parser"
import { formatStdinMessage } from "../../worker/stdin-format"
import { Log } from "../../utils/log"

import type { AppState } from "./shell-modes"
import type { WorkState } from "../types"
import type { StdinHandle } from "../../worker/spawner"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { WorkflowSession } from "../session/workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"

const log = Log.create({ service: "shell" })

// ---------------------------------------------------------------------------
// Toast duck type (avoids importing the context provider)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// PromptHandlerDeps — dependency bundle for createPromptHandler
// ---------------------------------------------------------------------------

export interface PromptHandlerDeps {
  // State accessors
  appState: () => AppState
  workState: () => WorkState | null
  isSessionResumable: () => boolean
  viewedSessionId: () => string | null
  isInterrupted: () => boolean
  activeStore: () => UIActions | null
  isQueueRunning: () => boolean

  // Mutable refs
  activeStdinHandleRef: { current: StdinHandle | null }
  pendingInjection: { current: string | null }

  // Session accessor
  getActiveSession: () => WorkflowSession | null
  getDepsOrWarn: () => WorkflowDeps | null

  // Actions
  toast: ToastLike
  resumeSession: (id: string) => void
  resumeWorkerWithMessage: (message: string) => void

  // Chat
  sendChatMessage?: (text: string) => void

  // Dispatch (from createActionDispatcher)
  dispatch: (workflow: string, args: Record<string, string>) => { stepLabel: string; workflowName: string } | null

  // Setters
  setActiveStepLabel: (label: string) => void
  setActiveWorkflowName: (name: string) => void
}

// ---------------------------------------------------------------------------
// createPromptHandler — factory that returns prompt handling functions
// ---------------------------------------------------------------------------

/**
 * Create a prompt handler bundle.
 *
 * Returns three functions extracted from the FlywheelShell component:
 *   - `handlePromptInput(input)` — routes idle/completed/working input
 *   - `handleCommand(workflow, args)` — dispatches a command via ActionDispatcher
 *   - `handleApprovalDecision(approved, skip?)` — delegates approval to adapter
 */
export function createPromptHandler(deps: PromptHandlerDeps) {
  const {
    appState,
    workState,
    isSessionResumable,
    viewedSessionId,
    isInterrupted,
    activeStore,
    isQueueRunning,
    activeStdinHandleRef,
    pendingInjection,
    getActiveSession,
    getDepsOrWarn,
    toast,
    resumeSession,
    resumeWorkerWithMessage,
    dispatch,
    setActiveStepLabel,
    setActiveWorkflowName,
  } = deps

  // ── handleCommand ──

  const handleCommand = (workflow: string, args: Record<string, string>) => {
    const meta = dispatch(workflow, args)
    if (meta) {
      setActiveStepLabel(meta.stepLabel)
      if (!isQueueRunning()) {
        setActiveWorkflowName(meta.workflowName)
      }
    }
  }

  // ── handlePromptInput ──

  const handlePromptInput = (input: string) => {
    const currentAppState = appState()

    // Chatting state: route to chat session or parse as command
    if (currentAppState === "chatting") {
      const trimmed = input.trim()
      if (!trimmed) return

      // Slash commands work during chat
      if (trimmed.startsWith("/")) {
        const result = parseCommand(trimmed)
        if (result) {
          handleCommand(result.workflow, result.args)
          return
        }
        toast.show({ message: `Unknown command: ${trimmed}`, variant: "error" })
        return
      }

      // Route to chat controller
      deps.sendChatMessage?.(trimmed)
      return
    }

    if (currentAppState === "idle" || currentAppState === "completed") {
      const trimmed = input.trim()

      // In completed state with a resumable session: sending a non-empty
      // message resumes the paused session instead of parsing commands.
      if (currentAppState === "completed" && isSessionResumable() && trimmed && !trimmed.startsWith("/")) {
        const vid = viewedSessionId()
        if (vid) {
          resumeSession(vid)
          return
        }
      }

      // Command mode: parse like the old LauncherView
      if (!trimmed) return

      const result = parseCommand(trimmed)

      if (result === null) {
        // If it doesn't start with / and looks like a file path, treat as /work <path>
        if (!trimmed.startsWith("/") && (trimmed.includes(".") || trimmed.includes("/"))) {
          handleCommand("work", { planPath: trimmed })
          return
        }
        const message = trimmed.startsWith("/")
          ? `Unknown command: ${trimmed}. Try /work, /plan, /review, /ship`
          : `Commands start with /. Try /work ${trimmed}`
        toast.show({ message, variant: "error" })
        return
      }

      handleCommand(result.workflow, result.args)
      return
    }

    if (currentAppState === "working") {
      const state = workState()
      if (state?.approvalState?.pending) {
        // Active mode: approval handling (approve with optional steering prompt)
        const session = getActiveSession()
        if (session) {
          session.adapter.onApprovalDecision?.(true)
        }
        activeStore()?.clearApproval()
      } else if (input.trim()) {
        const message = input.trim()

        if (isInterrupted()) {
          // Interrupted state: user typed text after first Esc (SIGINT).
          // Resume the worker by spawning a new process with --resume
          // and the user's message as stdin content.
          resumeWorkerWithMessage(message)
          return
        }

        // Working mode without approval: inject message into running worker's stdin
        const handle = activeStdinHandleRef.current
        if (handle && handle.isOpen) {
          // Write directly to the worker. For engines with streaming input
          // (Claude stream-json, Droid stream-json), wrap in engine-specific
          // NDJSON format. For SDK engines (OpenCode), send raw text —
          // the SDK handle wraps it in its own API format.
          const wfDeps = getDepsOrWarn()
          const payload = wfDeps?.engine.metadata.supportsStreamingInput
            ? formatStdinMessage(wfDeps.engine.metadata.id, message)
            : message
          const written = handle.write(payload)
          if (written) {
            log.info("message injected into worker stdin", { length: message.length })
          } else {
            log.warn("stdin write failed — pipe closed between check and write")
            pendingInjection.current = message
            toast.show({ message: "Message queued for next turn", variant: "info", duration: 2000 })
          }
          // Emit worker:injected event for TUI display
          const session = getActiveSession()
          if (session) {
            session.eventBus.emit({
              type: "worker:injected",
              workflowId: "",
              message,
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          log.info("no stdin handle available for injection — queuing for next turn")
          pendingInjection.current = message
          toast.show({ message: "Message queued for next turn", variant: "info", duration: 2000 })
        }
      }
      return
    }
  }

  // ── handleApprovalDecision ──

  const handleApprovalDecision = (approved: boolean, skip?: boolean) => {
    const session = getActiveSession()
    if (session) {
      session.adapter.onApprovalDecision?.(approved, skip)
    }
  }

  return {
    handlePromptInput,
    handleCommand,
    handleApprovalDecision,
  }
}
