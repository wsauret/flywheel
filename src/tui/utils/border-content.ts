import type { TextChunk } from "@opentui/core"
import { StyledText, fg as stFg } from "@opentui/core"
import type { TuiTheme } from "../context/theme/resolve.js"
import { chunksLength } from "./text-attributes.js"

const BORDER_HORIZONTAL = "─"

function borderChunks(theme: TuiTheme, text: string): TextChunk[] {
  return text ? [stFg(theme.border)(text)] : []
}

/** One rounded top-border line with an optional right-aligned label spliced
 *  into the rule. `width` is the full corner-inclusive line width. */
export function topBorderContent(theme: TuiTheme, width: number, label: readonly TextChunk[]): StyledText {
  const centerWidth = Math.max(0, width - 2)
  const labelWidth = chunksLength(label)
  const visibleLabel = labelWidth > 0 && labelWidth < centerWidth ? label : []
  const visibleLabelWidth = chunksLength(visibleLabel)
  const leadingRuleWidth = Math.max(0, centerWidth - visibleLabelWidth - (visibleLabelWidth > 0 ? 1 : 0))
  const trailingRuleWidth = Math.max(0, centerWidth - leadingRuleWidth - visibleLabelWidth)

  return new StyledText([
    ...borderChunks(theme, "╭"),
    ...borderChunks(theme, BORDER_HORIZONTAL.repeat(leadingRuleWidth)),
    ...visibleLabel,
    ...borderChunks(theme, BORDER_HORIZONTAL.repeat(trailingRuleWidth)),
    ...borderChunks(theme, "╮"),
  ])
}

function labeledRule(theme: TuiTheme, width: number, left: readonly TextChunk[], right: readonly TextChunk[], open: string, close: string): StyledText {
  const centerWidth = Math.max(0, width - open.length - close.length)
  const rightWidth = chunksLength(right)
  const rightStart = rightWidth > 0 && rightWidth < centerWidth ? Math.max(0, centerWidth - rightWidth - 1) : centerWidth
  const leftWidth = chunksLength(left)
  const leftStart = leftWidth > 0 ? 1 : 0
  const visibleLeft = leftStart + leftWidth <= rightStart ? left : []
  const visibleLeftWidth = chunksLength(visibleLeft)
  let cursor = 0
  const chunks: TextChunk[] = [...borderChunks(theme, open)]

  chunks.push(...borderChunks(theme, BORDER_HORIZONTAL.repeat(leftStart - cursor)))
  cursor = leftStart
  chunks.push(...visibleLeft)
  cursor += visibleLeftWidth
  chunks.push(...borderChunks(theme, BORDER_HORIZONTAL.repeat(Math.max(0, rightStart - cursor))))
  cursor = Math.max(cursor, rightStart)
  if (rightWidth > 0 && rightWidth < centerWidth) {
    chunks.push(...right)
    cursor += rightWidth
  }
  chunks.push(...borderChunks(theme, BORDER_HORIZONTAL.repeat(Math.max(0, centerWidth - cursor))))
  chunks.push(...borderChunks(theme, close))

  return new StyledText(chunks)
}

/** One rounded bottom-border line with optional left- and right-aligned labels
 *  spliced into the rule. `width` is the full corner-inclusive line width. */
export function bottomBorderContent(theme: TuiTheme, width: number, left: readonly TextChunk[], right: readonly TextChunk[]): StyledText {
  return labeledRule(theme, width, left, right, "╰", "╯")
}

/** One divider line for inside the frame: the side borders continue through
 *  the row and the rule is inset one cell from each. */
export function dividerContent(theme: TuiTheme, width: number): StyledText {
  return labeledRule(theme, width, [], [], "│ ", " │")
}
