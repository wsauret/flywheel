import { displayWidth, graphemes, graphemeBoundaryAtOrBefore } from "./utils/text.js"
import type { TextEntrySelection, TextEntryVisualLine } from "./keymap/text-entry.js"

interface LayoutBoundary {
  x: number
  offset: number
}

interface CaretRange {
  start: number
  end: number
}

/** A terminal cell inside the laid-out text: `row` counts lines, `column` counts display cells. */
interface CaretCell {
  row: number
  column: number
}

interface LayoutRow {
  text: string
  width: number
  boundaries: LayoutBoundary[]
  hasAnswer: boolean
  caretColumn?: number
  selections: CaretRange[]
}

interface LayoutToken {
  text: string
  width: number
  start: number
  end: number
  kind: "answer" | "newline"
  whitespace: boolean
}

export interface QuestionDockEditorLayout {
  text: string
  /** Where the terminal cursor sits: over the grapheme after the cursor, or on the blank cell after a line's text. */
  caret?: CaretCell
  selections: readonly CaretRange[]
  visualLines: readonly TextEntryVisualLine[]
  prefixRange(start: number, end: number): CaretRange
  cursorOffsetAt(x: number, y: number): number
}

/** Lays out an editable question row once for terminal rendering, styling, and mouse hit testing. */
export function layoutQuestionDockEditor(options: {
  prefix: string
  value: string
  cursor: number
  selection: TextEntrySelection | null
  width: number
  showCaret: boolean
}): QuestionDockEditorLayout {
  const width = Math.max(1, Math.floor(options.width))
  const cursor = graphemeBoundaryAtOrBefore(options.value, options.cursor)
  const prefixRows = wrapPrefix(options.prefix, width)
  const prefixWidth = displayWidth(prefixRows.at(-1) ?? "")
  const continuationPrefix = width - prefixWidth >= 12 ? " ".repeat(prefixWidth) : "  "
  const rows: LayoutRow[] = prefixRows.slice(0, -1).map((prefix) => createRow(prefix, 0))
  let row = createRow(prefixRows.at(-1) ?? "", 0)

  const finishRow = (nextOffset: number) => {
    rows.push(row)
    row = createRow(continuationPrefix, nextOffset)
  }

  const append = (token: LayoutToken) => {
    row.boundaries.push({ x: row.width, offset: token.start })
    const range = { start: row.text.length, end: row.text.length + token.text.length }
    row.text += token.text
    row.width += token.width
    row.boundaries.push({ x: row.width, offset: token.end })
    if (token.kind === "answer") {
      row.hasAnswer = true
      if (options.selection && token.start >= options.selection.start && token.end <= options.selection.end) row.selections.push(range)
    }
  }

  // Over a grapheme the caret takes no cell of its own. At a line end it
  // needs the blank cell after the text, so a full row moves it to the next.
  const caretOverNext = () => { row.caretColumn = row.width }
  const caretAtLineEnd = () => {
    if (row.width >= width) finishRow(cursor)
    row.caretColumn = row.width
  }

  const tokens = editorTokens(options.value)
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (!token) break
    if (token.kind === "newline") {
      row.boundaries.push({ x: row.width, offset: token.start })
      if (options.showCaret && token.start === cursor) caretAtLineEnd()
      finishRow(token.end)
      index += 1
      continue
    }
    if (token.whitespace) {
      const showCaret = options.showCaret && token.start === cursor
      if (row.width + token.width <= width) {
        if (showCaret) caretOverNext()
        append(token)
      } else {
        // A wrap drops the whitespace. A caret on it takes the blank cell
        // that ends the next row's prefix, so the caret never reflows the text.
        row.boundaries.push({ x: row.width, offset: token.end })
        finishRow(token.end)
        if (showCaret) row.caretColumn = row.width - 1
      }
      index += 1
      continue
    }

    let end = index + 1
    while (end < tokens.length && tokens[end]?.kind !== "newline" && !tokens[end]?.whitespace) end += 1
    const word = tokens.slice(index, end)
    const wordWidth = word.reduce((sum, part) => sum + part.width, 0)
    const continuationCapacity = Math.max(1, width - displayWidth(continuationPrefix))
    if ((row.hasAnswer || row.width >= width) && wordWidth > width - row.width && wordWidth <= continuationCapacity) {
      finishRow(word[0]?.start ?? cursor)
    }
    for (const part of word) {
      if ((row.hasAnswer || row.width >= width) && row.width + part.width > width) finishRow(part.start)
      if (options.showCaret && part.start === cursor) caretOverNext()
      append(part)
    }
    index = end
  }

  if (options.showCaret && cursor === options.value.length) caretAtLineEnd()
  rows.push(row)

  let textOffset = 0
  let caret: CaretCell | undefined
  const selections: CaretRange[] = []
  for (const [index, line] of rows.entries()) {
    if (line.caretColumn !== undefined) caret = { row: index, column: line.caretColumn }
    for (const selection of line.selections) {
      const absolute = { start: textOffset + selection.start, end: textOffset + selection.end }
      const previous = selections.at(-1)
      if (previous?.end === absolute.start) previous.end = absolute.end
      else selections.push(absolute)
    }
    textOffset += line.text.length + 1
  }

  return {
    text: rows.map((line) => line.text).join("\n"),
    caret,
    selections,
    visualLines: rows.map((line) => ({
      start: line.boundaries[0]?.offset ?? 0,
      end: line.boundaries.at(-1)?.offset ?? 0,
    })),
    prefixRange(start, end) {
      let boundary = 0
      let newlinesBeforeStart = 0
      let newlinesBeforeEnd = 0
      for (const prefixRow of prefixRows.slice(0, -1)) {
        boundary += prefixRow.length
        if (boundary <= start) newlinesBeforeStart += 1
        if (boundary < end) newlinesBeforeEnd += 1
      }
      return { start: start + newlinesBeforeStart, end: end + newlinesBeforeEnd }
    },
    cursorOffsetAt(x, y) {
      const line = rows[Math.max(0, Math.min(rows.length - 1, Math.floor(y)))]
      if (!line) return cursor
      const targetX = Math.max(0, x)
      let nearest = line.boundaries[0] ?? { x: 0, offset: cursor }
      for (const boundary of line.boundaries) {
        if (Math.abs(boundary.x - targetX) < Math.abs(nearest.x - targetX)) nearest = boundary
      }
      return nearest.offset
    },
  }
}

function wrapPrefix(prefix: string, width: number): string[] {
  const rows = [""]
  let rowWidth = 0
  for (const grapheme of graphemes(prefix)) {
    const graphemeWidth = displayWidth(grapheme.segment)
    if (rowWidth > 0 && rowWidth + graphemeWidth > width) {
      rows.push("")
      rowWidth = 0
    }
    rows[rows.length - 1] += grapheme.segment
    rowWidth += graphemeWidth
  }
  return rows
}

function createRow(prefix: string, offset: number): LayoutRow {
  const width = displayWidth(prefix)
  return { text: prefix, width, boundaries: [{ x: width, offset }], hasAnswer: false, selections: [] }
}

function editorTokens(value: string): LayoutToken[] {
  return graphemes(value).map((grapheme) => {
    const end = grapheme.index + grapheme.segment.length
    return {
      text: grapheme.segment,
      width: displayWidth(grapheme.segment),
      start: grapheme.index,
      end,
      kind: grapheme.segment === "\n" ? "newline" : "answer",
      whitespace: grapheme.segment !== "\n" && /^\s+$/u.test(grapheme.segment),
    }
  })
}
