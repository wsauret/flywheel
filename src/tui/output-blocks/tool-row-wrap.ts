import type { TextChunk } from "@opentui/core"
import { displayWidth } from "@tui/utils/text.js"

// Manual word-wrap for a tool row that keeps the whole row a single selectable
// <text> element (copy/paste reconstructs from one renderable) while giving
// continuation lines a hanging indent under the start of the detail text,
// Grouped. opentui's wrapMode has no hanging-indent option and splitting
// the row into sibling <text> columns would drop pieces from copied text, so
// we pre-wrap here and bake the indent spaces into the content.
//
// `prefix` is the gutter rendered on line one only (connector + status glyph +
// verb + trailing space). `body` wraps; continuation lines start with the
// `continuation` chunks (a tree rail like "│", empty by default) padded with
// spaces to the prefix's display width, so wrapped text hangs under the first
// detail character. The returned chunks embed "\n" + rail + indent, so both
// the rendered output and the copied text carry the line structure.

interface Cell {
  ch: string
  /** Display width, computed once at cell construction: the wrap loop reads
   *  widths O(n) times and a per-read Unicode measurement dominated streaming
   *  CPU profiles. */
  w: number
  src: TextChunk
}

export function chunkDisplayWidth(chunks: readonly TextChunk[]): number {
  let width = 0
  for (const chunk of chunks) width += displayWidth(chunk.text)
  return width
}

export function truncateChunks(chunks: readonly TextChunk[], maxWidth: number, ellipsis: TextChunk): TextChunk[] {
  if (chunkDisplayWidth(chunks) <= maxWidth) return [...chunks]
  const contentWidth = maxWidth - displayWidth(ellipsis.text)
  if (contentWidth < 0) return []

  const truncated: TextChunk[] = []
  let remaining = contentWidth
  outer: for (const chunk of chunks) {
    let text = ""
    for (const character of Array.from(chunk.text)) {
      const width = displayWidth(character)
      if (width > remaining) {
        if (text) truncated.push({ ...chunk, text })
        break outer
      }
      text += character
      remaining -= width
    }
    if (text) truncated.push({ ...chunk, text })
  }
  truncated.push(ellipsis)
  return truncated
}

function toCells(chunks: readonly TextChunk[]): Cell[] {
  const cells: Cell[] = []
  // Historical facts can carry "\r" or "\r\n" line breaks (terminal
  // bracketed paste). Normalize here so every hard break takes the railed
  // hanging-indent path instead of leaking a raw CR to the renderer's
  // wrapMode, which knows nothing about the indent. The CR flag survives
  // chunk boundaries so a CRLF split across styled chunks stays one break.
  let prevWasCR = false
  for (const src of chunks) {
    for (const ch of Array.from(src.text)) {
      if (ch === "\n" && prevWasCR) {
        prevWasCR = false
        continue
      }
      prevWasCR = ch === "\r"
      const normalized = prevWasCR ? "\n" : ch
      cells.push({ ch: normalized, w: normalized === "\n" ? 0 : displayWidth(normalized), src })
    }
  }
  return cells
}

// Merge consecutive cells that came from the same source chunk back into a
// single styled chunk, preserving fg/bg/attributes/link.
function cellsToChunks(cells: readonly Cell[]): TextChunk[] {
  const out: TextChunk[] = []
  let curSrc: TextChunk | null = null
  let text = ""
  for (const cell of cells) {
    if (cell.src === curSrc) {
      text += cell.ch
      continue
    }
    if (curSrc) out.push({ ...curSrc, text })
    curSrc = cell.src
    text = cell.ch
  }
  if (curSrc) out.push({ ...curSrc, text })
  return out
}

/** Wrap styled text to terminal cells with a hanging rail. A finite line limit
 *  caps input with an ellipsis, reserving space for the suffix. Status and
 *  disclosure suffixes remain complete; ordinary command rows are unlimited. */
