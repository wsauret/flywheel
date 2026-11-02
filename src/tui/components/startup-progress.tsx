/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { progressBar } from "./progress-bar.js"

export interface StartupProgressProps {
  readonly step: number
  readonly total: number
  readonly width: number
}

export function StartupProgress(props: StartupProgressProps) {
  const { theme } = useTheme()
  const fraction = () => props.total > 0 ? props.step / props.total : 0
  return <box flexDirection="row" gap={1}>
    <text fg={theme.primary}>{progressBar(fraction(), props.width)}</text>
    <text fg={theme.textMuted}>{`${props.step}/${props.total}`}</text>
  </box>
}
