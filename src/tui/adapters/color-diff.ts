/** Unified diff rows as styled gutter and code segments, with changed words emphasized. */

import type { RGBA } from "@opentui/core"
import { diffArrays } from "diff"
import type { Hunk, TypedDiffRow } from "./diff-parser.js"

interface DiffThemeColors {
  text: RGBA
  textMuted: RGBA
  addedBg: RGBA
  removedBg: RGBA
  highlightAdded: RGBA
  highlightRemoved: RGBA
  /** Standard diffs retain their original text color when this is null. */
  highlightForeground: RGBA | null
  addedFg: RGBA
  removedFg: RGBA
  lineNumber: RGBA
}

type DiffSegment = {
  text: string
  fg?: RGBA
  bg?: RGBA
}

/** One diff line. The gutter (line number and marker) renders apart from the code, so a
 *  wrapped code line continues under the code rather than under the gutter. */
type DiffLine = {
  gutter: DiffSegment[]
  segments: DiffSegment[]
  lineBg?: RGBA
}

export type DiffSyntaxHighlighter = (code: string) => readonly { readonly text: string; readonly color?: RGBA }[]

type RowKind = TypedDiffRow["kind"]
type SourcePiece = { readonly text: string; readonly color?: RGBA }
type NumberedRow = { readonly kind: RowKind; readonly text: string; readonly number: number | undefined }

/** Offsets in a row's code where emphasis alternately starts and stops. */
type EmphasisEdges = readonly number[]
const NO_EDGES: EmphasisEdges = []

/** How one row kind draws its gutter and background in a decorated diff. */
type KindLook = {
  readonly sign: string
  readonly accent: RGBA
  readonly background?: RGBA
  readonly emphasis?: RGBA
}

/** Emphasis is a reading aid. Above this share of changed characters the pair reads as a
 *  rewrite, and highlighting most of both rows only adds noise. */
const REWRITE_SHARE = 0.4
/** Combined token count of a pair above which the comparison is skipped unattempted. */
const WORD_TOKEN_BUDGET = 2048
/** Edit distance at which the token comparison gives up. Together with the token budget it
 *  keeps a long or heavily edited row from stalling the render. */
const EDIT_SEARCH_LIMIT = 128

/** One token per run of word characters, per run of whitespace, or per other code point.
 *  Word characters are letters, digits, and "_" in the Basic Multilingual Plane. A letter
 *  outside that plane is its own token. */
const WORD_TOKEN = /(?:(?![\u{10000}-\u{10FFFF}])[\p{L}\p{N}_])+|\s+|[^]/gu

interface KindLooks {
  readonly add: KindLook
  readonly remove: KindLook
  readonly context: KindLook
}

function kindLooks(colors: DiffThemeColors): KindLooks {
  return {
    add: { sign: "+", accent: colors.addedFg, background: colors.addedBg, emphasis: colors.highlightAdded },
    remove: { sign: "-", accent: colors.removedFg, background: colors.removedBg, emphasis: colors.highlightRemoved },
    context: { sign: " ", accent: colors.text },
  }
}

/** The tokens of `text`, or undefined when it has more than `budget` of them. */
function wordTokens(text: string, budget: number): string[] | undefined {
  const tokens: string[] = []
  WORD_TOKEN.lastIndex = 0
  for (let match = WORD_TOKEN.exec(text); match !== null; match = WORD_TOKEN.exec(text)) {
    if (tokens.length === budget) return undefined
    tokens.push(match[0])
  }
  return tokens
}

/** The emphasis edges of a removed row and the added row that replaces it. Undefined
 *  when emphasis would not help: the pair is too large to compare, the edit is too large
 *  to find within the search limit, or the pair reads as a rewrite. */
function changedWordEdges(removed: string, added: string): readonly [EmphasisEdges, EmphasisEdges] | undefined {
  const removedTokens = wordTokens(removed, WORD_TOKEN_BUDGET)
  if (removedTokens === undefined) return undefined
  const addedTokens = wordTokens(added, WORD_TOKEN_BUDGET - removedTokens.length)
  if (addedTokens === undefined) return undefined
  const parts = diffArrays(removedTokens, addedTokens, { maxEditLength: EDIT_SEARCH_LIMIT })
  if (parts === undefined) return undefined

  const removedEdges: number[] = []
  const addedEdges: number[] = []
  let removedAt = 0
  let addedAt = 0
  let changed = 0
  for (const part of parts) {
    const width = part.value.join("").length
    if (part.removed) removedEdges.push(removedAt, removedAt + width)
    if (part.added) addedEdges.push(addedAt, addedAt + width)
    if (part.removed || part.added) changed += width
    if (!part.added) removedAt += width
    if (!part.removed) addedAt += width
  }
  const total = removed.length + added.length
  return total > 0 && changed / total > REWRITE_SHARE ? undefined : [removedEdges, addedEdges]
}

/** Emphasis edges for every row of a hunk. In each block of removed rows followed directly
 *  by added rows, the n-th added row compares with the n-th removed row. A row without a
 *  partner gets no emphasis. */
