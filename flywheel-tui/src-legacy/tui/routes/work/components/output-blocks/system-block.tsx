/** @jsxImportSource @opentui/solid */
/**
 * SystemBlock Component
 *
 * Renders a system message (e.g., "Step started", "Workflow complete").
 */

import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@tui/types"

export interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")
  const message = isStepBoundary
    ? props.block.message.replace("[step-boundary]", "").trim()
    : props.block.message

  if (isStepBoundary) {
    return (
      <box marginTop={1} flexDirection="column">
        <text fg={themeCtx.theme.border}>────────────────────────────────────────────────────────────────</text>
        <text fg={themeCtx.theme.primary} attributes={1}>{message}</text>
        <text fg={themeCtx.theme.border}>────────────────────────────────────────────────────────────────</text>
      </box>
    )
  }

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{message}</text>
    </box>
  )
}
