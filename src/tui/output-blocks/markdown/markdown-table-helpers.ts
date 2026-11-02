import type { BorderCharacters, TextChunk } from "@opentui/core"
import type { Token, Tokens } from "marked"
import stringWidth from "string-width"
import { BOLD } from "@tui/utils/text-attributes.js"
import { renderMarkdownToken, plainOf } from "./format-token.js"
import type { MarkdownStyles } from "./markdown-styles.js"
import type {
  ColumnSpec,
  TableCell,
  TableCellAlign,
  TableColumnAlign,
  TableModel,
} from "./markdown-table-types.js"

export const MIN_COLUMN_WIDTH = 3
export const CARDVIEW_LINE_THRESHOLD = 4
export const COLUMN_MIN_CONTENT_CAP = 12
export type TableRuleKind = "top" | "middle" | "bottom"
export type TableRulePosition = number | "rightEdge"

const TABLE_BORDER_CHARS: BorderCharacters = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼",
}

export const vbar: BorderCharacters = {
  ...TABLE_BORDER_CHARS,
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

export function ruleChars(kind: TableRuleKind, position: TableRulePosition): BorderCharacters {
  return {
    ...TABLE_BORDER_CHARS,
    topLeft: ruleCorner(kind, position),
  }
}

function ruleCorner(kind: TableRuleKind, position: TableRulePosition): string {
  if (kind === "top") {
    if (position === "rightEdge") return "┐"
    return position === 0 ? "┌" : "┬"
  }
  if (kind === "middle") {
    if (position === "rightEdge") return "┤"
    return position === 0 ? "├" : "┼"
  }
  if (position === "rightEdge") return "┘"
  return position === 0 ? "└" : "┴"
}

export function buildTableModel(token: Tokens.Table, styles: MarkdownStyles): TableModel {
  const columnCount = token.header.length
  const header = Array.from({ length: columnCount }, (_, col) =>
    buildCell(token.header[col], styles, BOLD, "center"),
  )
  const rows = token.rows.map((row) =>
    Array.from({ length: columnCount }, (_, col) =>
      buildCell(row[col], styles, 0, bodyAlign(columnAlign(token, col))),
    ),
  )
  // SAFETY: every row is built above via Array.from({ length: columnCount }),
  // so each row has exactly columnCount cells; col ranges over header's
  // columnCount entries, keeping row[col] in bounds.
  const columns = header.map((headerCell, col) => columnSpec(token, col, [headerCell, ...rows.map((row) => row[col]!)]))

  return {
    columnCount,
    columns,
    header,
    rows,
    cardLabels: header.map((cell, col) => cell.plain.trim().length > 0 ? cell.plain : `Column ${col + 1}`),
  }
}

export function shouldUseCardView(model: TableModel, measuredContentWidth: number): boolean {
  const widths = projectedColumnWidths(model, measuredContentWidth)
  if (widths.length === 0) return false

  for (const row of [model.header, ...model.rows]) {
    const rowHeight = row.reduce((max, cell, col) => {
      const width = widths[col] ?? MIN_COLUMN_WIDTH
      return Math.max(max, projectedLineCount(cell.plain, width))
    }, 1)
    if (rowHeight > CARDVIEW_LINE_THRESHOLD) return true
  }
  return false
}

function buildCell(
  cell: Tokens.TableCell | undefined,
  styles: MarkdownStyles,
  attributes: number,
  align: TableCellAlign,
): TableCell {
  const chunks = renderCell(cell?.tokens, styles, attributes)
  return { chunks, plain: plainOf(chunks), align }
}

function renderCell(tokens: Token[] | undefined, styles: MarkdownStyles, attributes: number): TextChunk[] {
  const chunks = tokens?.flatMap((token) => renderMarkdownToken(token, styles)) ?? []
  if (attributes === 0) return chunks
  return chunks.map((c) => ({ ...c, attributes: (c.attributes ?? 0) | attributes }))
}

function columnSpec(token: Tokens.Table, col: number, cells: TableCell[]): ColumnSpec {
  let minContentWidth = MIN_COLUMN_WIDTH
  let maxContentWidth = MIN_COLUMN_WIDTH
  for (const cell of cells) {
    minContentWidth = Math.max(minContentWidth, longestWordWidth(cell.plain))
    maxContentWidth = Math.max(maxContentWidth, stringWidth(cell.plain))
  }

  const protectedContent = Math.min(maxContentWidth, COLUMN_MIN_CONTENT_CAP)

  return {
    minContentWidth,
    maxContentWidth,
    align: columnAlign(token, col),
    flex: {
      flexBasis: maxContentWidth,
      flexGrow: 0,
      flexShrink: 1,
      // Content cells have a 1-column left border, so the Yoga outer floor is
      // protected content plus that border while huge columns can still shrink.
      minWidth: protectedContent + 1,
    },
  }
}

function columnAlign(token: Tokens.Table, col: number): TableColumnAlign {
  return token.align[col] ?? null
}

function bodyAlign(align: TableColumnAlign): TableCellAlign {
  return align ?? "left"
}

function longestWordWidth(text: string): number {
  let max = 0
  for (const word of text.split(/\s+/)) {
    if (word.length > 0) max = Math.max(max, stringWidth(word))
  }
  return max
}

function projectedColumnWidths(model: TableModel, measuredContentWidth: number): number[] {
  const count = model.columnCount
  if (count === 0) return []

  const targets = model.columns.map((column) => Math.max(column.maxContentWidth, MIN_COLUMN_WIDTH))
  const targetTotal = targets.reduce((sum, width) => sum + width, 0)
  if (targetTotal <= measuredContentWidth) return targets

  const floorTotal = count * MIN_COLUMN_WIDTH
  const available = Math.max(Math.floor(measuredContentWidth), floorTotal)
  const slack = available - floorTotal
  const headrooms = targets.map((target) => target - MIN_COLUMN_WIDTH)
  const totalHeadroom = headrooms.reduce((sum, headroom) => sum + headroom, 0)
  if (totalHeadroom === 0) return targets.map(() => MIN_COLUMN_WIDTH)

  return headrooms.map((headroom) => MIN_COLUMN_WIDTH + Math.floor((headroom / totalHeadroom) * slack))
}

// Pure card-mode estimate: each cell wraps to ceil(displayWidth / columnWidth),
// summed per explicit newline. This intentionally avoids terminal/chrome math;
// Phase 2 supplies the actual measured content width from Yoga.
function projectedLineCount(text: string, columnWidth: number): number {
  const width = Math.max(1, Math.floor(columnWidth))
  return text.split("\n").reduce((sum, line) => {
    const lineWidth = stringWidth(line)
    return sum + Math.max(1, Math.ceil(lineWidth / width))
  }, 0)
}
