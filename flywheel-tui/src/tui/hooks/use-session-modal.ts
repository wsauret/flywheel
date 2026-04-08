/**
 * Session modal state and keyboard handling, extracted from shell.tsx.
 *
 * Manages the sessions modal overlay: open/close, cursor navigation,
 * and actions (view, resume, delete).
 */

import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { buildSessionList } from "../session-modal.js"
import { loadSessionOutput, deleteSession } from "../../orchestration/session-actions.js"
import { formatCost } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { SessionManager, SessionSummary } from "../../orchestration/session/manager.js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { AnyBlock } from "../types.js"

/** Snapshot of UI state captured before viewing a completed session. */
interface ViewSnapshot {
  outputBlocks: AnyBlock[]
  foregroundId: string | undefined
  sessionTitle: string
  statusLine: string
}

export interface SessionModalDeps {
  sessions: Accessor<SessionSummary[]>
  manager: SessionManager
  registry: SessionRegistry
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  outputBlocks: Accessor<AnyBlock[]>
  setOutputBlocks: (blocks: AnyBlock[]) => void
  sessionTitle: Accessor<string>
  setSessionTitle: (title: string) => void
  statusLine: Accessor<string>
  setStatusLine: (line: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
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
  handleModalKey(evt: any): void
  handleSessionView(sessionId: string): Promise<void>
  handleSessionResume(sessionId: string): void
  handleSessionDelete(sessionId: string): void
  /** Dismiss the viewed session and restore the UI state that existed before viewing. */
  dismissViewedSession(): void
}

export function useSessionModal(deps: SessionModalDeps): SessionModalHook {
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
    const entry = deps.registry.get(sessionId)
    if (entry) {
      // Switching to a live session — clear any viewed-session state so
      // isViewingSession() returns false and the UI isn't stuck in read-only mode.
      priorState = undefined
      viewedSessionId = undefined
      deps.switchForeground(sessionId)
      return
    }

    // Snapshot current state on the first view only — preserve the original
    // state across multiple view→delete cycles so we always restore back to
    // where the user was (e.g. mid-chat), not to an intermediate viewed session.
    if (!priorState) {
      priorState = {
        outputBlocks: deps.outputBlocks(),
        foregroundId: deps.foregroundId(),
        sessionTitle: deps.sessionTitle(),
        statusLine: deps.statusLine(),
      }
    }
    viewedSessionId = sessionId

    const blocks = await loadSessionOutput(sessionId)
    deps.setOutputBlocks(blocks)
    const { sessions: list } = deps.manager.list()
    const session = list.find(s => s.id === sessionId)
    if (session) {
      deps.setSessionTitle(session.label || session.name || sessionId.slice(0, 8))
      const cost = formatCost(session.totalCost)
      deps.setStatusLine(cost ? `Viewing session · ${cost}` : "Viewing session")
    }
    // Set foregroundId to the viewed session so sessionState() derives from the manager.
    // This lets the UI show the session's state (paused/completed) without a separate signal.
    deps.setForegroundId(sessionId)
  }

  function handleSessionResume(sessionId: string): void {
    setSessionsModalOpen(false)
    priorState = undefined
    viewedSessionId = undefined
    deps.handleResume(sessionId)
  }

  function handleSessionDelete(sessionId: string): void {
    try {
      deleteSession(sessionId, deps.actionDeps)
      setModalRefreshTrigger((n) => n + 1)
      deps.showToast({ message: "Session deleted", variant: "info" })
      // If we were viewing this session's transcript, restore prior state.
      if (viewedSessionId === sessionId) {
        restorePriorState()
      }
    } catch (err) {
      deps.showToast({ message: `Delete failed: ${extractErrorMessage(err)}`, variant: "error" })
    }
  }

  /** Restore the UI state that existed before handleSessionView was called. */
  function restorePriorState(): void {
    if (priorState) {
      deps.setOutputBlocks(priorState.outputBlocks)
      deps.setForegroundId(priorState.foregroundId)
      deps.setSessionTitle(priorState.sessionTitle)
      deps.setStatusLine(priorState.statusLine)
    }
    priorState = undefined
    viewedSessionId = undefined
  }

  function handleModalKey(evt: any): void {
    if (evt.name === "escape" || (evt.ctrl && evt.name === "b")) {
      evt.preventDefault()
      setSessionsModalOpen(false)
      setModalConfirmDelete(undefined)
      return
    }
    const items = buildSessionList(deps.sessions())
    const total = items.length
    if (total === 0) return

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      setModalCursor((c) => (c - 1 + total) % total)
      setModalConfirmDelete(undefined)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      setModalCursor((c) => (c + 1) % total)
      setModalConfirmDelete(undefined)
      return
    }
    const selected = items[modalCursor()]?.session
    if (!selected) return

    if (evt.name === "return") {
      evt.preventDefault()
      const isActive = selected.state === "active" && deps.registry.get(selected.id)
      if (isActive) {
        setSessionsModalOpen(false)
        priorState = undefined
        viewedSessionId = undefined
        deps.switchForeground(selected.id)
      } else {
        // Enter always views (read-only). Use 'r' to resume paused sessions.
        handleSessionView(selected.id)
      }
      return
    }
    if (evt.name === "r") {
      if (selected.state === "paused") { evt.preventDefault(); handleSessionResume(selected.id) }
      return
    }
    if (evt.name === "d" && selected.id !== deps.foregroundId()) {
      evt.preventDefault()
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
