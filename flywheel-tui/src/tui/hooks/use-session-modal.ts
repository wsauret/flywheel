/**
 * Session modal state and keyboard handling, extracted from shell.tsx.
 *
 * Manages the sessions modal overlay: open/close, cursor navigation,
 * and actions (view, resume, delete).
 */

import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { buildSessionList } from "../session-modal.js"
import { loadSessionOutput } from "../../orchestration/session-actions.js"
import { formatCost } from "../../infra/format.js"
import type { SessionKind } from "../../orchestration/session/types.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { SessionSummary } from "../../orchestration/session/manager.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

/** Snapshot of UI state captured before viewing a completed session. */
interface ViewSnapshot {
  foregroundId: string | undefined
  statusLine: string
}

export interface SessionModalDeps {
  signals: ShellSignals
  services: ShellServices
  sessions: Accessor<SessionSummary[]>
  handleResume: (sessionId: string) => Promise<void>
  switchForeground: (sessionId: string) => void
  actionDeps: SessionActionDeps
}

export interface SessionModalHook {
  sessionsModalOpen: Accessor<boolean>
  modalCursor: Accessor<number>
  modalConfirmDelete: Accessor<string | undefined>
  /** Monotonically increasing counter — bumps on delete to refresh modal snapshot. */
  modalRefreshTrigger: Accessor<number>
  /** True when the user is viewing a historical session and prior state can be restored. */
  isViewingSession: Accessor<boolean>
  openSessionsModal(): void
  closeSessionsModal(): void
  selectModalItem(index: number): void
  handleModalKey(evt: { name: string; ctrl?: boolean; meta?: boolean }): void
  handleSessionView(sessionId: string): Promise<void>
  handleSessionResume(sessionId: string): void
  handleSessionDelete(sessionId: string): void
  /** Dismiss the viewed session and restore the UI state that existed before viewing. */
  dismissViewedSession(): void
}

export function useSessionModal(deps: SessionModalDeps): SessionModalHook {
  const { signals, services } = deps

  const [sessionsModalOpen, setSessionsModalOpen] = createSignal(false)
  const [modalCursor, setModalCursor] = createSignal(0)
  const [modalConfirmDelete, setModalConfirmDelete] = createSignal<string | undefined>()
  const [modalRefreshTrigger, setModalRefreshTrigger] = createSignal(0)

  // State saved before viewing a completed session, so we can restore on dismiss.
  let priorState: ViewSnapshot | undefined
  let viewedSessionId: string | undefined

  function openSessionsModal(): void {
    setSessionsModalOpen(true)
    setModalCursor(0)
    setModalConfirmDelete(undefined)
  }

  function closeSessionsModal(): void {
    setSessionsModalOpen(false)
  }

  function selectModalItem(index: number): void {
    setModalCursor(index)
    setModalConfirmDelete(undefined)
  }

  async function handleSessionView(sessionId: string): Promise<void> {
    setSessionsModalOpen(false)

    // Running sessions — switch foreground directly (no save/restore needed)
    if (services.sessionStore.isRunning(sessionId)) {
      priorState = undefined
      viewedSessionId = undefined
      deps.switchForeground(sessionId)
      return
    }

    // Ended or historical session — enter "viewing" mode with save/restore
    // Snapshot current state on the first view only — preserve the original
    // state across multiple view→delete cycles so we always restore back to
    // where the user was (e.g. mid-chat), not to an intermediate viewed session.
    if (!priorState) {
      priorState = {
        foregroundId: signals.foregroundId(),
        statusLine: signals.statusLine(),
      }
    }
    viewedSessionId = sessionId

    // Load into session store if not already present (ended sessions from this
    // TUI run are already there; historical sessions need loading from disk).
    if (!services.sessionStore.has(sessionId)) {
      const blocks = await loadSessionOutput(sessionId)
      const { sessions: list } = services.manager.list()
      const session = list.find(s => s.id === sessionId)
      services.sessionStore.load(sessionId, {
        kind: (session?.kind ?? "workflow") as SessionKind,
        description: session?.label || session?.name || sessionId.slice(0, 8),
        outputBlocks: blocks,
        tokens: session?.totalTokens,
        cost: session?.totalCost,
      })
    }

    // Set foregroundId so the store entry's outputBlocks drive the UI
    signals.setForegroundId(sessionId)
    const entry = services.sessionStore.get(sessionId)
    if (entry) {
      const cost = formatCost(entry.cost)
      signals.setStatusLine(cost ? `Viewing session \u00b7 ${cost}` : "Viewing session")
    }
  }

  function handleSessionResume(sessionId: string): void {
    setSessionsModalOpen(false)
    priorState = undefined
    viewedSessionId = undefined
    deps.handleResume(sessionId)
  }

  function handleSessionDelete(sessionId: string): void {
    try {
      deps.actionDeps.manager.delete(sessionId)
      services.refreshList()
      setModalRefreshTrigger((n) => n + 1)
      services.showToast({ message: "Session deleted", variant: "info" })
      // If we were viewing this session's transcript, restore prior state.
      if (viewedSessionId === sessionId) {
        restorePriorState()
      }
    } catch (err) {
      services.showToast({ message: `Delete failed: ${extractErrorMessage(err)}`, variant: "error" })
    }
  }

  /** Restore the UI state that existed before handleSessionView was called. */
  function restorePriorState(): void {
    if (priorState) {
      signals.setForegroundId(priorState.foregroundId)
      signals.setStatusLine(priorState.statusLine)
    }
    priorState = undefined
    viewedSessionId = undefined
  }

  function handleModalKey(evt: { name: string; ctrl?: boolean; meta?: boolean; preventDefault?: () => void }): void {
    if (evt.name === "escape" || (evt.ctrl && evt.name === "b")) {
      evt.preventDefault?.()
      setSessionsModalOpen(false)
      setModalConfirmDelete(undefined)
      return
    }
    const items = buildSessionList(deps.sessions())
    const total = items.length
    if (total === 0) return

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault?.()
      setModalCursor((c) => (c - 1 + total) % total)
      setModalConfirmDelete(undefined)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault?.()
      setModalCursor((c) => (c + 1) % total)
      setModalConfirmDelete(undefined)
      return
    }
    const selected = items[modalCursor()]?.session
    if (!selected) return

    if (evt.name === "return") {
      evt.preventDefault?.()
      // Enter always views (read-only). Use 'r' to resume paused sessions.
      // handleSessionView internally distinguishes running vs ended/historical.
      handleSessionView(selected.id)
      return
    }
    if (evt.name === "r") {
      if (selected.state === "paused") { evt.preventDefault?.(); handleSessionResume(selected.id) }
      return
    }
    if (evt.name === "d" && selected.id !== signals.foregroundId()) {
      evt.preventDefault?.()
      if (modalConfirmDelete() === selected.id) { setModalConfirmDelete(undefined); handleSessionDelete(selected.id) }
      else { setModalConfirmDelete(selected.id) }
    }
  }

  function dismissViewedSession(): void {
    restorePriorState()
  }

  const isViewingSession: Accessor<boolean> = () => viewedSessionId !== undefined

  return {
    sessionsModalOpen,
    modalCursor,
    modalConfirmDelete,
    modalRefreshTrigger,
    isViewingSession,
    openSessionsModal,
    closeSessionsModal,
    selectModalItem,
    handleModalKey,
    handleSessionView,
    handleSessionResume,
    handleSessionDelete,
    dismissViewedSession,
  }
}
