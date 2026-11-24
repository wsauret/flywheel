import type { TextChunk } from "@opentui/core"

export type TableColumnAlign = "left" | "center" | "right" | null
export type TableCellAlign = "left" | "center" | "right"

interface ColumnFlexSpec {
  flexBasis: number
  flexGrow: number
  flexShrink: number
  minWidth: number
}

export interface ColumnSpec {
  minContentWidth: number
  maxContentWidth: number
  align: TableColumnAlign
  flex: ColumnFlexSpec
}

export interface TableCell {
  chunks: TextChunk[]
  plain: string
  align: TableCellAlign
}

export interface TableModel {
  columnCount: number
  columns: ColumnSpec[]
  header: TableCell[]
  rows: TableCell[][]
  cardLabels: string[]
}
