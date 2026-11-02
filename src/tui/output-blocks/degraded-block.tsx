/** @jsxImportSource @opentui/solid */

import type { DegradedBlock as DegradedBlockType } from "@infra/output-blocks"
import type { TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { BlockFrame } from "./block-frame.js"

interface DegradedBlockProps {
  readonly block: DegradedBlockType
}

export function DegradedBlock(props: DegradedBlockProps) {
  const { theme } = useTheme()
  return (
    <BlockFrame>
      <text fg={theme.textMuted} ref={(element: TextRenderable) => { element.content = props.block.notice }} />
    </BlockFrame>
  )
}