export function wrapToolRowChunks(
  prefix: readonly TextChunk[],
  body: readonly TextChunk[],
  maxWidth: number,
  continuation: readonly TextChunk[] = [],
  maxLines = Number.POSITIVE_INFINITY,
  suffix: readonly TextChunk[] = [],
): TextChunk[] {
  if (body.length === 0) return [...prefix, ...suffix]
  const prefixWidth = chunkDisplayWidth(prefix)
  // Wrapping needs at least two usable columns after the gutter; otherwise the
  // terminal is narrow or a wide gutter ate the budget. Drop the hanging
  // indent so a long tool name cannot hide the detail or its controls.
  // Callers measure width at the list container and filter the not-yet-laid-out
  // NaN there, so only real column counts arrive here.
  if (!(maxWidth - prefixWidth >= 2)) {
    if (!(maxWidth >= 2) && !Number.isFinite(maxLines)) return [...prefix, ...body, ...suffix]
    if (maxWidth < 2) return [...truncateChunks([...prefix, ...body], maxWidth, { __isChunk: true, text: "…" }), ...suffix]
    return wrapToolRowChunks([], [...prefix, ...body], maxWidth, [], maxLines, suffix)
  }

  const indentWidth = prefixWidth
  const avail = maxWidth - indentWidth

  const cells = toCells(Number.isFinite(maxLines) ? body : [...body, ...suffix])
  const lines: Cell[][] = []
  let line: Cell[] = []
  let lineWidth = 0
  let pending: Cell[] = []
  let pendingWidth = 0
  // A hard line start (start of body or just after "\n") keeps its leading
  // spaces: multiline shell commands carry meaningful indentation. Soft wrap
  // breaks still drop pending spaces so continuations hang cleanly.
  let atHardStart = true

  let i = 0
  while (i < cells.length) {
    // SAFETY: i < cells.length is the loop guard, so cells[i] is present.
    const cell = cells[i]!
    if (cell.ch === "\n") {
      lines.push(line)
      line = []
      lineWidth = 0
      pending = []
      pendingWidth = 0
      atHardStart = true
      i += 1
      continue
    }
    if (cell.ch === " ") {
      pending.push(cell)
      pendingWidth += 1
      i += 1
      continue
    }
    const word: Cell[] = []
    let wordWidth = 0
    for (let wc = cells[i]; wc !== undefined && wc.ch !== " " && wc.ch !== "\n"; wc = cells[i]) {
      word.push(wc)
      wordWidth += wc.w
      i += 1
    }
    if (line.length === 0) {
      // Start of a line: a hard start keeps its indentation; a wrap break
      // drops any pending spaces left over from the break.
      line = atHardStart ? [...pending, ...word] : [...word]
      lineWidth = (atHardStart ? pendingWidth : 0) + wordWidth
    } else if (lineWidth + pendingWidth + wordWidth <= avail) {
      line.push(...pending, ...word)
      lineWidth += pendingWidth + wordWidth
    } else {
      lines.push(line)
      line = [...word]
      lineWidth = wordWidth
    }
    // A word wider than the available width can't soft-wrap; hard-split it so
    // continuation lines (and their rail) stay under this wrapper's control
    // instead of falling through to the renderer's rail-less wrapMode.
    while (lineWidth > avail) {
      let cut = 0
      let cutWidth = 0
      for (const c of line) {
        if (cutWidth + c.w > avail) break
        cutWidth += c.w
        cut += 1
      }
      if (cut === 0) break
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
      lineWidth -= cutWidth
    }
    pending = []
    pendingWidth = 0
    atHardStart = false
  }
  // Trailing spaces stay for copy fidelity, but they must wrap here so the
  // renderer never creates a continuation row without the rail.
  if (pending.length > 0) {
    let trailing = pending
    while (trailing.length > 0) {
      const take = Math.min(avail - lineWidth, trailing.length)
      line.push(...trailing.slice(0, take))
      lineWidth += take
      trailing = trailing.slice(take)
      if (trailing.length > 0) {
        lines.push(line)
        line = []
        lineWidth = 0
      }
    }
  }
  lines.push(line)

  const out: TextChunk[] = [...prefix]
  // Continuation lines carry the rail chunks (e.g. "│") padded with spaces to
  // the prefix width, so wrapped text still hangs under the detail start.
  const pad = " ".repeat(Math.max(0, indentWidth - chunkDisplayWidth(continuation)))
  for (const [idx, ln] of lines.slice(0, maxLines).entries()) {
    if (idx > 0) {
      out.push({ __isChunk: true, text: "\n" })
      // Clone per line: one TextChunk instance must not repeat in a StyledText.
      for (const chunk of continuation) out.push({ ...chunk })
      // A blank hard line keeps the rail but skips the pad, so copied text
      // carries no trailing spaces.
      if (pad.length > 0 && ln.length > 0) out.push({ __isChunk: true, text: pad })
    }
    const chunks = cellsToChunks(ln)
    if (Number.isFinite(maxLines) && idx === Math.min(lines.length, maxLines) - 1) {
      const ellipsis: TextChunk = { __isChunk: true, text: "…" }
      const omitted = lines.length > maxLines || (lines.length === maxLines && chunkDisplayWidth([...chunks, ...suffix]) > avail)
      const detail = omitted ? truncateChunks([...chunks, ellipsis], Math.max(1, avail - chunkDisplayWidth(suffix)), ellipsis) : chunks
      const tail = wrapToolRowChunks([], [...detail, ...suffix], avail)
      for (const chunk of tail) {
        out.push(chunk)
        if (chunk.text === "\n") {
          out.push(...continuation.map((part) => ({ ...part })))
          if (pad) out.push({ __isChunk: true, text: pad })
        }
      }
    } else {
      out.push(...chunks)
    }
  }
  return out
}
