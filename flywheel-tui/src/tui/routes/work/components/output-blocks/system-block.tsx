/** @jsxImportSource @opentui/solid */
/**
 * SystemBlock Component
 *
 * Renders a system message (e.g., "Phase started", "Workflow complete").
 */

import { useTheme } from "@tui/shared/context/theme"
import type { SystemBlock as SystemBlockType } from "../../state/types"

export interface SystemBlockProps {
  block: SystemBlockType
}

export function SystemBlock(props: SystemBlockProps) {
  const themeCtx = useTheme()

  return (
    <text fg={themeCtx.theme.textMuted}>{props.block.message}</text>
  )
}
