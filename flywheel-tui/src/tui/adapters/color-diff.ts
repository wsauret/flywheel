/** Unified diff renderer with word-level highlighting. Adapted from Claude Code's native-ts/color-diff. */

import { diffArrays } from "diff"
import type { RGBA } from "@opentui/core"
import type { Hunk } from "./diff-parser.js"

interface DiffThemeColors {
  text: RGBA
  textMuted: RGBA
  addedBg: RGBA
  removedBg: RGBA
  highlightAdded: RGBA
  highlightRemoved: RGBA
  addedFg: RGBA
  removedFg: RGBA
  lineNumber: RGBA
}

type DiffSegment = {
  text: string
  fg?: RGBA
  bg?: RGBA
}

type DiffLine = {
  segments: DiffSegment[]
  lineBg?: RGBA
}

// Use null as sentinel for "no color / terminal default"
type Color = RGBA | null
type Style = { foreground: Color; background: Color }
type Block = [Style, string]
type Marker = "+" | "-" | " "

function blocksToDiffLine(blocks: Block[], lineBg: Color): DiffLine {
  const segments = blocks.map(([style, text]) => {
    const seg: DiffSegment = { text }
    if (style.foreground) seg.fg = style.foreground
    // Only emit bg on segments where it differs from the line bg (word highlights)
    if (style.background && style.background !== lineBg) seg.bg = style.background
    return seg
  })
  return { segments, lineBg: lineBg ?? undefined }
}

type Theme = {
  addLine: Color
  addWord: Color
  addDecoration: Color
  deleteLine: Color
  deleteWord: Color
  deleteDecoration: Color
  foreground: Color
  background: Color
  lineNumber: Color
}

function buildTheme(colors: DiffThemeColors): Theme {
  return {
    addLine: colors.addedBg,
    addWord: colors.highlightAdded,
    addDecoration: colors.addedFg,
    deleteLine: colors.removedBg,
    deleteWord: colors.highlightRemoved,
    deleteDecoration: colors.removedFg,
    foreground: colors.text,
    background: null,
    lineNumber: colors.lineNumber,
  }
}

function defaultStyle(theme: Theme): Style {
  return { foreground: theme.foreground, background: theme.background }
}

function lineBackground(marker: Marker, theme: Theme): Color {
  if (marker === "+") return theme.addLine
  if (marker === "-") return theme.deleteLine
  return theme.background
}

function wordBackground(marker: Marker, theme: Theme): Color {
  if (marker === "+") return theme.addWord
  if (marker === "-") return theme.deleteWord
  return theme.background
}

function decorationColor(marker: Marker, theme: Theme): Color {
  if (marker === "+") return theme.addDecoration
  if (marker === "-") return theme.deleteDecoration
  return theme.foreground
}

type Range = { start: number; end: number }

// >40% of combined line length changed — skip word-diff, the lines differ too much for it to help.
const CHANGE_THRESHOLD = 0.4

function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      let j = i + 1
      while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else if (/\s/.test(ch)) {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else {
      const cp = text.codePointAt(i)!
      const len = cp > 0xffff ? 2 : 1
      tokens.push(text.slice(i, i + len))
      i += len
    }
  }
  return tokens
}

function findAdjacentPairs(markers: Marker[]): [number, number][] {
  const pairs: [number, number][] = []
  let i = 0
  while (i < markers.length) {
    if (markers[i] === "-") {
      const delStart = i
      let delEnd = i
      while (delEnd < markers.length && markers[delEnd] === "-") delEnd++
      let addEnd = delEnd
      while (addEnd < markers.length && markers[addEnd] === "+") addEnd++
      const delCount = delEnd - delStart
      const addCount = addEnd - delEnd
      if (delCount > 0 && addCount > 0) {
        const n = Math.min(delCount, addCount)
        for (let k = 0; k < n; k++) {
          pairs.push([delStart + k, delEnd + k])
        }
        i = addEnd
      } else {
        i = delEnd
      }
    } else {
      i++
    }
  }
  return pairs
}

function wordDiffStrings(oldStr: string, newStr: string): [Range[], Range[]] {
  const oldTokens = tokenize(oldStr)
  const newTokens = tokenize(newStr)
  const ops = diffArrays(oldTokens, newTokens)

  const totalLen = oldStr.length + newStr.length
  let changedLen = 0
  const oldRanges: Range[] = []
  const newRanges: Range[] = []
  let oldOff = 0
  let newOff = 0

  for (const op of ops) {
    const len = op.value.reduce((s, t) => s + t.length, 0)
    if (op.removed) {
      changedLen += len
      oldRanges.push({ start: oldOff, end: oldOff + len })
      oldOff += len
    } else if (op.added) {
      changedLen += len
      newRanges.push({ start: newOff, end: newOff + len })
      newOff += len
    } else {
      oldOff += len
      newOff += len
    }
  }

  if (totalLen > 0 && changedLen / totalLen > CHANGE_THRESHOLD) {
    return [[], []]
  }
  return [oldRanges, newRanges]
}

