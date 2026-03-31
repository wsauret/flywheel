/**
 * Keyboard controller — extracted from flywheel-shell.tsx
 *
 * Contains the shell-level keyboard shortcut handler as a pure function.
 * All dependencies are injected via the `KeyboardContext` parameter —
 * no SolidJS signals or component-level state captured in closures.
 */

import type { KeyEvent } from "@opentui/core"
import type { AppState } from "./shell-modes"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState } from "../types"
import type { WorkflowSession } from "../session/workflow-session"
import type { QuestionRequest } from "../../queue/question-service"
import type { SelectionAction } from "../session/sidebar-logic"
import type { SessionSummary } from "../../session/manager"
import { sidebarKeyHandler } from "../session/sidebar-logic"
import { Selection } from "../utils/selection"
import { ctrlCForState } from "./shell-modes"

// ---------------------------------------------------------------------------
// Toast + Renderer duck types (avoids importing context providers)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

export interface RendererLike {
  getSelection(): { getSelectedText(): string } | null
  clearSelection(): void
}

// ---------------------------------------------------------------------------
// KeyboardContext — dependency bundle for handleShellKeyEvent
// ---------------------------------------------------------------------------

export interface KeyboardContext {
  // State accessors
  appState(): AppState
  sidebarFocused(): boolean
  isPromptFocused(): boolean
  showStopModal(): boolean
  showQuitModal(): boolean
  approvalPending(): boolean
  pendingQuestion(): QuestionRequest | null
  isSessionResumable(): boolean
  viewedSessionId(): string | null
  sessions(): SessionSummary[]
  sidebarSelectedIndex(): number
  activeStore(): UIActions | null
  workState(): WorkState | null
  isInterrupted(): boolean
  runtimesSize: number
  sidebarVisible: boolean

  // State setters
  setSidebarSelectedIndex(idx: number): void
  setIsPromptFocused(v: boolean): void
  setSidebarFocused(v: boolean): void
  setShowQuitModal(v: boolean): void

  // Actions
  handleSessionSelect(sessionId: string, action: SelectionAction): void
  backgroundSession(): void
  handleEscape(): void
  resumeSession(sessionId: string): void
  exitTUI(): void
  stopWorkflow(): Promise<void>
  returnToIdle(): void

  // TUI helpers
  activeSession: WorkflowSession | null
  renderer: RendererLike
  toast: ToastLike
  dimensions(): { width: number; height: number } | undefined
}

// ---------------------------------------------------------------------------
// handleShellKeyEvent — the extracted keyboard callback body
// ---------------------------------------------------------------------------

