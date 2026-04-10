/** @jsxImportSource @opentui/solid */
/**
 * SystemBlock Component
 *
 * Renders a system message (e.g., "Step started", "Workflow complete").
 */

import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "@tui/types"

export interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const isStepBoundary = props.block.message.startsWith("[step-boundary]")
  const message = isStepBoundary
    ? props.block.message.replace("[step-boundary]", "").trim()
    : props.block.message

  if (isStepBoundary) {
    const separatorWidth = Math.max(20, dimensions().width - 6)
    const separator = "─".repeat(separatorWidth)
    return (
      <box marginTop={2} flexDirection="column">
        <text fg={themeCtx.theme.borderSubtle}>{separator}</text>
        <box paddingTop={1}>
          <text fg={themeCtx.theme.accent} attributes={1}>{message}</text>
        </box>
      </box>
    )
  }

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{message}</text>
    </box>
  )
}
