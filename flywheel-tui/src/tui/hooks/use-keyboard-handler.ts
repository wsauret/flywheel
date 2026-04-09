/**
 * Shell Keyboard Handler — routes key events to the appropriate action.
 *
 * Extracted from FlywheelShell to keep the component focused on layout.
 * Pure function: takes all dependencies, returns a single handler.
 */

import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import type { ShellSignals } from "./shell-state.js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { WorkflowLifecycleHook } from "./use-workflow-lifecycle.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionModalHook } from "./use-session-modal.js"

export interface KeyboardHandlerDeps {
  signals: ShellSignals
  registry: SessionRegistry
  workflow: WorkflowLifecycleHook
  chat: ChatModeHook
  sessionModal: SessionModalHook
  inChat: Accessor<boolean>
  runningCount: Accessor<number>
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export function createKeyboardHandler(deps: KeyboardHandlerDeps) {
  const { signals, registry, workflow, chat, sessionModal, inChat, runningCount } = deps

  function handleEscape(): void {
    const state = signals.sessionState()

    // Active workflow (not chat): first Esc pauses, second Esc aborts
    if (state === "active" && !inChat()) {
      workflow.pauseForeground()
      const bg = runningCount()
      if (bg > 0) deps.showToast({ message: `${bg} session${bg > 1 ? "s" : ""} still running in background`, variant: "info" })
      return
    }

    // In chat mode, Esc interrupts the active worker — never ends the session.
    if (inChat()) {
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
    if (evt.ctrl && evt.name === "w") {
      if (inChat()) { chat.endChat(); chat.startChat(); return }
      workflow.abortForeground()
      return
    }
    if (evt.ctrl && evt.name === "b") { sessionModal.openSessionsModal() }
    if (evt.ctrl && evt.name === "r") { workflow.handleResume() }
    if (evt.ctrl && evt.name === "c") {
      const hasWorkflows = registry.allIds().some((id) => workflow.isWorkflowSession(id))
      if (!hasWorkflows) { exitTUI() }
    }
  }
}