type Highlight = {
  marker: Marker | null
  lineNumber: number
  lines: Block[][]
}

function removeNewlines(h: Highlight): void {
  h.lines = h.lines.map((line) =>
    line.flatMap(([style, text]) =>
      text
        .split("\n")
        .filter((p) => p.length > 0)
        .map((p): Block => [style, p]),
    ),
  )
}

function lineNumberColor(marker: Marker | null, theme: Theme): Color {
  if (marker === "+") return theme.addDecoration
  if (marker === "-") return theme.deleteDecoration
  return theme.foreground
}

function addLineNumber(h: Highlight, theme: Theme, maxDigits: number): void {
  const style: Style = {
    foreground: lineNumberColor(h.marker, theme),
    background: h.marker ? lineBackground(h.marker, theme) : theme.background,
  }
  for (let i = 0; i < h.lines.length; i++) {
    const prefix =
      i === 0
        ? ` ${String(h.lineNumber).padStart(maxDigits)} `
        : " ".repeat(maxDigits + 2)
    h.lines[i]!.unshift([style, prefix])
  }
}

function addMarker(h: Highlight, theme: Theme): void {
  if (!h.marker) return
  const style: Style = {
    foreground: decorationColor(h.marker, theme),
    background: lineBackground(h.marker, theme),
  }
  for (const line of h.lines) {
    line.unshift([style, h.marker])
  }
}

function applyBackground(h: Highlight, theme: Theme, ranges: Range[]): void {
  if (!h.marker) return
  const lineBg = lineBackground(h.marker, theme)
  const wordBg = wordBackground(h.marker, theme)

  let rangeIdx = 0
  let byteOff = 0
  for (let li = 0; li < h.lines.length; li++) {
    const newLine: Block[] = []
    for (const [style, text] of h.lines[li]!) {
      const textStart = byteOff
      const textEnd = byteOff + text.length

      while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= textStart) {
        rangeIdx++
      }
      if (rangeIdx >= ranges.length) {
        newLine.push([{ ...style, background: lineBg }, text])
        byteOff = textEnd
        continue
      }

      let remaining = text
      let pos = textStart
      while (remaining.length > 0 && rangeIdx < ranges.length) {
        const r = ranges[rangeIdx]!
        const inRange = pos >= r.start && pos < r.end
        let next: number
        if (inRange) {
          next = Math.min(r.end, textEnd)
        } else if (r.start > pos && r.start < textEnd) {
          next = r.start
        } else {
          next = textEnd
        }
        const segLen = next - pos
        const seg = remaining.slice(0, segLen)
        newLine.push([{ ...style, background: inRange ? wordBg : lineBg }, seg])
        remaining = remaining.slice(segLen)
        pos = next
        if (pos >= r.end) rangeIdx++
      }
      if (remaining.length > 0) {
        newLine.push([{ ...style, background: lineBg }, remaining])
      }
      byteOff = textEnd
    }
    h.lines[li] = newLine
  }
}

function maxLineNumber(hunk: Hunk): number {
  const oldEnd = Math.max(0, hunk.oldStart + hunk.oldLines - 1)
  const newEnd = Math.max(0, hunk.newStart + hunk.newLines - 1)
  return Math.max(oldEnd, newEnd)
}

function parseMarker(s: string): Marker {
  return s === "+" || s === "-" ? s : " "
}

export function renderHunk(hunk: Hunk, colors: DiffThemeColors): DiffLine[] {
  const theme = buildTheme(colors)
  const maxDigits = String(maxLineNumber(hunk)).length
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  type Entry = { lineNumber: number; marker: Marker; code: string }
  const entries: Entry[] = hunk.lines.map((rawLine) => {
    const marker = parseMarker(rawLine.slice(0, 1))
    const code = rawLine.slice(1)
    let lineNumber = newLine
    switch (marker) {
      case "+":
        lineNumber = newLine++
        break
      case "-":
        lineNumber = oldLine++
        break
      case " ":
        lineNumber = newLine
        oldLine++
        newLine++
        break
    }
    return { lineNumber, marker, code }
  })

  const ranges: Range[][] = entries.map(() => [])
  const markers = entries.map((e) => e.marker)
  for (const [delIdx, addIdx] of findAdjacentPairs(markers)) {
    const [delR, addR] = wordDiffStrings(
      entries[delIdx]!.code,
      entries[addIdx]!.code,
    )
    ranges[delIdx] = delR
    ranges[addIdx] = addR
  }

  const out: DiffLine[] = []
  for (let i = 0; i < entries.length; i++) {
    const { lineNumber, marker, code } = entries[i]!
    const tokens: Block[] = [[defaultStyle(theme), code]]
    const lineBg = lineBackground(marker, theme)

    const h: Highlight = { marker, lineNumber, lines: [tokens] }
    removeNewlines(h)
    applyBackground(h, theme, ranges[i]!)
    addMarker(h, theme)
    addLineNumber(h, theme, maxDigits)
    for (const line of h.lines) {
      out.push(blocksToDiffLine(line, lineBg))
    }
  }
  return out
}
