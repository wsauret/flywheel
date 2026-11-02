import type { RGBA } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { resolveSyntaxLanguage } from "./syntax-language.js"
import type { HLJSApi } from "highlight.js"
import clojure from "highlight.js/lib/languages/clojure"
import dart from "highlight.js/lib/languages/dart"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import elixir from "highlight.js/lib/languages/elixir"
import erlang from "highlight.js/lib/languages/erlang"
import groovy from "highlight.js/lib/languages/groovy"
import latex from "highlight.js/lib/languages/latex"
import nix from "highlight.js/lib/languages/nix"
import ocaml from "highlight.js/lib/languages/ocaml"
import powershell from "highlight.js/lib/languages/powershell"
import protobuf from "highlight.js/lib/languages/protobuf"
import scala from "highlight.js/lib/languages/scala"

// Loading highlight.js builds every grammar it registers, which costs startup
// time that no first frame needs, so the first highlight pays it instead.
let loaded: HLJSApi | undefined
function hljs(): HLJSApi {
  if (loaded) return loaded
  // oxlint-disable-next-line node/global-require, unicorn/prefer-module -- a synchronous lazy load keeps the highlighter API synchronous; the bundler still embeds the module
  const api: HLJSApi = require("highlight.js/lib/common")
  api.registerLanguage("clojure", clojure)
  api.registerLanguage("dart", dart)
  api.registerLanguage("dockerfile", dockerfile)
  api.registerLanguage("elixir", elixir)
  api.registerLanguage("erlang", erlang)
  api.registerLanguage("groovy", groovy)
  api.registerLanguage("latex", latex)
  api.registerLanguage("nix", nix)
  api.registerLanguage("ocaml", ocaml)
  api.registerLanguage("powershell", powershell)
  api.registerLanguage("protobuf", protobuf)
  api.registerLanguage("scala", scala)
  loaded = api
  return api
}

export const MAX_HIGHLIGHT_BYTES = 512 * 1024
export const MAX_HIGHLIGHT_LINES = 10_000
// highlight.js takes time quadratic in the length of one token in some grammars (a TypeScript
// identifier of 18,000 characters takes about 0.5 s), and a token cannot be longer than its line.
export const MAX_HIGHLIGHT_LINE_LENGTH = 2_000

export interface SyntaxColors {
  readonly text: RGBA
  readonly comment: RGBA
  readonly keyword: RGBA
  readonly function: RGBA
  readonly variable: RGBA
  readonly string: RGBA
  readonly number: RGBA
  readonly type: RGBA
  readonly operator: RGBA
  readonly punctuation: RGBA
}

type SyntaxColorKey = Exclude<keyof SyntaxColors, "text">

export function chatSyntaxColors(theme: TuiTheme): SyntaxColors {
  return {
    text: theme.text,
    comment: theme.chatCodeComment,
    keyword: theme.chatCodeKeyword,
    function: theme.chatCodeFunction,
    variable: theme.chatCodeVariable,
    string: theme.chatCodeString,
    number: theme.chatCodeNumber,
    type: theme.chatCodeType,
    operator: theme.chatCodeOperator,
    punctuation: theme.chatCodePunctuation,
  }
}

interface ScopeColors {
  [scope: string]: SyntaxColorKey
}

interface HtmlEntities {
  [entity: string]: string
}

const SCOPE_COLORS: ScopeColors = {
  "hljs-keyword": "keyword",
  "hljs-built_in": "type",
  "hljs-type": "type",
  "hljs-literal": "number",
  "hljs-number": "number",
  "hljs-string": "string",
  "hljs-comment": "comment",
  "hljs-function": "function",
  "hljs-title": "function",
  "hljs-title function_": "function",
  "hljs-title class_": "type",
  "hljs-attr": "variable",
  "hljs-variable": "variable",
  "hljs-variable language_": "keyword",
  "hljs-params": "variable",
  "hljs-property": "variable",
  "hljs-operator": "operator",
  "hljs-punctuation": "punctuation",
  "hljs-meta": "keyword",
  "hljs-regexp": "string",
  "hljs-template-variable": "variable",
  "hljs-template-tag": "keyword",
  "hljs-symbol": "number",
  "hljs-selector-tag": "keyword",
  "hljs-selector-class": "variable",
  "hljs-selector-id": "variable",
  "hljs-subst": "punctuation",
  "hljs-section": "function",
  "hljs-bullet": "number",
  "hljs-emphasis": "comment",
  "hljs-strong": "keyword",
  "hljs-addition": "string",
  "hljs-deletion": "comment",
}

const ENTITIES: HtmlEntities = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&[#\w]+;/g, (m) => ENTITIES[m] ?? m)
}

type Segment = { text: string; color?: RGBA }
type HighlightedLine = Segment[]

function resolveColor(classStr: string, colors: SyntaxColors): RGBA | undefined {
  const key = SCOPE_COLORS[classStr]
  if (key) return colors[key]
  const first = classStr.split(" ")[0]
  if (!first) return undefined
  const firstKey = SCOPE_COLORS[first]
  return firstKey ? colors[firstKey] : undefined
}

