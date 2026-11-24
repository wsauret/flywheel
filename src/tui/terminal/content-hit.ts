import { ImageRenderable, measureEditText, TextBufferRenderable, type LineInfo, type MouseEvent, type Renderable, type WidthMethod } from "@opentui/core"
import { displayWidth } from "./text.js"

// PI-INTERACTION-080 gives the terminal two hitboxes. A transcript line, a
// header, and a card take a pointer only on what they draw (`hitsDrawnContent`);
// a body that a transcript item shows takes it on every cell of its area
// (`hitsArea`).

/** Whether a pointer event lands on something its target draws: a text's visual
 *  line from its first drawn column through its last drawn glyph that is not
 *  whitespace, or any cell of an image. Blank space after a line's last glyph, a
 *  blank line, text that the renderable clips away, and every box (padding,
 *  gutter, border, the space beside a text) is a miss. The target is the leaf the
 *  pointer is over, so every handler an event bubbles through decides the same.
 *  Each answer is a lookup in the target's drawn extents, which derive once per
 *  content or layout change. */
export function hitsDrawnContent(event: MouseEvent): boolean {
  const { target } = event
  if (target instanceof ImageRenderable) return true
  if (!(target instanceof TextBufferRenderable)) return false
  const column = event.x - target.screenX
  return column >= 0 && column < drawnExtent(target, event.y - target.screenY + target.scrollY)
}

/** Whether a pointer event lands on any cell of `area`: its padding, border, and
 *  blank space, and everything it contains, whether drawn or blank. The leaf under
 *  the pointer decides, so a box that is no longer mounted is never hit, and an
 *  `area` of `undefined` is a miss. */
export function hitsArea(event: MouseEvent, area: Renderable | undefined): boolean {
  for (let node: Renderable | null = event.target; node !== null; node = node.parent) {
    if (node === area) return true
  }
  return false
}

/** Whether `event` lands on the last `label` in `content`, the string that
 *  `text` draws with its lines joined by line breaks. An inline control counts
 *  over its whole label, padding included, as a button does. */
export function hitsLabel(event: MouseEvent, text: Renderable | undefined, content: string, label: string): boolean {
  const index = content.lastIndexOf(label)
  if (text === undefined || event.target !== text || index < 0) return false
  const lines = content.slice(0, index).split("\n")
  const column = text.screenX + displayWidth(lines.at(-1) ?? "")
  return event.y === text.screenY + lines.length - 1 && event.x >= column && event.x < column + displayWidth(label)
}

interface DrawnLines {
  readonly info: LineInfo
  readonly lines: readonly string[]
  readonly scrollX: number
  readonly width: number
  /** Per visual line, the screen columns from the text's left edge that reach
   *  through its last drawn glyph. */
  readonly extents: number[]
  /** Per logical line, by source index: "ascii" when every character takes one
   *  cell, else its glyph scan so far. */
  readonly scans: Map<number, GlyphScan | "ascii">
}

/** A walk over one logical line's glyphs that stops at the visual line an event
 *  asks for and later resumes there, so no glyph is measured twice. */
interface GlyphScan {
  /** The logical line's first visual line. */
  readonly first: number
  /** Per visual line of the logical line, the drawn columns [from, to) in it. */
  readonly from: readonly number[]
  readonly to: readonly number[]
  readonly glyphs: Iterator<Intl.SegmentData>
  glyph: IteratorResult<Intl.SegmentData>
  column: number
  visual: number
  extent: number
}

const drawnLines = new WeakMap<TextBufferRenderable, DrawnLines>()
const watched = new WeakSet<TextBufferRenderable>()
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const BLANK = /^\s+$/u
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

function drawnExtent(target: TextBufferRenderable, row: number): number {
  let drawn = drawnLines.get(target)
  if (drawn === undefined || drawn.scrollX !== target.scrollX) {
    if (!watched.has(target)) {
      watched.add(target)
      // Content and width changes emit this, so the next event derives afresh.
      target.on("line-info-change", () => drawnLines.delete(target))
    }
    drawn = { info: drawn?.info ?? target.lineInfo, lines: drawn?.lines ?? target.plainText.split("\n"), scrollX: target.scrollX, width: target.width, extents: [], scans: new Map() }
    drawnLines.set(target, drawn)
  }
  if (drawn.extents[row] === undefined) measure(drawn, row, target.ctx.widthMethod)
  return drawn.extents[row] ?? 0
}

function measure(drawn: DrawnLines, row: number, widthMethod: WidthMethod): void {
  const { lineSources, lineWraps } = drawn.info
  const source = lineSources[row]
  if (source === undefined) return
  const first = row - (lineWraps[row] ?? 0)
  const line = drawn.lines[source] ?? ""
  let scan = drawn.scans.get(source)
  if (scan === undefined) {
    scan = PRINTABLE_ASCII.test(line) ? "ascii" : glyphScan(drawn, source, first, line)
    drawn.scans.set(source, scan)
  }
  if (scan === "ascii") {
    // One cell per character, so a visual line reads only its own columns.
    const [from, to] = drawnColumns(drawn, first, row)
    let end = Math.min(to, line.length)
    while (end > from && line.charCodeAt(end - 1) === 32) end -= 1
    drawn.extents[row] = Math.max(0, end - from)
  } else {
    scanThrough(drawn, scan, row, widthMethod)
  }
}

/** The columns of its logical line that visual line `visual` draws: its own
 *  wrapped part, cut to the text's visible width. */
function drawnColumns(drawn: DrawnLines, first: number, visual: number): readonly [number, number] {
  const { lineStartCols, lineWidthCols } = drawn.info
  // Offsets count cells, plus one per line break, so a visual line's columns in
  // its logical line are relative to the logical line's first visual line.
  const start = (lineStartCols[visual] ?? 0) - (lineStartCols[first] ?? 0)
  const from = start + drawn.scrollX
  return [from, Math.min(start + (lineWidthCols[visual] ?? 0), from + drawn.width)]
}

function glyphScan(drawn: DrawnLines, source: number, first: number, line: string): GlyphScan {
  const from: number[] = []
  const to: number[] = []
  for (let visual = first; drawn.info.lineSources[visual] === source; visual += 1) {
    const [start, end] = drawnColumns(drawn, first, visual)
    from.push(start)
    to.push(end)
  }
  const glyphs = segmenter.segment(line)[Symbol.iterator]()
  return { first, from, to, glyphs, glyph: glyphs.next(), column: 0, visual: 0, extent: 0 }
}

/** Advances `scan` until the extent of visual line `row` is known. */
function scanThrough(drawn: DrawnLines, scan: GlyphScan, row: number, widthMethod: WidthMethod): void {
  while (scan.first + scan.visual <= row) {
    if (scan.glyph.done === true || scan.column >= (scan.to[scan.visual] ?? 0)) {
      drawn.extents[scan.first + scan.visual] = scan.extent
      scan.visual += 1
      scan.extent = 0
      continue
    }
    const { segment } = scan.glyph.value
    const next = scan.column + cellWidth(segment, widthMethod)
    const start = scan.from[scan.visual] ?? 0
    // OpenTUI draws no part of a glyph that the visible edge cuts.
    const visible = scan.column >= start && next <= (scan.to[scan.visual] ?? 0)
    if (visible && !BLANK.test(segment)) scan.extent = next - start
    scan.column = next
    scan.glyph = scan.glyphs.next()
  }
}

function cellWidth(glyph: string, widthMethod: WidthMethod): number {
  const code = glyph.charCodeAt(0)
  return glyph.length === 1 && code >= 0x20 && code < 0x7f ? 1 : measureEditText(glyph, { widthMethod })
}
