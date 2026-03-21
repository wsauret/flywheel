/** @jsxImportSource @opentui/solid */
/**
 * ToolBlock Component
 *
 * Renders a standalone tool invocation: `▸ ToolName: detail`
 */

import { useTheme } from "@tui/shared/context/theme"
import { truncate, MAX_BLOCK_LINE_LENGTH } from "@tui/utils/text"
import type { ToolBlock as ToolBlockType } from "../../state/types"

export interface ToolBlockProps {
  block: ToolBlockType
}

export function ToolBlock(props: ToolBlockProps) {
  const themeCtx = useTheme()

  // "▸ " (2) + name + ": " (2) = 4 + name.length overhead
  const detailWidth = () => MAX_BLOCK_LINE_LENGTH - props.block.name.length - 4

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{`▸ ${props.block.name}: ${truncate(props.block.detail, detailWidth())}`}</text>
    </box>
  )
}
