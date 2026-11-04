import { measureEditText, TextBuffer, TextBufferView, type TextChunk } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const NON_ASCII_PRINTABLE = /[^\x20-\x7E]/
/** Control characters other than tab. A text renderable draws them in no
 *  column, where OpenTUI's edit measure counts each as a visible escape. */
// oxlint-disable-next-line no-control-regex -- boundary: the renderer draws these controls in no column, and OpenTUI's measure counts them
const ZERO_WIDTH_CONTROLS = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/g

/** The columns that the renderer draws `text` in. Printable ASCII, the
 *  overwhelming case for tool output and streaming logs, is one column per
 *  character. Anything else takes OpenTUI's own native measure with its
 *  default `unicode` width method, so that layout agrees cell for cell with
 *  what the renderer draws. A JavaScript width table does not: string-width
 *  counts text-style symbols such as U+2764 as one column, which the
 *  renderer draws in two. The renderer draws the text of an ANSI escape
 *  after its ESC, so this measure counts that text too. */
export function displayWidth(text: string): number {
  return NON_ASCII_PRINTABLE.test(text) ? measureEditText(text.replace(ZERO_WIDTH_CONTROLS, ""), { widthMethod: "unicode" }) : text.length
}

/** Measures word-wrapped rows with the renderer's native width rules.
 *  Call in a component owner; its reusable native buffer and view are released
 *  on cleanup. The returned counter throws if native measurement fails. */
export function useWrappedLineCount(): (text: string, width: number) => number {
  const renderer = useRenderer()
  const buffer = TextBuffer.create(renderer.widthMethod, renderer.nativeScene)
  const view = TextBufferView.create(buffer)
  view.setWrapMode("word")
  onCleanup(() => {
    view.destroy()
    buffer.destroy()
  })
  return (text, width) => {
    buffer.setText(text)
    const measure = view.measureForDimensions(width, 1)
    if (measure === null) throw new Error("OpenTUI could not measure wrapped text")
    return measure.lineCount
  }
}

export interface Grapheme {
  segment: string
  index: number
}

export function graphemes(text: string): Grapheme[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment, index }) => ({ segment, index }))
}

export function graphemeBoundaryAtOrBefore(text: string, offset: number): number {
  const target = Math.max(0, Math.min(text.length, offset))
  let boundary = 0
  for (const grapheme of graphemes(text)) {
    if (grapheme.index > target) break
    boundary = grapheme.index
  }
  return target === text.length ? text.length : boundary
}

export function previousGraphemeBoundary(text: string, offset: number): number {
  const target = graphemeBoundaryAtOrBefore(text, offset)
  let previous = 0
  for (const grapheme of graphemes(text)) {
    if (grapheme.index >= target) break
    previous = grapheme.index
  }
  return previous
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  const target = graphemeBoundaryAtOrBefore(text, offset)
  for (const grapheme of graphemes(text)) {
    if (grapheme.index > target) return grapheme.index
  }
  return text.length
}

export function truncateText(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen)
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

/** Truncate text to a terminal display width without splitting grapheme clusters. */
export function truncateToWidth(text: string, maxWidth: number, marker = "..."): string {
  if (maxWidth <= 0) return ""
  if (displayWidth(text) <= maxWidth) return text
  const markerWidth = displayWidth(marker)
  if (maxWidth <= markerWidth) return sliceToWidth(text, maxWidth)
  return `${sliceToWidth(text, maxWidth - markerWidth)}${marker}`
}

/** The widths that texts of `widths` keep in `room` columns. Every text
 *  keeps its whole width while they all fit; else the widest gives up
 *  columns first, until the texts are equally wide, and then they give up
 *  columns in turn. No text keeps less than one column. */
export function shareWidth(widths: readonly number[], room: number): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= room) return [...widths]
  // The widest width that every text may keep: the largest cap whose sum
  // fits the room.
  let cap = Math.max(...widths)
  while (cap > 1 && widths.reduce((sum, width) => sum + Math.min(width, cap), 0) > room) cap -= 1
  // The columns that the cap leaves go to the first texts that it cut.
  let spare = room - widths.reduce((sum, width) => sum + Math.min(width, cap), 0)
  return widths.map((width) => {
    if (width <= cap || spare <= 0) return Math.min(width, cap)
    spare -= 1
    return cap + 1
  })
}

function sliceToWidth(text: string, maxWidth: number): string {
  let result = ""
  let width = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment)
    if (width + segmentWidth > maxWidth) break
    result += segment
    width += segmentWidth
  }
  return result
}

/** How many columns `chunks` take. */
export function chunksWidth(chunks: readonly TextChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0)
}

/** Chunks that fit in `width` columns: the last one that does not fit ends
 *  in an ellipsis, and the rest drop. A cut that would keep no text before
 *  its ellipsis, such as a cut column of padding, drops too, so a line
 *  never shows a lone ellipsis. */
export function fitChunks(chunks: readonly TextChunk[], width: number): TextChunk[] {
  const fitted: TextChunk[] = []
  let used = 0
  for (const chunk of chunks) {
    const chunkWidth = displayWidth(chunk.text)
    if (used + chunkWidth <= width) {
      fitted.push(chunk)
      used += chunkWidth
      continue
    }
    const kept = width - used > 1 ? sliceToWidth(chunk.text, width - used - 1) : ""
    if (kept.trim() !== "") fitted.push({ ...chunk, text: `${kept}…` })
    break
  }
  return fitted
}

/** Whether two chunk runs render identically: same text, colors,
 *  attributes, and link target in the same order. */
export function textChunksEqual(a: readonly TextChunk[], b: readonly TextChunk[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x?.text !== y?.text || x?.fg !== y?.fg || x?.bg !== y?.bg || x?.attributes !== y?.attributes || x?.link?.url !== y?.link?.url) return false
  }
  return true
}
