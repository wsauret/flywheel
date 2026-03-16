/**
 * Work Keyboard Handler
 *
 * Key bindings for the work view:
 * - Tab: toggle panel collapse
 * - Ctrl+S: skip current phase
 * - Esc: toggle stop modal (or exit prompt focus)
 * - Ctrl+T: toggle theme
 * - Right: focus prompt (when approval pending)
 * - P: pause (reserved)
 * - Up/Down: phase navigation (selectNext/selectPrevious)
 */

import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import type { UIActions } from "../context/ui-state/types"
import type { Accessor, Setter } from "solid-js"
import type { WorkState } from "../state/types"

export interface UseWorkKeyboardOptions {
  actions: UIActions
  showStopModal: Accessor<boolean>
  setShowStopModal: Setter<boolean>
  state: Accessor<WorkState>
  timelineCollapsed: Accessor<boolean>
  setTimelineCollapsed: Setter<boolean>
  isPromptFocused: Accessor<boolean>
  setIsPromptFocused: Setter<boolean>
  onSkip?: () => void
  onToggleRawMode?: () => void
}

export function useWorkKeyboard(options: UseWorkKeyboardOptions): void {
  const themeCtx = useTheme()

  useKeyboard((evt) => {
    // === GLOBAL SHORTCUTS (always work, even in prompt focus) ===

    // Tab: toggle panel collapse
    if (evt.name === "tab") {
      evt.preventDefault()
      options.setTimelineCollapsed((prev) => !prev)
      return
    }

    // Ctrl+S: skip current phase
    if (evt.ctrl && evt.name === "s") {
      evt.preventDefault()
      options.onSkip?.()
      return
    }

    // Ctrl+D: toggle raw output mode
    if (evt.ctrl && evt.name === "d") {
      evt.preventDefault()
      options.onToggleRawMode?.()
      return
    }

    // === PROMPT FOCUSED: only handle Escape to exit ===
    if (options.isPromptFocused()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        options.setIsPromptFocused(false)
      }
      return // Let prompt input handle everything else
    }

    // === MODAL BLOCKING: let modal handle its own keys ===
    if (options.showStopModal()) return

    // Escape: show stop modal
    if (evt.name === "escape") {
      evt.preventDefault()
      options.setShowStopModal((prev) => !prev)
      return
    }

    // Ctrl+T: toggle theme
    if (evt.ctrl && evt.name === "t") {
      evt.preventDefault()
      themeCtx.setMode(themeCtx.mode === "dark" ? "light" : "dark")
      return
    }

    // Right arrow: focus prompt (when approval pending)
    if (evt.name === "right") {
      if (options.state().approvalState.pending) {
        evt.preventDefault()
        options.setIsPromptFocused(true)
        return
      }
    }

    // P: pause (reserved — no-op until event bus supports pause/resume)
    if (evt.name === "p") {
      evt.preventDefault()
      return
    }

    // Navigation
    if (evt.name === "up") {
      evt.preventDefault()
      options.actions.selectPrevious()
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      options.actions.selectNext()
      return
    }
  })
}