function hunkEmphasis(rows: readonly NumberedRow[]): EmphasisEdges[] {
  const edges = rows.map(() => NO_EDGES)
  let unpartnered: number[] = []
  let blockHasAdditions = false
  for (const [index, row] of rows.entries()) {
    if (row.kind === "add") {
      blockHasAdditions = true
      const partner = unpartnered.shift()
      const pair = partner === undefined ? undefined : changedWordEdges(rows[partner]?.text ?? "", row.text)
      if (partner !== undefined && pair !== undefined) {
        edges[partner] = pair[0]
        edges[index] = pair[1]
      }
      continue
    }
    if (row.kind === "context" || blockHasAdditions) {
      unpartnered = []
      blockHasAdditions = false
    }
    if (row.kind === "remove") unpartnered.push(index)
  }
  return edges
}

function numberHunkRows(hunk: Hunk): NumberedRow[] {
  let nextOld = hunk.oldStart
  let nextNew = hunk.newStart
  return hunk.lines.map((line) => {
    const kind: RowKind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context"
    const number = kind === "remove" ? nextOld : nextNew
    if (kind !== "add") nextOld++
    if (kind !== "remove") nextNew++
    return { kind, text: line.slice(1), number }
  })
}

/** Paints numbered rows. Without a syntax highlighter the rows carry diff decoration:
 *  kind colors in the gutter, a sign column, a row background, and word emphasis. With
 *  one, the highlighter's colors replace all of that. */
function rowPainter(colors: DiffThemeColors, highlightSyntax: DiffSyntaxHighlighter | undefined, digits: number) {
  const looks = highlightSyntax === undefined ? kindLooks(colors) : undefined

  function codeSegments(pieces: readonly SourcePiece[], edges: EmphasisEdges, look: KindLook | undefined): DiffSegment[] {
    const segments: DiffSegment[] = []
    let offset = 0
    let passed = 0
    for (const piece of pieces) {
      const end = offset + piece.text.length
      const fg = piece.color ?? colors.text
      let at = offset
      do {
        while (passed < edges.length && (edges[passed] ?? end) <= at) passed++
        const stop = Math.min(edges[passed] ?? end, end)
        const text = piece.text.slice(at - offset, stop - offset)
        const emphasis = passed % 2 === 1 ? look?.emphasis : undefined
        // A segment carries a background only where it differs from the row's own.
        segments.push(emphasis === undefined
          ? { text, fg }
          : emphasis === look?.background
            ? { text, fg: colors.highlightForeground ?? fg }
            : { text, fg: colors.highlightForeground ?? fg, bg: emphasis })
        at = stop
      } while (at < end)
      offset = end
    }
    return segments
  }

  return (row: NumberedRow, edges: EmphasisEdges, keepEmptyPieces: boolean): DiffLine => {
    const look = looks?.[row.kind]
    const source: readonly SourcePiece[] = highlightSyntax?.(row.text) ?? [{ text: row.text }]
    const pieces = keepEmptyPieces
      ? source
      : source.flatMap((piece) => piece.text.split("\n").filter((text) => text.length > 0).map((text) => ({ ...piece, text })))
    const gutter: DiffSegment[] = []
    if (row.number !== undefined) gutter.push({ text: ` ${String(row.number).padStart(digits)} `, fg: look?.accent ?? colors.text })
    if (look !== undefined) gutter.push({ text: look.sign, fg: look.accent })
    return { gutter, segments: codeSegments(pieces, edges, look), lineBg: look?.background }
  }
}

/** A syntax highlighter selects source presentation, without diff decoration. */
export function renderHunk(hunk: Hunk, colors: DiffThemeColors, highlightSyntax?: DiffSyntaxHighlighter): DiffLine[] {
  const rows = numberHunkRows(hunk)
  const edges = highlightSyntax === undefined ? hunkEmphasis(rows) : []
  const largest = Math.max(0, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1)
  const paint = rowPainter(colors, highlightSyntax, String(largest).length)
  // Hunk code drops line breaks and empty pieces, so an empty row has no code segment.
  return rows.map((row, index) => paint(row, edges[index] ?? NO_EDGES, false))
}

/** A syntax highlighter selects source presentation, without diff decoration.
 * Renders active proposal rows independently. It does not compare neighboring
 * rows because an incomplete proposal does not yet establish a settled hunk. */
export function renderTypedDiffRows(rows: readonly TypedDiffRow[], colors: DiffThemeColors, highlightSyntax?: DiffSyntaxHighlighter, finalLineNumber = 0): DiffLine[] {
  // The gutter is as wide as the largest line number any row knows, on either side.
  let largest = finalLineNumber === 0 ? undefined : finalLineNumber
  for (const row of rows) {
    for (const line of [row.kind === "add" ? undefined : row.oldLine, row.kind === "remove" ? undefined : row.newLine]) {
      if (line !== undefined) largest = Math.max(largest ?? 0, line)
    }
  }
  const paint = rowPainter(colors, highlightSyntax, largest === undefined ? 0 : String(largest).length)
  return rows.map((row) => paint({ kind: row.kind, text: row.text, number: row.kind === "remove" ? row.oldLine : row.newLine }, NO_EDGES, true))
}
