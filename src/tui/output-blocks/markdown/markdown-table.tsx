/** @jsxImportSource @opentui/solid */

import type { TextChunk, TextRenderable } from "@opentui/core"
import { StyledText } from "@opentui/core"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { BOLD } from "@tui/utils/text-attributes.js"
import type { Tokens } from "marked"
import { createEffect, createMemo, Index, Show, type JSX } from "solid-js"
import { markdownTextChunk } from "./format-token.js"
import {
  buildTableModel,
  ruleChars,
  shouldUseCardView,
  type TableRuleKind,
  vbar,
} from "./markdown-table-helpers.js"
import type { MarkdownStyles } from "./markdown-styles.js"
import type { ColumnSpec, TableCell, TableCellAlign, TableModel } from "./markdown-table-types.js"

const CELL_WRAP_MODE = "word" as const
type TableBorderColor = NonNullable<TextChunk["fg"]>

interface MarkdownTableProps {
  token: Tokens.Table
  styles: MarkdownStyles
  textColor: TableBorderColor
  borderColor: TableBorderColor
}

// Table-only exception to one selectable <text> region per logical row: a real
// OpenTUI flex-grid table necessarily uses one region per cell. That is
// intentional for tables because the user requested a real flex grid; do not use
// multi-text flex rows for other single-line markdown content.
export function MarkdownTable(props: MarkdownTableProps): JSX.Element {
  const model = createMemo(() => buildTableModel(props.token, props.styles))
  const measuredWidth = createMeasuredWidth()
  const useCard = createMemo(() => shouldUseCardView(model(), measuredWidth.width()))

  return (
    <box
      ref={measuredWidth.ref}
      flexDirection="column"
      width="100%"
    >
      {/* Wait for local measurement to avoid a grid-to-card flicker. */}
      <Show when={measuredWidth.width() > 0}>
        <Show when={useCard()} fallback={<TableGrid model={model()} borderColor={props.borderColor} textColor={props.textColor} />}>
          <TableCards model={model()} borderColor={props.borderColor} textColor={props.textColor} />
        </Show>
      </Show>
    </box>
  )
}

function TableGrid(props: { model: TableModel; borderColor: TableBorderColor; textColor: TableBorderColor }): JSX.Element {
  return (
    <box flexDirection="column" width="100%">
      <TableRuleRow kind="top" model={props.model} borderColor={props.borderColor} />
      <TableContentRow cells={props.model.header} model={props.model} borderColor={props.borderColor} textColor={props.textColor} />
      <TableRuleRow kind="middle" model={props.model} borderColor={props.borderColor} />
      <Show when={props.model.rows.length > 0} fallback={<TableRuleRow kind="bottom" model={props.model} borderColor={props.borderColor} />}>
        <Index each={props.model.rows}>
          {(row, rowIndex) => (
            <>
              <TableContentRow cells={row()} model={props.model} borderColor={props.borderColor} textColor={props.textColor} />
              <TableRuleRow
                kind={rowIndex === props.model.rows.length - 1 ? "bottom" : "middle"}
                model={props.model}
                borderColor={props.borderColor}
              />
            </>
          )}
        </Index>
      </Show>
    </box>
  )
}

function TableContentRow(props: { cells: TableCell[]; model: TableModel; borderColor: TableBorderColor; textColor: TableBorderColor }): JSX.Element {
  return (
    <box flexDirection="row" alignItems="stretch" width="100%">
      <Index each={props.model.columns}>
        {(column, col) => {
          // SAFETY: buildTableModel sizes columns and every row (header/body) to
          // the same columnCount, so col indexes a present cell.
          return <TableContentCell column={column()} cell={props.cells[col]!} borderColor={props.borderColor} textColor={props.textColor} />
        }}
      </Index>
      <box border={["left"]} customBorderChars={vbar} borderColor={props.borderColor} width={1} flexShrink={0} />
    </box>
  )
}

