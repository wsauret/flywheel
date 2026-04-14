/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@infra/output-blocks"

export interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  // Step boundaries render as a rule rather than text — progress is in the shell header.
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")

  if (isStepBoundary) {
    return (
      <box marginTop={1}>
        <text fg={themeCtx.theme.borderSubtle}>{"───"}</text>
      </box>
    )
  }

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{props.block.message}</text>
    </box>
  )
}
