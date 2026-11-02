/**
 * Incremental markdown lexing for streaming text blocks.
 *
 * A growing message re-lexed in full on every flush costs O(total chars) per
 * flush; the lexer dominates the streaming render path. This model freezes a
 * committed prefix as already-folded segments and re-lexes only the volatile
 * tail, so per-flush cost is bounded by the tail, not the message.
 *
 * Two cuts advance the prefix:
 *
 * - Token cut: the prefix may advance to a top-level `space` token (a blank
 *   line, which in marked is always a token boundary; fences are atomic tokens,
 *   so a boundary is never inside an open fence) whose preceding token is plain
 *   narration (not a breakout, not another space), staying a two-token guard
 *   band behind the live edge. Blank lines hard-terminate paragraphs, lists,
 *   and tables, and the guard band keeps any block whose interpretation a
 *   future delta could still reach back into (setext headings, lazy list and
 *   table continuations reach back one block; nothing reaches back two) in the
 *   volatile region.
 * - Line cut: a paragraph with no blank line in it would otherwise stay
 *   volatile whole, so each delta re-lexed the entire paragraph. The prefix may
 *   advance to a hard line break inside the live trailing paragraph, at a text
 *   segment boundary (`TEXT_SEGMENT_LINES`) at least `GUARD_LINES` lines behind
 *   the live edge. A cut is taken only when lexing the two sides apart
 *   reproduces the segments of the whole tail exactly, and when no inline
 *   delimiter before the cut is still unpaired, so no later closer can restyle
 *   committed lines. The one remaining reach-back is a setext underline, which
 *   turns the whole paragraph into a heading: the tail then no longer starts
 *   with the paragraph, and the prefix rewinds to where the paragraph's first
 *   line cut began and lexes the paragraph whole once.
 *
 * So a line cut never makes the segments differ from a full lex of the same
 * source, at any update.
 *
 * Non-append updates (edits, fence unwrapping changing the prefix, style or
 * theme change) reset the state and fall back to a full re-lex.
 */

import type { Token } from "marked"
import { textChunksEqual } from "@tui/utils/text.js"
import { configureMarkdownLexer } from "./format-token.js"
import { foldTokensToSegments, isBreakoutToken, lexMarkdown, TEXT_SEGMENT_LINES, type MarkdownSegment } from "./line-model.js"
import type { MarkdownStyles } from "./markdown-styles.js"
import { unwrapMarkdownFences } from "./unwrap-fences.js"

const GUARD_TOKENS = 2
/** Lines of the live paragraph a line cut keeps volatile: a GFM table
 *  delimiter row claims the line before it as its header. */
const GUARD_LINES = 2

/** How the committed prefix ends: after a token cut or on a line cut's hard
 *  line break. */
type Seam = "token" | "line"

interface CommittedState {
  src: string
  segments: readonly MarkdownSegment[]
  seam: Seam
}

function findTokenCut(tokens: Token[]): number {
  for (let i = tokens.length - 1 - GUARD_TOKENS; i >= 1; i--) {
    // SAFETY: i ranges in [1, tokens.length - 1 - GUARD_TOKENS], so tokens[i]
    // is within bounds.
    const current = tokens[i]!
    // SAFETY: i >= 1 (loop guard), so tokens[i - 1] is within bounds.
    const prev = tokens[i - 1]!
    if (current.type === "space" && prev.type !== "space" && !isBreakoutToken(prev)) return i
  }
  return -1
}

/**
 * The tail-source offset of the furthest line cut the live paragraph allows,
 * or -1. Text runs split into segments every `TEXT_SEGMENT_LINES` lines from
 * the start of the run, so a cut on such a boundary leaves the segments before
 * it exactly as the whole-tail fold has them.
 */
