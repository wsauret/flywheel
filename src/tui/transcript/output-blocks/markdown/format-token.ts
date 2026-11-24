/** Marked tokens as styled terminal text chunks, and the lexer settings that terminal prose needs. */

import type { TextChunk } from "@opentui/core"
import type { MarkdownStyles, StyleSpec } from "./markdown-styles.js"
import { marked, type Token, type Tokens } from "marked"
import { escapePipesInCodespans } from "./codespan-pipes.js"

const QUOTE_RULE = "\u2502"

export function markdownTextChunk(text: string, fg?: TextChunk["fg"], attributes?: number): TextChunk {
  const c: TextChunk = { __isChunk: true, text }
  if (fg) c.fg = fg
  if (attributes) c.attributes = attributes
  return c
}

export function plainOf(chunks: TextChunk[]): string {
  return chunks.map((c) => c.text).join("")
}

// Apply a StyleSpec to existing chunks. Foreground is set only on chunks that
// don't already carry a color, so nested codespans/links keep their identity.
function applyStyle(chunks: TextChunk[], style: StyleSpec): TextChunk[] {
  return chunks.map((c) => {
    const next: TextChunk = { ...c }
    if (style.attr) next.attributes = (c.attributes ?? 0) | style.attr
    if (style.fg && !c.fg) next.fg = style.fg
    return next
  })
}

function headingStyleFor(styles: MarkdownStyles, depth: number): StyleSpec {
  return [styles.h1, styles.h2, styles.h3, styles.h4, styles.h5, styles.h6][depth - 1] ?? styles.h6
}

function trailingNewlines(raw: string | undefined): string {
  return raw?.match(/\n+$/)?.[0] ?? ""
}

// SAFETY: marked's public types omit `Tokenizer.prototype`. The table rule below
// delegates to this built-in method after it escapes the row text. Shape verified
// against the installed marked Tokenizer prototype.
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: marked omits the runtime Tokenizer constructor from its public type
const builtInTable = (marked as { Tokenizer: { prototype: { table: (src: string) => Tokens.Table | undefined } } }).Tokenizer.prototype.table

let lexerConfigured = false

/**
 * Adjusts the shared marked lexer for terminal prose. Only the first call changes
 * anything, so every renderer can call it before it lexes.
 *
 * - `~` never starts strikethrough. Model prose uses it to mean "about", as in ~100.
 * - Angle brackets are literal text. Terminal prose has no HTML, so `<pipeline>` shows as typed.
 * - A `|` inside a backtick code span of a table row stays in its cell instead of starting a new column.
 */
export function configureMarkdownLexer(): void {
  if (lexerConfigured) return
  lexerConfigured = true
  marked.use({
    tokenizer: {
      del: () => undefined,
      html: () => undefined,
      tag: () => undefined,
      table(src: string) {
        // SAFETY: marked types `this` as the public Tokenizer, which omits the
        // instance `rules`; the runtime tokenizer keeps its table rule at `rules.block.table`.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: marked omits the runtime tokenizer rules from its public type
        const rows = (this as { rules: { block: { table: RegExp } } }).rules.block.table.exec(src)?.[0]
        if (rows === undefined) return undefined
        const escapedRows = rows.split("\n").map(escapePipesInCodespans).join("\n")
        const table = builtInTable.call(this, escapedRows + src.slice(rows.length))
        // The lexer advances by `raw`, so it must be the source text, not the escaped copy.
        if (table) table.raw = rows
        return table
      },
    },
  })
}

/** Where a token renders, as far as its output depends on it. */
type Place = {
  readonly styles: MarkdownStyles
  /** The number of list items that enclose the token. */
  readonly depth: number
  /** The item number when the enclosing list item is ordered, otherwise null. */
  readonly ordinal: number | null
  readonly parent: Token | null
  /** Prose of a list item keeps "N." and "N)" attached to the word before it. */
  readonly listProse: boolean
}

/** The place of a block that starts outside any list, such as a paragraph or a heading. */
function blockPlace(styles: MarkdownStyles): Place {
  return { styles, depth: 0, ordinal: null, parent: null, listProse: false }
}

function renderAll(tokens: readonly Token[] | undefined, place: Place): TextChunk[] {
  return tokens?.flatMap((token) => renderAt(token, place)) ?? []
}

const ROMAN_ONES = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"]
const ROMAN_TENS = ["", "x", "xx", "xxx", "xl", "l", "lx", "lxx", "lxxx", "xc"]
const ROMAN_HUNDREDS = ["", "c", "cc", "ccc", "cd", "d", "dc", "dcc", "dccc", "cm"]

