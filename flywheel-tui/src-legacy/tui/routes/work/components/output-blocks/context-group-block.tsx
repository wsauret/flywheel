/** @jsxImportSource @opentui/solid */
/**
 * ContextGroupBlock Component
 *
 * Renders a collapsed context group: `◆ Gathered context (N files)`
 * Auto-collapsed by default — shows summary only, not individual tools.
 */

import { useTheme } from "@tui/shared/context/theme"
import type { ContextGroupBlock as ContextGroupBlockType } from "@tui/types"

export interface ContextGroupBlockProps {
  block: ContextGroupBlockType
}

export function ContextGroupBlock(props: ContextGroupBlockProps) {
  const themeCtx = useTheme()

  const fileCount = () => props.block.tools.length

  return (
    <box marginTop={1}>
      <text fg={themeCtx.theme.textMuted}>{`◆ Gathered context (${fileCount()} files)`}</text>
    </box>
  )
}
