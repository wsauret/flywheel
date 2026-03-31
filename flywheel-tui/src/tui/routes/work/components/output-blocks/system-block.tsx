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

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{props.block.message}</text>
    </box>
  )
}
