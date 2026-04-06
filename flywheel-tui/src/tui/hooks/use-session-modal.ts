/**
 * Session modal state and keyboard handling, extracted from shell.tsx.
 *
 * Manages the sessions modal overlay: open/close, cursor navigation,
 * and actions (view, resume, archive, delete).
 */

import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { buildSessionList } from "../session-modal.js"
import { loadSessionOutput, archiveSession, deleteSession } from "../../orchestration/session-actions.js"
import { formatCost } from "../format.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { SessionManager, SessionSummary } from "../../orchestration/session/manager.js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { AnyBlock } from "../types.js"
import type { SessionStatus } from "./use-workflow-lifecycle.js"

export interface SessionModalDeps {
  sessions: Accessor<SessionSummary[]>
  manager: SessionManager
  refreshList: () => void
  registry: SessionRegistry
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  setSessionStatus: (status: SessionStatus) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSessionTitle: (title: string) => void
  setStatusLine: (line: string) => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
  handleResume: (sessionId: string) => Promise<void>
  switchForeground: (sessionId: string) => void
  actionDeps: SessionActionDeps
}

export interface SessionModalHook {
  sessionsModalOpen: Accessor<boolean>
  modalCursor: Accessor<number>
  modalConfirmDelete: Accessor<string | undefined>
  openSessionsModal(): void
  closeSessionsModal(): void
  selectModalItem(index: number): void
  handleModalKey(evt: any): void
  handleSessionView(sessionId: string): Promise<void>
  handleSessionResume(sessionId: string): void
  handleSessionArchive(sessionId: string): void
  handleSessionDelete(sessionId: string): void
}

export function useSessionModal(deps: SessionModalDeps): SessionModalHook {
  const [sessionsModalOpen, setSessionsModalOpen] = createSignal(false)
  const [modalCursor, setModalCursor] = createSignal(0)
  const [modalConfirmDelete, setModalConfirmDelete] = createSignal<string | undefined>()

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
    if (entry) { deps.switchForeground(sessionId); return }
    const blocks = await loadSessionOutput(sessionId)
    deps.setOutputBlocks(blocks)
    const { sessions: list } = deps.manager.list()
    const session = list.find(s => s.id === sessionId)
    if (session) {
      deps.setSessionTitle(session.label || session.name || sessionId.slice(0, 8))
      deps.setStatusLine(`Viewing session · ${formatCost(session.totalCost)}`)
    }
    deps.setForegroundId(undefined)
    deps.setSessionStatus("completed")
  }

  function handleSessionResume(sessionId: string): void {
    setSessionsModalOpen(false)
    deps.handleResume(sessionId)
  }

  function handleSessionArchive(sessionId: string): void {
    try {
      archiveSession(sessionId, deps.actionDeps)
      deps.showToast({ message: "Session archived", variant: "info" })
    } catch (err) {
      deps.showToast({ message: `Cannot archive: ${extractErrorMessage(err)}`, variant: "error" })
    }
  }

  function handleSessionDelete(sessionId: string): void {
    try {
      deleteSession(sessionId, deps.actionDeps)
      deps.showToast({ message: "Session deleted", variant: "info" })
    } catch (err) {
      deps.showToast({ message: `Delete failed: ${extractErrorMessage(err)}`, variant: "error" })
    }
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
      if (selected.lifecycleState === "work:active" && deps.registry.get(selected.id)) {
        setSessionsModalOpen(false)
        deps.switchForeground(selected.id)
      } else if (selected.lifecycleState === "work:paused" || selected.lifecycleState === "budget_exhausted") {
        handleSessionResume(selected.id)
      } else {
        handleSessionView(selected.id)
      }
      return
    }
    if (evt.name === "r") {
      if (selected.lifecycleState === "work:paused" || selected.lifecycleState === "budget_exhausted") { evt.preventDefault(); handleSessionResume(selected.id) }
      return
    }
    if (evt.name === "a" && selected.lifecycleState === "completed") {
      evt.preventDefault(); handleSessionArchive(selected.id); return
    }
    if (evt.name === "d" && selected.id !== deps.foregroundId()) {
      evt.preventDefault()
      if (modalConfirmDelete() === selected.id) { setModalConfirmDelete(undefined); handleSessionDelete(selected.id) }
      else { setModalConfirmDelete(selected.id) }
    }
  }

  return {
    sessionsModalOpen,
    modalCursor,
    modalConfirmDelete,
    openSessionsModal,
    closeSessionsModal,
    selectModalItem,
    handleModalKey,
    handleSessionView,
    handleSessionResume,
    handleSessionArchive,
    handleSessionDelete,
  }
}
