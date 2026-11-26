/**
 * Flat markdown line model for TUI rendering.
 *
 * Markdown renders to a flat `Segment[]`: text segments carry styled lines, and
 * blank lines are render data with a single owner. Top-level code blocks,
 * tables, and blockquotes break out as their own segments; all other markdown
 * folds into text segments through `renderMarkdownToken`.
 */

import type { TextChunk } from "@opentui/core"
import { marked, type Token, type Tokens } from "marked"
import { markdownTextChunk, configureMarkdownLexer, renderMarkdownToken, splitLines } from "./format-token.js"
import type { MarkdownStyles } from "./markdown-styles.js"
import { unwrapMarkdownFences } from "./unwrap-fences.js"

export type MarkdownSegment =
  | { kind: "text"; lines: TextChunk[][] }
  | { kind: "blank" }
  /** `streaming` marks a code segment still in the volatile tail of a growing
   *  message: the renderer keeps one live `<code>` renderable in incremental
   *  streaming mode instead of re-parsing the whole fence per flush. Commit
   *  replaces the segment without the flag, settling the renderable. */
  | { kind: "code"; lang: string | undefined; text: string; streaming?: true }
  | { kind: "blockquote"; token: Tokens.Blockquote }
  | { kind: "table"; token: Tokens.Table }

/** The number of rendered lines after which a text run starts a new segment.
 *  The renderer gives each text segment one `<text>`, and OpenTUI's
 *  styled-text update walks every line of that renderable once per chunk, so
 *  an unbounded paragraph made each streaming update cost O(chunks x lines) of
 *  the whole reply. Splits fall only on hard line breaks, so wrapping, layout,
 *  and copied text are unchanged. A run's last segment can hold one line more:
 *  refer to `foldTokensToSegments`. */
export const TEXT_SEGMENT_LINES = 64

const TOKEN_CACHE_MAX = 500
// The entry keeps the raw content beside the tokens: xxHash32 is a 32-bit key,
// so a hit is honored only when the content matches - a collision must never
// serve another message's tokens.
const tokenCache = new Map<string, { content: string; tokens: Token[] }>()

export function lexMarkdown(content: string, cache: boolean): Token[] {
  if (!cache) return marked.lexer(content)

  const key = Bun.hash.xxHash32(content, 0).toString()
  const hit = tokenCache.get(key)
  if (hit && hit.content === content) {
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit.tokens
  }

  const tokens = marked.lexer(content)
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, { content, tokens })
  return tokens
}

export function isBreakoutToken(token: Token | undefined): boolean {
  return token?.type === "code" || token?.type === "table" || token?.type === "blockquote"
}

// marked's `Token` includes the open `Tokens.Generic` arm (`type: string`), so a
// `token.type === "code"` check leaves `Tokens.Code | Tokens.Generic` rather than
// narrowing to the concrete interface. These predicates pin the discriminant to
// the concrete shape the lexer actually emits for these block types.
function isCodeToken(token: Token): token is Tokens.Code {
  return token.type === "code"
}
function isTableToken(token: Token): token is Tokens.Table {
  return token.type === "table"
}
function isBlockquoteToken(token: Token): token is Tokens.Blockquote {
  return token.type === "blockquote"
}

function newlineCount(raw: string): number {
  return [...raw].filter((c) => c === "\n").length
}

function pushSourceSpace(out: MarkdownSegment[], raw: string, next: Token | undefined, hasPrior: boolean): void {
  const count = newlineCount(raw)
  if (count === 0) return
  const hasPrevious = out.length > 0 || hasPrior
  const hasNext = next !== undefined
  const rows = hasPrevious && hasNext ? count - 1 : count
  for (let i = 0; i < rows; i++) out.push({ kind: "blank" })
}

