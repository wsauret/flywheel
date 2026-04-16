/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/shared/context/theme"

interface ExpandToggleProps {
  expanded: boolean
  label?: string
}

export function ExpandToggle(props: ExpandToggleProps) {
  const { theme } = useTheme()
  const text = () => {
    if (props.expanded) return "\u25BE"
    return props.label ? `\u25B8 ${props.label}` : "\u25B8"
  }
  return <text fg={theme.textMuted} flexShrink={0}>{text()}</text>
}