function romanNumeral(n: number): string {
  const digit = (place: number) => Math.floor(n / place) % 10
  return "m".repeat(Math.floor(n / 1000))
    + (ROMAN_HUNDREDS[digit(100)] ?? "") + (ROMAN_TENS[digit(10)] ?? "") + (ROMAN_ONES[digit(1)] ?? "")
}

/** Spreadsheet-style column letters: 1 is "a", 26 is "z", and 27 is "aa". */
function letterLabel(n: number): string {
  if (n <= 0) return ""
  return letterLabel(Math.floor((n - 1) / 26)) + String.fromCharCode(97 + ((n - 1) % 26))
}

/** The label of ordered item `n` at nesting `level`, where 1 is the outermost list:
 *  numbers, then letters, then roman numerals, then numbers again. */
function ordinalLabel(level: number, n: number): string {
  if (level === 2) return letterLabel(n)
  if (level === 3) return romanNumeral(n)
  return String(n)
}

// A space before "N." or "N)" becomes a no-break space, so the number stays with the
// word before it and a wrapped line in a list item does not start with what reads as a
// new item marker, as in "I have 3. apples" or "Step 1)".
const NUMBER_MARKER_AFTER_SPACE = / (?=\d{1,9}[.)](?!\w))/g

function keepNumbersAttached(text: string): string {
  return text.replace(NUMBER_MARKER_AFTER_SPACE, "\u00A0")
}

// Split paragraph text on whitespace runs, then fold standalone whitespace into
// neighbors so wrapped prose never starts a visual line with an orphaned space.
function textChunks(text: string): TextChunk[] {
  if (!text) return []
  const pieces = text.split(/(\s+)/).filter((p) => p.length > 0)
  const folded: TextChunk[] = []
  let leadingWhitespace = ""

  for (const piece of pieces) {
    if (/^\s+$/.test(piece)) {
      const prev = folded[folded.length - 1]
      if (prev) {
        folded[folded.length - 1] = { ...prev, text: prev.text + piece }
      } else {
        leadingWhitespace += piece
      }
      continue
    }

    folded.push(markdownTextChunk(leadingWhitespace + piece))
    leadingWhitespace = ""
  }

  if (leadingWhitespace) {
    const prev = folded[folded.length - 1]
    if (prev) folded[folded.length - 1] = { ...prev, text: prev.text + leadingWhitespace }
  }

  return folded
}

// Split chunk array on newline characters into per-line chunk arrays.
export function splitLines(chunks: TextChunk[]): TextChunk[][] {
  let current: TextChunk[] = []
  const lines: TextChunk[][] = [current]
  for (const c of chunks) {
    const parts = c.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        current = []
        lines.push(current)
      }
      const part = parts[i]
      if (part) current.push({ ...c, text: part })
    }
  }
  return lines
}

export function joinLines(lines: TextChunk[][]): TextChunk[] {
  const out: TextChunk[] = []
  for (const [i, line] of lines.entries()) {
    if (i > 0) out.push(markdownTextChunk("\n"))
    out.push(...line)
  }
  return out
}

/** A quote nested in another block. Top-level quotes render in MarkdownBody. Every line
 *  with visible text gets the quote rule and the quote body style. */
function nestedQuote(token: Tokens.Blockquote | Tokens.Generic, styles: MarkdownStyles): TextChunk[] {
  const lines = splitLines(renderAll(token.tokens, blockPlace(styles)))
  return joinLines(lines.map((line) => plainOf(line).trim() === ""
    ? line
    : [markdownTextChunk(`${QUOTE_RULE} `, styles.blockquoteBar.fg, styles.blockquoteBar.attr), ...applyStyle(line, styles.blockquoteBody)]))
}

/** A link shows its text, or its URL when the text is empty or only repeats the URL. A
 *  mailto link shows the bare address and is not clickable. */
function linkChunks(token: Tokens.Link | Tokens.Generic, styles: MarkdownStyles): TextChunk[] {
  const url: string = token.href
  if (url.startsWith("mailto:")) return [markdownTextChunk(url.slice("mailto:".length))]
  const label = renderAll(token.tokens, { ...blockPlace(styles), parent: token })
  const labelText = plainOf(label)
  const shown = labelText !== "" && labelText !== url ? label : [markdownTextChunk(url)]
  return applyStyle(shown, styles.link).map((c) => ({ ...c, link: { url } }))
}

/** One list item. The item owns its marker, so the marker shows whether marked made the
 *  item tight (a `text` child) or loose (a `paragraph` child). The marker goes before the
 *  first child that is inline content. Code, quotes, and rules keep their own layout, and
 *  a nested list carries its own markers. */
