/** @jsxImportSource @opentui/solid */
/**
 * Session Header — Top bar replacing BrandingHeader when a session is active
 *
 * Shows contextual session information:
 *   - Session name
 *   - Repo / working directory
 *   - Current branch (if available)
 *   - Current step name and status
 *   - Last activity timestamp
 *
 * Falls back to BrandingHeader-like layout with the same visual weight
 * (logo lines + separator) so the rest of the layout doesn't shift.
 */

import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { SIMPLE_LOGO } from "@tui/shared/components/logo"
import { formatSessionStatus, type SessionHeaderInfo } from "./session-header-logic"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionHeaderProps {
  info: SessionHeaderInfo
  version: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionHeader(props: SessionHeaderProps) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()

  const lineWidth = () => (dimensions()?.width ?? 80) - 2

  const statusText = () => formatSessionStatus(props.info)

  // Prefix for line 2: " " + SIMPLE_LOGO[1] + "  "
  const PREFIX_LEN = 1 + SIMPLE_LOGO[1].length + 2

  const truncatedName = () => {
    const maxLen = lineWidth() - PREFIX_LEN - statusText().length - 4
    if (maxLen <= 0) return ""
    const name = props.info.sessionName || props.info.planName || ""
    if (name.length <= maxLen) return name
    return "..." + name.slice(-(maxLen - 3))
  }

  const statusColor = () => {
    switch (props.info.workflowStatus) {
      case "running":     return themeCtx.theme.info
      case "completed":   return themeCtx.theme.success
      case "failed":      return themeCtx.theme.error
      case "interrupted": return themeCtx.theme.warning
      default:            return themeCtx.theme.textMuted
    }
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      {/* Line 1: Logo + version */}
      <text fg={themeCtx.theme.primary}>
        {` ${SIMPLE_LOGO[0]}  `}
        <span style={{ fg: themeCtx.theme.textMuted }}>v{props.version}</span>
      </text>

      {/* Line 2: Logo + session name + status */}
      <box flexDirection="row">
        <text fg={themeCtx.theme.primary}>
          {` ${SIMPLE_LOGO[1]}  `}
          <span style={{ fg: themeCtx.theme.text }}>{truncatedName()}</span>
        </text>
        <box flexGrow={1} />
        <Show when={statusText()}>
          <text fg={statusColor()}>
            {statusText()}
          </text>
        </Show>
      </box>

      {/* Separator */}
      <text fg={themeCtx.theme.info}>
        {"\u2500".repeat(lineWidth())}
      </text>
    </box>
  )
}
