/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { SIMPLE_LOGO } from "../logo"

export function BrandingHeader(props: { version: string; currentDir: string }) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()

  const lineWidth = () => (dimensions()?.width ?? 80) - 2

  // Prefix for line 2: " " + SIMPLE_LOGO[1] + "  "
  const PREFIX_LEN = 1 + SIMPLE_LOGO[1].length + 2

  const truncatedDir = () => {
    const maxLen = lineWidth() - PREFIX_LEN
    if (maxLen <= 0) return ""
    const dir = props.currentDir
    if (dir.length <= maxLen) return dir
    return "..." + dir.slice(-(maxLen - 3))
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text fg={themeCtx.theme.primary}>
        {` ${SIMPLE_LOGO[0]}  `}
        <span style={{ fg: themeCtx.theme.textMuted }}>v{props.version}</span>
      </text>
      <text fg={themeCtx.theme.primary}>
        {` ${SIMPLE_LOGO[1]}  `}
        <span style={{ fg: themeCtx.theme.textMuted }}>{truncatedDir()}</span>
      </text>
      <text fg={themeCtx.theme.info}>{"─".repeat(lineWidth())}</text>
    </box>
  )
}