export function handleShellKeyEvent(evt: KeyEvent, ctx: KeyboardContext): void {
  // === Sidebar-focused key routing ===
  // When sidebar has focus, intercept navigation keys before anything else.
  // Modal guards: sidebar focus is disabled when stop/error/approval modals are open.
  if (ctx.sidebarFocused() && !ctx.showStopModal() && !ctx.showQuitModal() && !ctx.approvalPending() && !ctx.pendingQuestion()) {
    if (evt.name === "up") {
      evt.preventDefault()
      const result = sidebarKeyHandler("move-up", ctx.sessions(), ctx.sidebarSelectedIndex())
      ctx.setSidebarSelectedIndex(result.selectedIndex)
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      const result = sidebarKeyHandler("move-down", ctx.sessions(), ctx.sidebarSelectedIndex())
      ctx.setSidebarSelectedIndex(result.selectedIndex)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      const result = sidebarKeyHandler("select", ctx.sessions(), ctx.sidebarSelectedIndex())
      if (result.selectedSessionId && result.action) {
        ctx.handleSessionSelect(result.selectedSessionId, result.action)
      }
      return
    }
    if (evt.name === "delete" || evt.name === "backspace") {
      evt.preventDefault()
      const result = sidebarKeyHandler("delete", ctx.sessions(), ctx.sidebarSelectedIndex())
      if (result.selectedSessionId && result.action) {
        ctx.handleSessionSelect(result.selectedSessionId, result.action)
      }
      return
    }
    if (evt.name === "escape" || evt.name === "tab") {
      evt.preventDefault()
      ctx.setSidebarFocused(false)
      return
    }
  }

  // === Work-mode shortcuts (only active when working) ===
  if (ctx.appState() === "working" && ctx.activeStore()) {
    // Ctrl+B: background session (minimize to sidebar, keep running)
    if (evt.ctrl && evt.name === "b") {
      evt.preventDefault()
      ctx.backgroundSession()
      return
    }

    // Ctrl+D: toggle raw output mode
    if (evt.ctrl && evt.name === "d") {
      evt.preventDefault()
      if (ctx.activeSession) {
        const nowRaw = ctx.activeSession.adapter.toggleRawMode()
        ctx.toast.show({
          message: nowRaw ? "Raw output: ON" : "Raw output: OFF",
          variant: "info",
          duration: 2000,
        })
      }
      return
    }

    // Up/Down: step navigation (only when not prompt or sidebar focused)
    if (!ctx.isPromptFocused() && !ctx.sidebarFocused()) {
      if (evt.name === "up") {
        evt.preventDefault()
        ctx.activeStore()!.selectPrevious()
        return
      }
      if (evt.name === "down") {
        evt.preventDefault()
        ctx.activeStore()!.selectNext()
        return
      }

      // Right arrow: focus prompt (when approval pending)
      if (evt.name === "right" && ctx.workState()?.approvalState?.pending) {
        evt.preventDefault()
        ctx.setIsPromptFocused(true)
        ctx.setSidebarFocused(false)
        return
      }
    }
  }
  // === End work-mode shortcuts ===

  // === Resume key: Ctrl+R (always) or 'r' (when prompt unfocused) ===
  if (
    ctx.appState() === "completed" &&
    !ctx.showStopModal() &&
    ctx.isSessionResumable() &&
    (
      // Ctrl+R works regardless of focus state
      (evt.name === "r" && evt.ctrl && !evt.meta) ||
      // Plain 'r' only when prompt/sidebar not focused (avoids swallowing typing)
      (evt.name === "r" && !evt.ctrl && !evt.meta && !ctx.isPromptFocused() && !ctx.sidebarFocused())
    )
  ) {
    evt.preventDefault()
    const vid = ctx.viewedSessionId()
    if (vid) {
      ctx.resumeSession(vid)
    }
    return
  }

  // Tab: cycle focus zones — prompt → sidebar → output → prompt
  // (sidebar is skipped when not visible or no sessions exist)
  if (evt.name === "tab" && !ctx.showStopModal() && !ctx.approvalPending() && !ctx.pendingQuestion()) {
    evt.preventDefault()

    if (ctx.isPromptFocused()) {
      // prompt → sidebar (if visible) or output
      ctx.setIsPromptFocused(false)
      ctx.setSidebarFocused(ctx.sidebarVisible)
    } else if (ctx.sidebarFocused()) {
      // sidebar → output
      ctx.setSidebarFocused(false)
    } else {
      // output → prompt
      ctx.setIsPromptFocused(true)
    }
    return
  }

  // Escape: handle at shell level for non-idle states.
  // "completed" is included because the prompt may not always capture Escape
  // (e.g., when viewing a read-only session and prompt focus is ambiguous).
  // When a question is pending, let the QuestionPrompt handle Escape (to dismiss the question).
  if (evt.name === "escape" && !ctx.pendingQuestion()) {
    const currentState = ctx.appState()
    if (currentState === "working" || currentState === "completed") {
      evt.preventDefault()
      ctx.handleEscape()
      return
    }
  }

  // Ctrl+C: copy selection if active, otherwise state-based behavior
  if (evt.ctrl && evt.name === "c") {
    if (ctx.renderer.getSelection()) {
      evt.preventDefault()
      if (!Selection.copy(ctx.renderer as any, ctx.toast as any)) {
        ctx.renderer.clearSelection()
      }
      return
    }
    evt.preventDefault()
    const behavior = ctrlCForState(ctx.appState())
    switch (behavior) {
       case "exit-tui":
        if (ctx.runtimesSize > 0) {
          ctx.setShowQuitModal(true)
        } else {
          ctx.exitTUI()
        }
        return
      case "stop-workflow":
        ctx.stopWorkflow()
        return
      case "return-idle":
        ctx.returnToIdle()
        return
    }
    return
  }
}