// A table at the end of the message folds its trailing blank lines into
// `token.raw` (there is no following `space` token), so the fold owns them as
// blank rows: only newlines beyond the last row's own terminator count. Other
// breakout tokens never own trailing blanks: a blockquote's trailing newlines
// always split into a `space` token, and a code fence keeps a trailing run in
// its raw only while unclosed, where the run already renders inside the block.
function pushTrailingTableNewlines(out: MarkdownSegment[], token: Token, next: Token | undefined): void {
  if (next !== undefined) return
  let run = 0
  const raw = token.raw
  while (run < raw.length && raw[raw.length - 1 - run] === "\n") run++
  for (let i = 1; i < run; i++) out.push({ kind: "blank" })
}

/**
 * Fold lexed top-level tokens into segments. `hasPrior` tells the fold that
 * already-rendered content precedes these tokens (the incremental streaming
 * path folds a committed prefix and a volatile tail separately), so blank-line
 * counting at the front edge matches a single whole-source fold.
 *
 * EVERY top-level blank line closes the pending text segment (the renderer emits one
 * widget per block; the committed-prefix path keeps a stable committed prefix the same way),
 * so committed paragraphs are permanently stable objects the renderer's <Index>
 * reuses, and the streaming commit cut at a `space` token makes the
 * committed/tail seam blank-to-text - a growing tail never rebuilds the whole
 * since-last-breakout run. A text run longer than `TEXT_SEGMENT_LINES` also
 * splits into segments of that many lines, counted from the start of the run,
 * so a long paragraph commits and renders in bounded pieces. An empty last
 * line stays with the segment before it, for the reason at the cut.
 */
export function foldTokensToSegments(tokens: Token[], styles: MarkdownStyles, hasPrior = false): MarkdownSegment[] {
  const out: MarkdownSegment[] = []
  let pending: TextChunk[] = []

  const flushText = () => {
    if (pending.length === 0) return
    const lines = splitLines(pending)
    for (let start = 0, end = 0; start < lines.length; start = end) {
      end = start + TEXT_SEGMENT_LINES
      // An empty <text> has no cell to select, so OpenTUI never lists it among
      // the selected renderables, and the copy has no row for its blank line.
      // A cut never leaves the run's last line alone when that line is empty.
      if (end === lines.length - 1 && lines[end]?.length === 0) end += 1
      out.push({ kind: "text", lines: lines.slice(start, end) })
    }
    pending = []
  }

  for (const [i, token] of tokens.entries()) {
    const next = tokens[i + 1]
    if (token.type === "space") {
      flushText()
      pushSourceSpace(out, token.raw, next, hasPrior)
    } else if (isCodeToken(token)) {
      flushText()
      out.push({ kind: "code", lang: token.lang, text: token.text })
    } else if (isTableToken(token)) {
      flushText()
      out.push({ kind: "table", token })
      pushTrailingTableNewlines(out, token, next)
    } else if (isBlockquoteToken(token)) {
      flushText()
      out.push({ kind: "blockquote", token })
    } else {
      // A block token folding into a non-empty pending run must start on its
      // own line. A list interrupting a paragraph (single newline, no `space`
      // token) is the common case: the paragraph token does not emit its
      // trailing newline, so the fold owns the separator.
      const last = pending[pending.length - 1]
      if (last && !last.text.endsWith("\n")) pending.push(markdownTextChunk("\n"))
      pending.push(...renderMarkdownToken(token, styles))
    }
  }
  flushText()
  return out
}

/**
 * Render markdown source into the flat segment line model.
 *
 * `unwrapFences` strips ```md fences that wrap a real table (agent content).
 * Streaming callers should prefer `createStreamingSegments` (incremental tail
 * lexing); stable content passes `cache=true` to avoid re-lexing on scroll
 * remount.
 */
export function renderToLineModel(
  source: string,
  styles: MarkdownStyles,
  unwrapFences = false,
  cache = false,
): MarkdownSegment[] {
  configureMarkdownLexer()
  const src = unwrapFences ? unwrapMarkdownFences(source) : source
  return foldTokensToSegments(lexMarkdown(src, cache), styles)
}
