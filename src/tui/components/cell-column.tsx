/** @jsxImportSource @opentui/solid */

import { StyledText, fg as stFg, type MouseEvent, type RGBA, type TextRenderable } from "@opentui/core"
import { createEffect, createMemo, type Accessor } from "solid-js"
import { useSpinnerFrame } from "../hooks/use-spinner-frame.js"

const BAR = "─"

// Col-0 gutter glyph for a tab cell: an animated spinner (busy) or a static
// marker (blocked, or a tab that a drag moves).
export type Gutter = { kind: "spinner" } | { kind: "glyph"; char: string }

export interface CellColumnState {
  width: number
  text: string
  textFg: RGBA
  textFgHover?: RGBA
  textAttributes?: number
  textAttributesHover?: number
  textCentered: boolean
  paddingLeft?: number
  paddingRight?: number
  barColor: RGBA
  leftBreak: boolean
  rightBreak: boolean
  // Col-0 gutter for tab cells; undefined for non-tab cells (brand, gaps, arrows).
  gutter?: Gutter
  onClick?: () => void
  onMouseDown?: (event: MouseEvent) => void
}

export interface CellColumnProps {
  cell: Accessor<CellColumnState>
  hovered: Accessor<boolean>
  onHover: (hovered: boolean) => void
}


// A 3-row column: blank top, text row, bar row. The whole column is one click
// target so any cell of the column activates the cell. The bar row paints
// `width` chars of `━` with optional 1-col blanks at the ends; those blanks
// are the half-cell gaps around the active highlight.
export function CellColumn(props: CellColumnProps) {
  const effectiveTextFg = () => (props.hovered() && props.cell().textFgHover) || props.cell().textFg
  const effectiveTextAttributes = () => (props.hovered() && props.cell().textAttributesHover !== undefined)
    ? props.cell().textAttributesHover
    : props.cell().textAttributes
  const spinner = useSpinnerFrame(() => props.cell().gutter?.kind === "spinner")
  const textWidth = () => Math.max(0, props.cell().width - (props.cell().paddingLeft ?? 0) - (props.cell().paddingRight ?? 0))
  const displayText = () => {
    const cell = props.cell()
    const inner = textWidth()
    const pad = Math.max(0, inner - cell.text.length)
    const leftPad = pad >> 1
    const glyph = cell.gutter?.kind === "spinner" ? spinner() : cell.gutter?.char
    const left = glyph ? " ".repeat(Math.max(0, leftPad - 2)) + glyph + " " : " ".repeat(leftPad)
    return left + cell.text + " ".repeat(pad - leftPad)
  }
  const textContent = createMemo(() => new StyledText([stFg(effectiveTextFg())(displayText())]))
  const barText = () => {
    const cell = props.cell()
    const w = cell.width
    if (w <= 0) return ""
    const left = cell.leftBreak ? " " : BAR
    const right = cell.rightBreak ? " " : BAR
    if (w === 1) return cell.leftBreak || cell.rightBreak ? " " : BAR
    if (w === 2) return left + right
    return left + BAR.repeat(w - 2) + right
  }
  return (
    <box
      flexDirection="column"
      width={props.cell().width}
      selectable={false}
      onMouseDown={(event: MouseEvent) => { const cell = props.cell(); cell.onMouseDown?.(event); cell.onClick?.() }}
      onMouseOver={() => props.onHover(true)}
      onMouseOut={() => props.onHover(false)}
    >
      <box height={1} />
      <box
        flexDirection="row"
        height={1}
        alignItems="center"
        justifyContent={props.cell().textCentered ? "center" : "flex-start"}
        paddingLeft={props.cell().paddingLeft}
        paddingRight={props.cell().paddingRight}
      >
        <text
          ref={(el: TextRenderable) => {
            createEffect(() => { el.content = textContent() })
          }}
          selectable={false}
          attributes={effectiveTextAttributes()}
          width={textWidth()}
          height={1}
          overflow="hidden"
          wrapMode="none"
        />
      </box>
      <text
        selectable={false}
        fg={props.cell().barColor}
        overflow="hidden"
        wrapMode="none"
      >{barText()}</text>
    </box>
  )
}
