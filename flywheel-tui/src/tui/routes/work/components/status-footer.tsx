/** @jsxImportSource @opentui/solid */
/**
 * Status Footer Component
 *
 * Show context-sensitive keyboard shortcuts at bottom of screen
 */

import { useTheme } from "@tui/shared/context/theme"

export interface StatusFooterProps {
  approvalPending?: boolean
  isPromptFocused?: boolean
  sidebarFocused?: boolean
  /** Whether the sidebar is visible (terminal >= 90 cols and sessions exist). */
  sidebarVisible?: boolean
  /** Whether the currently viewed session is resumable (work:paused). */
  isSessionResumable?: boolean
  /** Whether a workflow is actively running (show background hint). */
  isWorking?: boolean
}

/**
 * Show keyboard shortcuts at bottom of screen.
 * Content adapts based on current interaction mode.
 */
export function StatusFooter(props: StatusFooterProps) {
  const themeCtx = useTheme()

  const shortcutText = () => {
    if (props.sidebarFocused) {
      return "[\u2191\u2193] Navigate  [Enter] Select  [Del] Delete  [Esc/Tab] Exit Sidebar"
    }
    if (props.isPromptFocused) {
      return "[Esc] Exit Prompt  [Enter] Continue/Send  [Ctrl+S] Skip  [Ctrl+D] Raw"
    }
    const sidebarHint = props.sidebarVisible ? "[Tab] Sidebar  " : ""
    const resumeHint = props.isSessionResumable ? "[R] Resume  " : ""
    const bgHint = props.isWorking ? "[Ctrl+B] Background  " : ""
    if (props.approvalPending) {
      return `[Right] Focus Prompt  ${sidebarHint}${bgHint}[\u2191\u2193] Navigate  [Ctrl+D] Raw  [Esc] Stop`
    }
    return `${resumeHint}${sidebarHint}${bgHint}[\u2191\u2193] Navigate  [Ctrl+D] Raw  [Esc] Stop`
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      <text fg={themeCtx.theme.textMuted}>
        {shortcutText()}
      </text>
    </box>
  )
}