function TableContentCell(props: { column: ColumnSpec; cell: TableCell; borderColor: TableBorderColor; textColor: TableBorderColor }): JSX.Element {
  return (
    <box
      border={["left"]}
      customBorderChars={vbar}
      borderColor={props.borderColor}
      flexBasis={props.column.flex.flexBasis}
      flexGrow={props.column.flex.flexGrow}
      flexShrink={props.column.flex.flexShrink}
      minWidth={props.column.flex.minWidth}
      flexDirection="row"
      justifyContent={justifyFor(props.cell.align)}
    >
      <StyledChunks chunks={props.cell.chunks} textColor={props.textColor} />
    </box>
  )
}

function TableRuleRow(props: { kind: TableRuleKind; model: TableModel; borderColor: TableBorderColor }): JSX.Element {
  return (
    <box flexDirection="row" width="100%" height={1}>
      <Index each={props.model.columns}>
        {(column, col) => (
          <TableRuleCell kind={props.kind} position={col} column={column()} borderColor={props.borderColor} />
        )}
      </Index>
      <box
        border={["top", "left"]}
        customBorderChars={ruleChars(props.kind, "rightEdge")}
        borderColor={props.borderColor}
        width={1}
        flexShrink={0}
        height={1}
      />
    </box>
  )
}

function TableRuleCell(props: {
  kind: TableRuleKind
  position: number
  column: ColumnSpec
  borderColor: TableBorderColor
}): JSX.Element {
  return (
    <box
      border={["top", "left"]}
      customBorderChars={ruleChars(props.kind, props.position)}
      borderColor={props.borderColor}
      flexBasis={props.column.flex.flexBasis}
      flexGrow={props.column.flex.flexGrow}
      flexShrink={props.column.flex.flexShrink}
      minWidth={props.column.flex.minWidth}
      height={1}
    />
  )
}

function TableCards(props: { model: TableModel; borderColor: TableBorderColor; textColor: TableBorderColor }): JSX.Element {
  return (
    <box flexDirection="column" width="100%">
      <Index each={props.model.rows}>
        {(row, rowIndex) => (
          <>
            <Show when={rowIndex > 0}>
              <box
                border={["top"]}
                customBorderChars={vbar}
                borderColor={props.borderColor}
                height={1}
                width="100%"
              />
            </Show>
            <box flexDirection="column" width="100%">
              <Index each={props.model.columns}>
                {(_column, col) => {
                  // SAFETY: buildTableModel sizes columns, cardLabels, and every
                  // row to the same columnCount, so col indexes present
                  // entries in both cardLabels and row.
                  return (
                    <CardLine
                      label={props.model.cardLabels[col]!}
                      value={row()[col]!.chunks}
                      textColor={props.textColor}
                    />
                  )
                }}
              </Index>
            </box>
          </>
        )}
      </Index>
    </box>
  )
}

function CardLine(props: { label: string; value: TextChunk[]; textColor: TableBorderColor }): JSX.Element {
  const styled = createMemo(() => new StyledText([
    markdownTextChunk(`${props.label}:`, undefined, BOLD),
    markdownTextChunk(" "),
    ...props.value,
  ]))

  return (
    <text
      fg={props.textColor}
      wrapMode={CELL_WRAP_MODE}
      maxWidth="100%"
      flexShrink={1}
      ref={(el: TextRenderable) => {
        createEffect(() => { el.content = styled() })
      }}
    />
  )
}

function StyledChunks(props: { chunks: TextChunk[]; textColor: TableBorderColor }): JSX.Element {
  const styled = createMemo(() => new StyledText(props.chunks))

  return (
    <text
      fg={props.textColor}
      // Headless probe confirmed OpenTUI word mode still hard-breaks long
      // unspaced tokens, so tables keep normal word wrapping where possible.
      wrapMode={CELL_WRAP_MODE}
      maxWidth="100%"
      flexShrink={1}
      ref={(el: TextRenderable) => {
        createEffect(() => { el.content = styled() })
      }}
    />
  )
}

function justifyFor(align: TableCellAlign): "flex-start" | "center" | "flex-end" {
  if (align === "center") return "center"
  if (align === "right") return "flex-end"
  return "flex-start"
}
