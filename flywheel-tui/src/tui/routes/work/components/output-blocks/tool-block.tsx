/** @jsxImportSource @opentui/solid */
/**
 * ToolBlock Component
 *
 * Renders a standalone tool invocation: `▸ ToolName: detail`
 */

import { useTheme } from "@tui/shared/context/theme"
import type { ToolBlock as ToolBlockType } from "../../state/types"

export interface ToolBlockProps {
  block: ToolBlockType
}

export function ToolBlock(props: ToolBlockProps) {
  const themeCtx = useTheme()

  return (
    <text fg={themeCtx.theme.text}>{`▸ ${props.block.name}: ${props.block.detail}`}</text>
  )
}