function listItemChunks(item: Tokens.ListItem | Tokens.Generic, place: Place): TextChunk[] {
  const { styles, depth, ordinal } = place
  const marker = ordinal === null ? "-" : `${ordinalLabel(depth + 1, ordinal)}.`
  const indent = "  ".repeat(depth)
  const childPlace: Place = { styles, depth: depth + 1, ordinal, parent: item, listProse: false }
  const children: readonly Token[] = item.tokens ?? []
  let markerShown = false
  const out: TextChunk[] = []
  for (const [index, child] of children.entries()) {
    const ownsLayout = child.type === "code" || child.type === "blockquote" || child.type === "hr"
    if (!ownsLayout) {
      if (indent !== "") out.push(markdownTextChunk(indent))
      if (!markerShown && child.type !== "list") {
        out.push(markdownTextChunk(`${marker} `, styles.listMarker.fg, styles.listMarker.attr))
        markerShown = true
      }
    }
    out.push(...renderAt(child, childPlace))
    // Keep the source's line breaks between children; a `space` child already is one.
    const gap = child.type === "space" || index === children.length - 1 ? "" : trailingNewlines(child.raw)
    if (gap !== "") out.push(markdownTextChunk(gap))
  }
  const after = trailingNewlines(item.raw)
  if (after !== "") out.push(markdownTextChunk(after))
  return out
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === "list"
}

/** A text leaf. Inside a link the link styles it. In a list item it is the item's prose. */
function textLeaf(token: Tokens.Text | Tokens.Generic, place: Place): TextChunk[] {
  const text: string = token.text
  if (place.parent?.type === "link") return [markdownTextChunk(text)]
  if (place.parent?.type === "list_item") {
    return token.tokens === undefined
      ? textChunks(keepNumbersAttached(text))
      : renderAll(token.tokens, { ...place, parent: token, listProse: true })
  }
  return textChunks(place.listProse ? keepNumbersAttached(text) : text)
}

function renderAt(token: Token, place: Place): TextChunk[] {
  const { styles } = place
  switch (token.type) {
    case "text":
      return textLeaf(token, place)
    case "escape":
      return [markdownTextChunk(token.text)]
    case "codespan":
      // Code keeps its code style only. A path in code is not made clickable.
      return [markdownTextChunk(token.text, styles.code.fg, styles.code.attr)]
    case "em":
    case "strong": {
      // Emphasis keeps the enclosing parent and list-prose rule for its own text.
      const inner = renderAll(token.tokens, { ...blockPlace(styles), parent: place.parent, listProse: place.listProse })
      return applyStyle(inner, token.type === "em" ? styles.emphasis : styles.strong)
    }
    case "link":
      return linkChunks(token, styles)
    case "image":
      return [markdownTextChunk(token.href, styles.image.fg, styles.image.attr)]
    case "br":
      return [markdownTextChunk("\n")]
    case "space":
      return [markdownTextChunk(token.raw)]
    case "paragraph":
      return renderAll(token.tokens, blockPlace(styles))
    case "heading": {
      const title = applyStyle(renderAll(token.tokens, blockPlace(styles)), headingStyleFor(styles, token.depth))
      return [...title, markdownTextChunk(trailingNewlines(token.raw))]
    }
    case "hr":
      return [markdownTextChunk("---", styles.horizontalRule.fg, styles.horizontalRule.attr)]
    case "code":
      // Top-level code blocks render in MarkdownBody. A nested block shows its raw text.
      return [markdownTextChunk(token.text + trailingNewlines(token.raw), styles.codeBlock.fg, styles.codeBlock.attr)]
    case "blockquote":
      return nestedQuote(token, styles)
    case "list": {
      // marked's open `Tokens.Generic` arm keeps the switch from narrowing past it, so the
      // predicate pins the token to the List the lexer emits and types `items`.
      if (!isListToken(token)) return []
      const first = typeof token.start === "number" ? token.start : 1
      return token.items.flatMap((item, index) => listItemChunks(item, {
        ...place,
        ordinal: token.ordered ? first + index : null,
        parent: token,
        listProse: false,
      }))
    }
    case "list_item":
      return listItemChunks(token, place)
  }
  // Tables render in MarkdownBody, and definitions do not render. Strikethrough and
  // HTML never reach here: configureMarkdownLexer turns their tokenizers off.
  return []
}

/** Renders one marked token as styled text chunks. */
export function renderMarkdownToken(token: Token, styles: MarkdownStyles): TextChunk[] {
  return renderAt(token, blockPlace(styles))
}
