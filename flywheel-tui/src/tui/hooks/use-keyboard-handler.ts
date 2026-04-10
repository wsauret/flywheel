/**
 * Shell Keyboard Handler — routes key events to the appropriate action.
 *
 * Extracted from FlywheelShell to keep the component focused on layout.
 * Pure function: takes all dependencies, returns a single handler.
 */

import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import type { ShellSignals } from "./shell-state.js"
import type { SessionStore } from "../../orchestration/session-store-types.js"
import type { SessionSummary } from "../../orchestration/session/manager.js"
import type { WorkflowLifecycleHook } from "./use-workflow-lifecycle.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionModalHook } from "./use-session-modal.js"

export interface KeyboardHandlerDeps {
  signals: ShellSignals
  sessionStore: SessionStore
  sessions: Accessor<SessionSummary[]>
  workflow: WorkflowLifecycleHook
  chat: ChatModeHook
  sessionModal: SessionModalHook
  inChat: Accessor<boolean>
  runningCount: Accessor<number>
  switchForeground: (sessionId: string) => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export function createKeyboardHandler(deps: KeyboardHandlerDeps) {
  const { signals, sessionStore, workflow, chat, sessionModal, inChat, runningCount } = deps

  /** Tracks the last ESC timestamp for double-ESC escalation in chat mode. */
  let lastChatEscAt = 0

  /** Cycle foreground through active + paused sessions (from the canonical session list). */
  function cycleSession(direction: 1 | -1): void {
    const cycleable = deps.sessions().filter(s => s.state === "active" || s.state === "paused")
    if (cycleable.length < 2) return
    const current = signals.foregroundId()
    const idx = current ? cycleable.findIndex(s => s.id === current) : -1
    const next = idx === -1
      ? cycleable[0]!
      : cycleable[(idx + direction + cycleable.length) % cycleable.length]!
    if (next.id !== current) deps.switchForeground(next.id)
  }

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

  return function handleKey(evt: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    if (sessionModal.sessionsModalOpen()) { sessionModal.handleModalKey(evt); return }

    if (evt.name === "escape") { handleEscape(); return }

    if (evt.name === "tab" || evt.name === "shift-tab") {
      cycleSession(evt.name === "shift-tab" || evt.shift ? -1 : 1)
      return
    }

    if (evt.ctrl && evt.name === "n") { chat.backgroundChat(); chat.startChat(); return }
    if (evt.ctrl && evt.name === "b") { sessionModal.openSessionsModal() }
    if (evt.ctrl && evt.name === "r") { workflow.handleResume() }
    if (evt.ctrl && evt.name === "c") {
      const hasWorkflows = sessionStore.allIds().some((id) => workflow.isWorkflowSession(id))
      if (!hasWorkflows) { exitTUI() }
    }
  }
}
