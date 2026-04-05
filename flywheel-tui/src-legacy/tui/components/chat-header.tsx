/** @jsxImportSource @opentui/solid */
/**
 * Chat Header — Top bar for chatting state
 *
 * Lightweight header that shows the FLYWHEEL branding with a 'Chat' indicator.
 * Separate from SessionHeader which is tightly coupled to workflow session state
 * (SessionLifecycleState, SessionSummary). ChatHeader is simpler: branding + mode.
 *
 * Layout matches BrandingHeader (same SIMPLE_LOGO + separator) so the rest
 * of the layout doesn't shift when switching between idle and chatting states.
 */

import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { SIMPLE_LOGO } from "@tui/shared/components/logo"

export function ChatHeader(props: { version: string }) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()

  const lineWidth = () => (dimensions()?.width ?? 80) - 2

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      {/* Line 1: Logo + version */}
      <text fg={themeCtx.theme.primary}>
        {` ${SIMPLE_LOGO[0]}  `}
        <span style={{ fg: themeCtx.theme.textMuted }}>v{props.version}</span>
      </text>

      {/* Line 2: Logo + Chat mode indicator */}
      <box flexDirection="row">
        <text fg={themeCtx.theme.primary}>
          {` ${SIMPLE_LOGO[1]}  `}
          <span style={{ fg: themeCtx.theme.info }}>Chat</span>
        </text>
        <box flexGrow={1} />
      </box>

      {/* Separator */}
      <text fg={themeCtx.theme.info}>
        {"\u2500".repeat(lineWidth())}
      </text>
    </box>
  )
}
