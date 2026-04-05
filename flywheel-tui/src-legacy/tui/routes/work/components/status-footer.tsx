/** @jsxImportSource @opentui/solid */
/**
 * Status Footer Component
 *
 * Show context-sensitive keyboard shortcuts at bottom of screen.
 * During working state: queue-relevant shortcuts (Esc stop, navigate, etc.)
 * During idle/completed: standard shortcuts.
 *
 * VAL-TUI-014: Footer shows queue shortcuts during working state
 */

import { useTheme } from "@tui/shared/context/theme"
import { resolveFooterShortcuts } from "../../../utils/footer-shortcuts"
import type { AppState } from "../../../shell/shell-modes"

export interface StatusFooterProps {
  /** Current app state — determines which shortcut set to display. */
  appState?: AppState
  approvalPending?: boolean
  isPromptFocused?: boolean
  sidebarFocused?: boolean
  /** Whether the sidebar is visible (terminal >= 90 cols and sessions exist). */
  sidebarVisible?: boolean
  /** Whether the currently viewed session is resumable (work:paused). */
  isSessionResumable?: boolean
  /** Whether a workflow is actively running (show background hint). */
  isWorking?: boolean
  /** Whether the worker is in an interrupted state (first Esc, awaiting resume). */
  isInterrupted?: boolean
}

/**
 * Show keyboard shortcuts at bottom of screen.
 * Content adapts based on current app state and interaction mode.
 */
export function StatusFooter(props: StatusFooterProps) {
  const themeCtx = useTheme()

  const shortcutText = () => resolveFooterShortcuts({
    appState: props.appState ?? (props.isWorking ? "working" : "idle"),
    approvalPending: props.approvalPending,
    isPromptFocused: props.isPromptFocused,
    sidebarFocused: props.sidebarFocused,
    sidebarVisible: props.sidebarVisible,
    isSessionResumable: props.isSessionResumable,
    isWorking: props.isWorking,
    isInterrupted: props.isInterrupted,
  })

  return (
    <box paddingLeft={1} paddingRight={1}>
      <text fg={themeCtx.theme.textMuted}>
        {shortcutText()}
      </text>
    </box>
  )
}
