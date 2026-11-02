import { TextBuffer, TextBufferView, type TextChunk } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import stringWidth from "string-width"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const NON_ASCII_PRINTABLE = /[^\x20-\x7E]/

/** Terminal display width. Printable ASCII - the overwhelming case for tool
 *  output and streaming logs - is width-per-char with no Unicode machinery.
 *  Anything else takes string-width's full path (ANSI strip, emoji sequences,
 *  east-asian width, grapheme segmentation), which costs an Intl.Segmenter
 *  pass per call and must stay off per-character hot paths. */
export function displayWidth(text: string): number {
  return NON_ASCII_PRINTABLE.test(text) ? stringWidth(text) : text.length
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
  if (stringWidth(text) <= maxWidth) return text
  const markerWidth = stringWidth(marker)
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
    const segmentWidth = stringWidth(segment)
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
