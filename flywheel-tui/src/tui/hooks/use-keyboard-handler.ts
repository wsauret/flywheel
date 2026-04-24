import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"
import type { SessionStore } from "../../orchestration/session-store-types.js"
import type { SessionSummary } from "../../orchestration/session/manager.js"
import type { WorkflowLifecycleHook } from "./use-workflow-lifecycle.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import type { SessionModalHook } from "./use-session-modal.js"
import { TERMINAL_TITLE_BASE } from "../../infra/format.js"

interface KeyboardHandlerDeps {
  signals: ShellSignals
  sessionStore: SessionStore
  showToast: ShellServices["showToast"]
  setTerminalTitle: ShellServices["setTerminalTitle"]
  sessions: Accessor<SessionSummary[]>
  workflow: WorkflowLifecycleHook
  chat: ChatModeHook
  sessionModal: SessionModalHook
  inChat: Accessor<boolean>
  switchForeground: (sessionId: string) => void
}

export function createKeyboardHandler(deps: KeyboardHandlerDeps) {
  const { signals, sessionStore, showToast, setTerminalTitle, workflow, chat, sessionModal, inChat } = deps

  let lastChatEscAt = 0
  let lastWorkflowEscAt = 0

  function cycleSession(direction: 1 | -1): void {
    const cycleable = deps.sessions().filter(s => s.state === "active" || s.state === "paused")
    if (cycleable.length === 0) return
    const current = signals.foregroundId()
    const idx = current ? cycleable.findIndex(s => s.id === current) : -1
    if (idx === -1) {
      deps.switchForeground(cycleable[0]!.id)
      return
    }
    if (cycleable.length < 2) return
    const next = cycleable[(idx + direction + cycleable.length) % cycleable.length]!
    if (next.id !== current) deps.switchForeground(next.id)
  }

  const escapeModes: Array<{ active: () => boolean; handler: () => void }> = [
    {
      active: () => !!signals.pendingWorkCommand(),
      handler: () => signals.setPendingWorkCommand(undefined),
    },
    {
      active: () => signals.sessionState() === "active" && !inChat(),
      handler: () => {
        const now = Date.now()
        if (now - lastWorkflowEscAt < 2_000) {
          lastWorkflowEscAt = 0
          workflow.abortForeground()
          return
        }
        lastWorkflowEscAt = now
        workflow.pauseForeground()
      },
    },
    {
      active: () => inChat(),
      handler: () => {
        const now = Date.now()
        if (now - lastChatEscAt < 2_000) {
          lastChatEscAt = 0
          chat.endChat()
          showToast({ message: "Chat force-ended", variant: "warning" })
          return
        }
        lastChatEscAt = now
        chat.interruptChat()
      },
    },
    {
      active: () => {
        const s = signals.sessionState()
        return s === "completed" || s === "paused"
      },
      handler: () => {
        if (sessionModal.isViewingSession()) {
          sessionModal.dismissViewedSession()
          return
        }
        signals.setErrorMessage("")
        signals.setForegroundId(undefined)
        setTerminalTitle(TERMINAL_TITLE_BASE)
      },
    },
    {
      active: () => !!signals.errorMessage(),
      handler: () => signals.setErrorMessage(""),
    },
  ]

  function handleEscape(): void {
    if (signals.pendingQuestion()) return;
    for (const mode of escapeModes) {
      if (mode.active()) { mode.handler(); return }
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
