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
}

/**
 * Show keyboard shortcuts at bottom of screen.
 * Content adapts based on current interaction mode.
 */
export function StatusFooter(props: StatusFooterProps) {
  const themeCtx = useTheme()

  const shortcutText = () => {
    if (props.sidebarFocused) {
      return "[\u2191\u2193] Navigate  [Enter] Select  [Del] Delete  [Esc/Tab] Exit Sidebar  [Ctrl+T] Theme"
    }
    if (props.isPromptFocused) {
      return "[Esc] Exit Prompt  [Enter] Continue/Send  [Ctrl+S] Skip  [Ctrl+D] Raw  [Ctrl+T] Theme"
    }
    const sidebarHint = props.sidebarVisible ? "[Tab] Sidebar  " : ""
    if (props.approvalPending) {
      return `[Right] Focus Prompt  ${sidebarHint}[\u2191\u2193] Navigate  [Ctrl+S] Skip  [Ctrl+D] Raw  [Ctrl+T] Theme  [Esc] Stop`
    }
    return `${sidebarHint}[\u2191\u2193] Navigate  [Ctrl+S] Skip  [Ctrl+D] Raw  [Ctrl+T] Theme  [Esc] Stop`
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      <text fg={themeCtx.theme.textMuted}>
        {shortcutText()}
      </text>
    </box>
  )
}
