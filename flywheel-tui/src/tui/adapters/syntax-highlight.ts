import hljs from "highlight.js/lib/common"
import type { RGBA } from "@opentui/core"
import type { Theme } from "@tui/shared/context/theme/resolve.js"

const LANG_ALIASES: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  zsh: "bash",
}

const SCOPE_COLORS: Record<string, keyof Theme> = {
  "hljs-keyword": "syntaxKeyword",
  "hljs-built_in": "syntaxType",
  "hljs-type": "syntaxType",
  "hljs-literal": "syntaxNumber",
  "hljs-number": "syntaxNumber",
  "hljs-string": "syntaxString",
  "hljs-comment": "syntaxComment",
  "hljs-function": "syntaxFunction",
  "hljs-title": "syntaxFunction",
  "hljs-title function_": "syntaxFunction",
  "hljs-title class_": "syntaxType",
  "hljs-attr": "syntaxVariable",
  "hljs-variable": "syntaxVariable",
  "hljs-variable language_": "syntaxKeyword",
  "hljs-params": "syntaxVariable",
  "hljs-property": "syntaxVariable",
  "hljs-operator": "syntaxOperator",
  "hljs-punctuation": "syntaxPunctuation",
  "hljs-meta": "syntaxKeyword",
  "hljs-regexp": "syntaxString",
  "hljs-template-variable": "syntaxVariable",
  "hljs-template-tag": "syntaxKeyword",
  "hljs-symbol": "syntaxNumber",
  "hljs-selector-tag": "syntaxKeyword",
  "hljs-selector-class": "syntaxVariable",
  "hljs-selector-id": "syntaxVariable",
  "hljs-subst": "syntaxPunctuation",
  "hljs-section": "syntaxFunction",
  "hljs-bullet": "syntaxNumber",
  "hljs-emphasis": "syntaxComment",
  "hljs-strong": "syntaxKeyword",
  "hljs-addition": "syntaxString",
  "hljs-deletion": "syntaxComment",
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&[#\w]+;/g, (m) => ENTITIES[m] ?? m)
}

export type Segment = { text: string; color?: RGBA }
export type HighlightedLine = Segment[]

function resolveColor(classStr: string, theme: Theme): RGBA | undefined {
  const key = SCOPE_COLORS[classStr]
  if (key) return theme[key] as RGBA
  const first = classStr.split(" ")[0]!
  return first ? (SCOPE_COLORS[first] ? theme[SCOPE_COLORS[first]] as RGBA : undefined) : undefined
}

/**
 * Parse highlight.js HTML into per-line segment arrays.
 * Tracks color state across line breaks so multi-line tokens
 * (comments, template strings) stay colored.
 */
function parseToLines(html: string, theme: Theme): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]]
  const colorStack: (RGBA | undefined)[] = []
  let pos = 0

  while (pos < html.length) {
    if (html.charCodeAt(pos) === 60) {
      if (html.startsWith("</span>", pos)) {
        colorStack.pop()
        pos += 7
        continue
      }
      const match = /^<span class="([^"]*?)">/.exec(html.slice(pos))
      if (match) {
        colorStack.push(resolveColor(match[1]!, theme))
        pos += match[0].length
        continue
      }
    }

    const next = html.indexOf("<", pos)
    const raw = next === -1 ? html.slice(pos) : html.slice(pos, next)
    if (raw) {
      const text = decodeEntities(raw)
      const color = colorStack.findLast((c) => c != null)
      for (const [i, part] of text.split("\n").entries()) {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1]!.push(color ? { text: part, color } : { text: part })
      }
    }
    pos = next === -1 ? html.length : next
  }

  return lines
}

function resolveLang(filetype: string | undefined): string | undefined {
  if (!filetype) return undefined
  const lang = LANG_ALIASES[filetype] ?? filetype
  return hljs.getLanguage(lang) ? lang : undefined
}

function toPlainLines(code: string): HighlightedLine[] {
  return code.split("\n").map((line) => [{ text: line }])
}

export function highlightCode(code: string, filetype: string | undefined, theme: Theme): HighlightedLine[] {
  const lang = resolveLang(filetype)
  if (!lang) return toPlainLines(code)
  try {
    return parseToLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, theme)
  } catch {
    return toPlainLines(code)
  }
}

/**
 * Streaming-aware highlighter. Caches the previous result so identical
 * content returns the same array reference (SolidJS <For> skips
 * re-rendering). During streaming, each content change triggers a full
 * re-highlight — correct for multi-line tokens, fast at our 200-line cap.
 */
export function createHighlighter(theme: Theme): (code: string, filetype: string | undefined) => HighlightedLine[] {
  let prevCode: string | undefined
  let prevFiletype: string | undefined
  let prevResult: HighlightedLine[] = []

  return (code, filetype) => {
    if (code === prevCode && filetype === prevFiletype) return prevResult
    prevCode = code
    prevFiletype = filetype
    prevResult = highlightCode(code, filetype, theme)
    return prevResult
  }
}
