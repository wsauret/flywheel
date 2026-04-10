/**
 * Shell Keyboard Handler — routes key events to the appropriate action.
 *
 * Extracted from FlywheelShell to keep the component focused on layout.
 * Pure function: takes all dependencies, returns a single handler.
 */

import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import type { ShellSignals } from "./shell-state.js"
import type { SessionStore } from "../../orchestration/session-store.js"
import type { WorkflowLifecycleHook } from "./use-workflow-lifecycle.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionModalHook } from "./use-session-modal.js"

export interface KeyboardHandlerDeps {
  signals: ShellSignals
  sessionStore: SessionStore
  workflow: WorkflowLifecycleHook
  chat: ChatModeHook
  sessionModal: SessionModalHook
  inChat: Accessor<boolean>
  runningCount: Accessor<number>
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export function createKeyboardHandler(deps: KeyboardHandlerDeps) {
  const { signals, sessionStore, workflow, chat, sessionModal, inChat, runningCount } = deps

  /** Tracks the last ESC timestamp for double-ESC escalation in chat mode. */
  let lastChatEscAt = 0

  function handleEscape(): void {
    // Pending work mode: cancel and return to whatever was underneath
    if (signals.pendingWorkCommand()) {
      signals.setPendingWorkCommand(undefined)
      return
    }

    const state = signals.sessionState()

    // Active workflow (not chat): first Esc pauses, second Esc aborts
    if (state === "active" && !inChat()) {
      workflow.pauseForeground()
      const bg = runningCount()
      if (bg > 0) deps.showToast({ message: `${bg} session${bg > 1 ? "s" : ""} still running in background`, variant: "info" })
      return
    }

    // In chat mode: first Esc interrupts, double-Esc (within 2s) force-ends session
    if (inChat()) {
      const now = Date.now()
      if (now - lastChatEscAt < 2_000) {
        // Double-ESC: force-end the session — the nuclear option
        lastChatEscAt = 0
        chat.endChat()
        deps.showToast({ message: "Chat force-ended", variant: "warning" })
        return
      }
      lastChatEscAt = now
      chat.interruptChat()
      return
    }

    // Paused with runner still alive (winding down): abort it
    if (state === "active") { workflow.abortForeground(); return }

    // Completed or paused (no runner): dismiss and return to welcome
    if (state === "completed" || state === "paused") {
      if (sessionModal.isViewingSession()) {
        sessionModal.dismissViewedSession()
        return
      }
      signals.setStatusLine("")
      signals.setErrorMessage("")
      signals.setForegroundId(undefined)
      deps.setTerminalTitle("flywheel")
      return
    }

    // Error state (errorMessage set, no foreground session): dismiss
    if (signals.errorMessage()) {
      signals.setErrorMessage("")
    }
  }

  return function handleKey(evt: { name: string; ctrl?: boolean; meta?: boolean }): void {
    if (sessionModal.sessionsModalOpen()) { sessionModal.handleModalKey(evt); return }

    if (evt.name === "escape") { handleEscape(); return }

    if (evt.ctrl && evt.name === "n") { chat.backgroundChat(); chat.startChat(); return }
    if (evt.ctrl && evt.name === "b") { sessionModal.openSessionsModal() }
    if (evt.ctrl && evt.name === "r") { workflow.handleResume() }
    if (evt.ctrl && evt.name === "c") {
      const hasWorkflows = sessionStore.allIds().some((id) => workflow.isWorkflowSession(id))
      if (!hasWorkflows) { exitTUI() }
    }
  }
}