function findLineCut(tokens: readonly Token[], segments: readonly MarkdownSegment[]): number {
  const paragraph = tokens[tokens.length - 1]
  if (paragraph?.type !== "paragraph") return -1
  let runLines = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment?.kind !== "text") break
    runLines += segment.lines.length
  }
  const paragraphLines = paragraph.raw.replace(/\n$/, "").split("\n").length
  const linesBefore = runLines - paragraphLines
  const boundary = Math.floor((runLines - GUARD_LINES) / TEXT_SEGMENT_LINES) * TEXT_SEGMENT_LINES
  if (linesBefore < 0 || boundary <= linesBefore) return -1
  // The boundary lies at least GUARD_LINES lines before the paragraph's last
  // line, so each searched line break exists.
  let within = 0
  for (let line = linesBefore; line < boundary; line++) within = paragraph.raw.indexOf("\n", within) + 1
  return tokens.slice(0, -1).reduce((sum, token) => sum + token.raw.length, 0) + within
}

// A literal emphasis, strikethrough, or code-span delimiter, the start of an
// inline tag, or an underscore that is not inside a word: each can still open
// a span that a later line closes.
const OPENABLE_DELIMITER = /[*~`]|(?:^|[^\p{L}\p{N}])_|<[A-Za-z/!?]/u

/**
 * Whether an inline delimiter in `tokens` is still unpaired, so text after a
 * line cut could pair with it and restyle the lines before the cut. Paired
 * spans, code spans, escapes, and complete tags are settled; any delimiter
 * left as literal text is not, and neither is an unclosed bracket. The check
 * is conservative: a literal that could never open (such as `a * b`) also
 * keeps the paragraph volatile, which costs only lexing.
 */
function hasUnpairedInline(tokens: readonly Token[]): boolean {
  let literal = ""
  const walk = (list: readonly Token[]): void => {
    for (const token of list) {
      if (token.type === "text") literal += token.raw
      else {
        literal += " "
        if ("tokens" in token && token.tokens !== undefined) walk(token.tokens)
      }
    }
  }
  walk(tokens)
  if (OPENABLE_DELIMITER.test(literal)) return true
  let depth = 0
  for (const char of literal) {
    if (char === "[") depth += 1
    else if (char === "]" && depth > 0) depth -= 1
  }
  return depth > 0
}

function segmentEqual(segment: MarkdownSegment, other: MarkdownSegment | undefined): boolean {
  switch (segment.kind) {
    case "blank": return other?.kind === "blank"
    case "text": return other?.kind === "text" && segment.lines.length === other.lines.length && segment.lines.every((line, row) => textChunksEqual(line, other.lines[row] ?? []))
    case "code": return other?.kind === "code" && segment.lang === other.lang && segment.text === other.text
    case "blockquote": return other?.kind === "blockquote" && segment.token.raw === other.token.raw
    case "table": return other?.kind === "table" && segment.token.raw === other.token.raw
    default: {
      const exhaustive: never = segment
      throw new Error(`Unhandled segment kind: ${String(exhaustive)}`)
    }
  }
}

function segmentsEqual(a: readonly MarkdownSegment[], b: readonly MarkdownSegment[]): boolean {
  return a.length === b.length && a.every((segment, index) => segmentEqual(segment, b[index]))
}

/**
 * The two sides of a line cut, or undefined when lexing them apart renders
 * differently from the whole tail now, or when a later closer could still
 * pair with a delimiter before the cut.
 */
function splitAtLineCut(tail: readonly Token[], lineCut: number, tailSegments: readonly MarkdownSegment[], styles: MarkdownStyles, hasPrior: boolean): { headSrc: string; head: MarkdownSegment[]; restTokens: Token[]; rest: MarkdownSegment[] } | undefined {
  const tailSrc = tail.map((token) => token.raw).join("")
  const headSrc = tailSrc.slice(0, lineCut)
  const headTokens = lexMarkdown(headSrc, false)
  const paragraph = headTokens[headTokens.length - 1]
  if (paragraph?.type !== "paragraph" || hasUnpairedInline(paragraph.tokens ?? [])) return undefined
  const restTokens = lexMarkdown(tailSrc.slice(lineCut), false)
  const head = foldTokensToSegments(headTokens, styles, hasPrior)
  const rest = foldTokensToSegments(restTokens, styles, true)
  return segmentsEqual([...head, ...rest], tailSegments) ? { headSrc, head, restTokens, rest } : undefined
}

/**
 * Join committed segments with the segments that follow them. After a token
 * cut the tail starts at the cut's `space` token and normally folds
 * blank-first, so the join is a plain concat and committed segment objects
 * keep their identity, which lets the renderer's <Index> reuse their rows. The
 * text-to-text merge remains for lexer shapes whose token seam is not a blank
 * row: the committed side's open last line continues into the tail's first
 * line, exactly as `splitLines` would have produced for the unsplit chunk
 * stream. A line cut ends the prefix on a hard line break, so what follows
 * starts a new line and joins by concat.
 */
function joinSegments(committed: readonly MarkdownSegment[], next: readonly MarkdownSegment[], seam: Seam): MarkdownSegment[] {
  const last = committed[committed.length - 1]
  const first = next[0]
  if (seam === "line" || last?.kind !== "text" || first?.kind !== "text") return [...committed, ...next]
  const merged = [...(last.lines[last.lines.length - 1] ?? []), ...(first.lines[0] ?? [])]
  return [
    ...committed.slice(0, -1),
    { kind: "text", lines: [...last.lines.slice(0, -1), merged, ...first.lines.slice(1)] },
    ...next.slice(1),
  ]
}

export function createStreamingSegments(): (source: string, styles: MarkdownStyles, unwrapFences?: boolean) => MarkdownSegment[] {
  let committedSrc = ""
  let committedSegments: readonly MarkdownSegment[] = []
  let seam: Seam = "token"
  let lastStyles: MarkdownStyles | null = null
  // The committed state before the live paragraph's first line cut. A setext
  // underline reinterprets the whole paragraph, so the prefix rewinds here.
  // A token cut closes the paragraph and forgets it.
  let paragraphStart: CommittedState | undefined
  // The absolute offset of the last line cut that failed its check. The
  // candidate moves once per text segment, so a refused cut costs one check,
  // not one per delta.
  let rejectedLineCut = -1

  function commit(src: string, segments: readonly MarkdownSegment[], nextSeam: Seam): void {
    if (nextSeam === "line") paragraphStart ??= { src: committedSrc, segments: committedSegments, seam }
    else paragraphStart = undefined
    committedSegments = joinSegments(committedSegments, segments, seam)
    committedSrc += src
    seam = nextSeam
  }

  function restore(state: CommittedState): void {
    committedSrc = state.src
    committedSegments = state.segments
    seam = state.seam
    paragraphStart = undefined
  }

  return (source, styles, unwrapFences = false) => {
    configureMarkdownLexer()
    const src = unwrapFences ? unwrapMarkdownFences(source) : source
    if (styles !== lastStyles || !src.startsWith(committedSrc)) {
      restore({ src: "", segments: [], seam: "token" })
      lastStyles = styles
      rejectedLineCut = -1
    }
    let tail = lexMarkdown(src.slice(committedSrc.length), false)
    if (paragraphStart !== undefined && tail[0]?.type !== "paragraph") {
      restore(paragraphStart)
      tail = lexMarkdown(src.slice(committedSrc.length), false)
    }
    const tokenCut = findTokenCut(tail)
    if (tokenCut > 0) {
      const committed = tail.slice(0, tokenCut)
      tail = tail.slice(tokenCut)
      commit(committed.map((token) => token.raw).join(""), foldTokensToSegments(committed, styles, committedSrc.length > 0), "token")
    }
    let tailSegments = foldTokensToSegments(tail, styles, committedSrc.length > 0)
    const lineCut = findLineCut(tail, tailSegments)
    if (lineCut > 0 && committedSrc.length + lineCut !== rejectedLineCut) {
      const split = splitAtLineCut(tail, lineCut, tailSegments, styles, committedSrc.length > 0)
      if (split === undefined) rejectedLineCut = committedSrc.length + lineCut
      else {
        commit(split.headSrc, split.head, "line")
        tail = split.restTokens
        tailSegments = split.rest
      }
    }
    return joinSegments(committedSegments, markVolatileCode(tailSegments), seam)
  }
}

/** Code segments in the volatile tail are still growing (or sit inside the
 *  guard band): flag them so the renderer drives one live `<code>` renderable
 *  in incremental streaming mode. Commit re-folds them without the flag. */
function markVolatileCode(tail: MarkdownSegment[]): MarkdownSegment[] {
  return tail.map((seg) => (seg.kind === "code" ? { ...seg, streaming: true as const } : seg))
}