function appendTextToLines(
  lines: HighlightedLine[],
  raw: string,
  colorStack: (RGBA | undefined)[],
  plainTextColor?: RGBA,
): void {
  const text = decodeEntities(raw)
  const color = colorStack.findLast((c) => c != null) ?? plainTextColor
  for (const [i, part] of text.split("\n").entries()) {
    if (i > 0) lines.push([])
    if (part) {
      const currentLine = lines[lines.length - 1]
      if (currentLine) currentLine.push(color ? { text: part, color } : { text: part })
    }
  }
}

// Sticky flag anchors the match at lastIndex, avoiding a per-tag html.slice allocation.
const SPAN_OPEN_RE = /<span class="([^"]*?)">/y

function tryParseTag(
  html: string,
  pos: number,
  colorStack: (RGBA | undefined)[],
  colors: SyntaxColors,
): number | null {
  if (html.startsWith("</span>", pos)) {
    colorStack.pop()
    return pos + 7
  }
  SPAN_OPEN_RE.lastIndex = pos
  const match = SPAN_OPEN_RE.exec(html)
  if (match) {
    colorStack.push(resolveColor(match[1] ?? "", colors))
    return pos + match[0].length
  }
  return null
}

// Tracks color state across line breaks so multi-line tokens stay colored.
function parseToLines(html: string, colors: SyntaxColors, plainTextColor?: RGBA): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]]
  const colorStack: (RGBA | undefined)[] = []
  let pos = 0

  while (pos < html.length) {
    if (html.charCodeAt(pos) === 60) {
      const tagEnd = tryParseTag(html, pos, colorStack, colors)
      if (tagEnd !== null) { pos = tagEnd; continue }
    }

    const next = html.indexOf("<", pos)
    const raw = next === -1 ? html.slice(pos) : html.slice(pos, next)
    if (raw) appendTextToLines(lines, raw, colorStack, plainTextColor)
    pos = next === -1 ? html.length : next
  }

  return lines
}

function resolveLang(filetype: string | undefined): string | undefined {
  const lang = resolveSyntaxLanguage(filetype)?.highlightJs
  if (!lang) return undefined
  return hljs().getLanguage(lang) ? lang : undefined
}

function toPlainLines(code: string, text: RGBA): HighlightedLine[] {
  return code.split("\n").map((line) => line ? [{ text: line, color: text }] : [])
}

function normalizeCode(code: string): string {
  const withoutCarriageReturns = code.replace(/\r/g, "")
  return withoutCarriageReturns.endsWith("\n")
    ? withoutCarriageReturns.slice(0, -1)
    : withoutCarriageReturns
}

function exceedsLineLimits(code: string): boolean {
  let lines = 1
  let lineStart = 0
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) !== 10) continue
    if (i - lineStart > MAX_HIGHLIGHT_LINE_LENGTH || ++lines > MAX_HIGHLIGHT_LINES) return true
    lineStart = i + 1
  }
  return code.length - lineStart > MAX_HIGHLIGHT_LINE_LENGTH
}

function prepareHighlightInput(code: string, filetype: string | undefined) {
  const normalizedCode = normalizeCode(code)
  const language = resolveLang(filetype)
  const withinLimits =
    Buffer.byteLength(normalizedCode, "utf-8") <= MAX_HIGHLIGHT_BYTES &&
    !exceedsLineLimits(normalizedCode)

  return {
    code: normalizedCode,
    language: language && withinLimits ? language : undefined,
  }
}

function highlightCode(code: string, language: string | undefined, colors: SyntaxColors, colorPlainText: boolean): HighlightedLine[] {
  if (!language) return toPlainLines(code, colors.text)
  try {
    return parseToLines(
      hljs().highlight(code, { language, ignoreIllegals: true }).value,
      colors,
      colorPlainText ? colors.text : undefined,
    )
  } catch {
    return toPlainLines(code, colors.text)
  }
}

export function createHighlighter(colors: SyntaxColors, colorPlainText = false): (code: string, filetype: string | undefined) => HighlightedLine[] {
  let prevCode: string | undefined
  let prevLanguage: string | undefined
  let prevResult: HighlightedLine[] = []

  return (code, filetype) => {
    const input = prepareHighlightInput(code, filetype)
    if (input.code === prevCode && input.language === prevLanguage) return prevResult

    // Incremental path: if new code appends to previous and filetype is unchanged,
    // reuse already-highlighted complete lines and only re-process the new tail.
    // The last cached line is always re-done since it may have been mid-token.
    // Multi-line syntax spans crossing the boundary may highlight slightly wrong
    // during streaming; acceptable since tool_input_complete triggers a full re-highlight.
    if (
      input.language &&
      prevCode !== undefined &&
      input.language === prevLanguage &&
      input.code.length > prevCode.length &&
      input.code.startsWith(prevCode) &&
      prevResult.length > 1
    ) {
      const lastNewline = prevCode.lastIndexOf("\n")
      if (lastNewline >= 0) {
        const stableLineCount = prevResult.length - 1
        const tail = input.code.slice(lastNewline + 1)
        const tailHighlighted = highlightCode(tail, input.language, colors, colorPlainText)
        prevCode = input.code
        prevResult = prevResult.slice(0, stableLineCount).concat(tailHighlighted)
        return prevResult
      }
    }

    prevCode = input.code
    prevLanguage = input.language
    prevResult = input.language === undefined && !colorPlainText
      ? input.code.split("\n").map((line) => line ? [{ text: line }] : [])
      : highlightCode(input.code, input.language, colors, colorPlainText)
    return prevResult
  }
}
