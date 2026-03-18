/** @jsxImportSource @opentui/solid */
/**
 * TextBlock Component
 *
 * Renders a text output block. Reuses LogLine for markdown/color rendering.
 */

import { LogLine } from "../log-line"
import type { TextBlock as TextBlockType } from "../../state/types"

export interface TextBlockProps {
  block: TextBlockType
}

export function TextBlock(props: TextBlockProps) {
  return <LogLine line={props.block.content} />
}
