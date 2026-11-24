import type { Renderable, Selection } from "@opentui/core"
import { displayWidth } from "./text.js"

type SelectedRenderable = Pick<Renderable, "x" | "y" | "width" | "isDestroyed" | "getSelectedText">

interface ScreenPoint { readonly x: number; readonly y: number }

interface SelectionSnapshot {
  readonly anchor: ScreenPoint
  readonly focus: ScreenPoint
  readonly selectedRenderables: readonly SelectedRenderable[]
}

interface SelectionConsumer {
  getSelection(): SelectionSnapshot | null
  clearSelection(): void
}

interface SelectionAnchorRenderable {
  selectable: boolean
  shouldStartSelection(x: number, y: number): boolean
}

export function preventSelectionStart(renderable: SelectionAnchorRenderable): void {
  renderable.shouldStartSelection = () => false
}

export function allowSelectionStart(renderable: SelectionAnchorRenderable): void {
  renderable.selectable = true
  renderable.shouldStartSelection = () => true
}

/** Dead-space decoration (gutter dot, spinner) that should let a drag START a
 * selection but never contribute glyphs or highlight to it: it wins the hit
 * grid over its parent box, so it must answer yes to shouldStartSelection,
 * while reporting no selected text of its own. */
export function allowSelectionStartWithoutContent(renderable: SelectionAnchorRenderable & { onSelectionChanged(selection: Selection | null): boolean; getSelectedText(): string }): void {
  renderable.selectable = true
  renderable.shouldStartSelection = () => true
  renderable.onSelectionChanged = () => false
  renderable.getSelectedText = () => ""
}

/** A blank row's one-space cell: the space lets a drag select and highlight
 *  the row, and copy keeps the row as an empty line, not as a space. */
export function copyAsEmptyRow(renderable: { getSelectedText(): string }): void {
  renderable.getSelectedText = () => ""
}

/**
 * The text a person copies: each selected renderable's selected text placed
 * on the screen rows it occupies, the rows in screen order and joined with
 * line breaks, and the pieces of one row in column order. This is OpenTUI's
 * own join with two differences. OpenTUI drops a selected renderable whose
 * selected text is empty, so a blank row inside a selection lost its line
 * break. Here every selected renderable keeps its rows, and one that selected
 * nothing keeps one empty row. OpenTUI also joins the pieces of one row with
 * nothing between them, so table cells ran together. Here each piece after the
 * first keeps its screen gap as spaces, and the row has no leading indent.
 * Decoration is not text: a border between two pieces adds its width to the
 * gap, and decoration before the first piece adds nothing.
 */
function selectedText(selection: SelectionSnapshot): string {
  const start = readingOrderStart(selection.anchor, selection.focus)
  const rows = new Map<number, { x: number; text: string }[]>()
  for (const renderable of selection.selectedRenderables) {
    if (renderable.isDestroyed) continue
    const first = firstSelectedCell(renderable, start)
    for (const [index, text] of renderable.getSelectedText().split("\n").entries()) {
      const y = first.y + index
      let row = rows.get(y)
      if (row === undefined) rows.set(y, row = [])
      row.push({ x: index === 0 ? first.x : renderable.x, text })
    }
  }
  return [...rows.entries()]
    .sort(([top], [bottom]) => top - bottom)
    .map(([, row]) => joinRow(row.sort((left, right) => left.x - right.x)))
    .join("\n")
}

function readingOrderStart(anchor: ScreenPoint, focus: ScreenPoint): ScreenPoint {
  return anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x) ? anchor : focus
}

/** The screen cell where a renderable's selected text begins. A selection that
 *  starts above the renderable selects it from its first cell. One that starts
 *  on its rows begins at the start point, or on the next row when the start
 *  point lies right of the renderable. */
function firstSelectedCell(renderable: SelectedRenderable, start: ScreenPoint): ScreenPoint {
  if (start.y < renderable.y) return { x: renderable.x, y: renderable.y }
  if (start.x >= renderable.x + renderable.width) return { x: renderable.x, y: start.y + 1 }
  return { x: Math.max(renderable.x, start.x), y: start.y }
}

function joinRow(pieces: readonly { x: number; text: string }[]): string {
  let line = ""
  let end: number | undefined
  for (const piece of pieces) {
    if (piece.text === "") continue
    if (end !== undefined) line += " ".repeat(Math.max(0, piece.x - end))
    line += piece.text
    end = piece.x + displayWidth(piece.text)
  }
  return line
}

/** Whether a drag selected at least one cell. A mouse-up that ends a
 *  selection must not also act as a click. This test does not read the
 *  selected text, because a blank row copies as empty text but is still a
 *  selection. */
export function hasSelectedCells(selection: { readonly selectedRenderables: readonly unknown[] } | null): boolean {
  return (selection?.selectedRenderables.length ?? 0) > 0
}

/** Consumes selected cells, including blank rows, but preserves an empty
 *  click so OpenTUI can recognize the next click as a word selection. */
export function consumeSelectedText(renderer: SelectionConsumer): string | null {
  const selection = renderer.getSelection()
  if (selection === null || !hasSelectedCells(selection)) return null
  const text = selectedText(selection)
  renderer.clearSelection()
  return text.length > 0 ? text : null
}
