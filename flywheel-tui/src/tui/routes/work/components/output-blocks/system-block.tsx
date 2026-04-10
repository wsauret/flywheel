/** @jsxImportSource @opentui/solid */
/**
 * SystemBlock Component
 *
 * Renders a system message (e.g., "Step started", "Workflow complete").
 * Step boundary blocks render as a subtle separator — step progress
 * is already shown in the shell header.
 */

import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@tui/types"

export interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
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
