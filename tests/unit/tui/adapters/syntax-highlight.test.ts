import { describe, it, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  createHighlighter,
  chatSyntaxColors,
  MAX_HIGHLIGHT_BYTES,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LENGTH,
  type SyntaxColors,
} from "@tui/adapters/syntax-highlight.js"
import { resolveTheme, type TuiTheme } from "@tui/context/theme/resolve.js"
import flywheelTheme from "@tui/context/theme/flywheel.json" with { type: "json" }

const mockTheme: TuiTheme = {
  ...resolveTheme(flywheelTheme, "dark"),
  text: RGBA.fromHex("#cccccc"),
  chatCodeKeyword: RGBA.fromHex("#c678dd"),
  chatCodeType: RGBA.fromHex("#e5c07b"),
  chatCodeNumber: RGBA.fromHex("#d19a66"),
  chatCodeString: RGBA.fromHex("#98c379"),
  chatCodeComment: RGBA.fromHex("#5c6370"),
  chatCodeFunction: RGBA.fromHex("#61afef"),
  chatCodeVariable: RGBA.fromHex("#e06c75"),
  chatCodeOperator: RGBA.fromHex("#56b6c2"),
  chatCodePunctuation: RGBA.fromHex("#abb2bf"),
}

const writeColors = {
  text: RGBA.fromHex("#010101"),
  comment: RGBA.fromHex("#020202"),
  keyword: RGBA.fromHex("#030303"),
  function: RGBA.fromHex("#040404"),
  variable: RGBA.fromHex("#050505"),
  string: RGBA.fromHex("#060606"),
  number: RGBA.fromHex("#070707"),
  type: RGBA.fromHex("#080808"),
  operator: RGBA.fromHex("#090909"),
  punctuation: RGBA.fromHex("#0a0a0a"),
} satisfies SyntaxColors

// createHighlighter caches results; create fresh instances per call to avoid stale cache.
function highlightCode(code: string, filetype: string | undefined) {
  return createHighlighter(chatSyntaxColors(mockTheme))(code, filetype)
}

function hasColoredSegment(code: string, filetype: string | undefined): boolean {
  return highlightCode(code, filetype).some((line) =>
    line.some((segment) => segment.color !== undefined),
  )
}

function renderedLines(code: string, filetype: string | undefined): string[] {
  return highlightCode(code, filetype).map((line) =>
    line.map((segment) => segment.text).join(""),
  )
}

function renderedText(code: string, filetype: string | undefined): string {
  return renderedLines(code, filetype).join("\n")
}

function highlightedSegments(code: string, filetype: string | undefined) {
  return highlightCode(code, filetype).map((line) =>
    line.map((segment) => ({ text: segment.text, colored: segment.color !== undefined })),
  )
}

function expectPlainSegments(code: string, filetype: string | undefined) {
  const result = highlightCode(code, filetype)
  expect(result.every((line) => line.every((segment) => segment.color === undefined))).toBe(true)
  return result
}

describe("highlightCode", () => {
  it("highlights curated addon languages", () => {
    const cases = [
      { filetype: "dockerfile", code: "FROM bun:1\nRUN echo hi" },
      { filetype: "powershell", code: "function Test { $value = 1 }" },
      { filetype: "protobuf", code: 'syntax = "proto3";\nmessage Example {}' },
      { filetype: "nix", code: "let x = 1; in x" },
      { filetype: "dart", code: "class Greeter {}" },
      { filetype: "elixir", code: "defmodule Example do\nend" },
      { filetype: "erlang", code: "case Value of ok -> ok end." },
      { filetype: "scala", code: "object Main extends App" },
      { filetype: "clojure", code: "(def x 1)" },
      { filetype: "groovy", code: "class Example {}" },
      { filetype: "ocaml", code: "let x = 1" },
      { filetype: "latex", code: "\\begin{document}" },
    ]

    for (const { code, filetype } of cases) {
      expect(hasColoredSegment(code, filetype)).toBe(true)
    }
  })

  it("resolves extended aliases case-insensitively", () => {
    const cases = [
      { filetype: "Dockerfile", code: "FROM bun:1" },
      { filetype: "Containerfile", code: "FROM bun:1" },
      { filetype: "PS1", code: "function Test { $value = 1 }" },
      { filetype: "PROTO", code: 'syntax = "proto3";' },
      { filetype: "EXS", code: "defmodule Example do\nend" },
      { filetype: "ERL", code: "case Value of ok -> ok end." },
      { filetype: "CLJS", code: "(def x 1)" },
      { filetype: "GRADLE", code: "class Example {}" },
      { filetype: "MLI", code: "let x = 1" },
      { filetype: "TEX", code: "\\begin{document}" },
      { filetype: "VUE", code: "const value = 1" },
      { filetype: "Svelte", code: "const value = 1" },
      { filetype: "tsx", code: "const x = 1" },
      { filetype: "jsx", code: "const x = 1" },
      { filetype: "zsh", code: "echo hi" },
      { filetype: "ps", code: "function Test { $value = 1 }" },
    ]

    for (const { code, filetype } of cases) {
      expect(hasColoredSegment(code, filetype)).toBe(true)
    }
  })

  it("uses the first fenced-code info token for language lookup", () => {
    const cases = [
      "typescript title=demo",
      "typescript,no_run",
      "typescript\tignore",
    ]

    for (const filetype of cases) {
      expect(hasColoredSegment("const x = 1", filetype)).toBe(true)
    }
  })

  it("resolves editor language aliases without breaking existing aliases", () => {
    const cases = [
      { filetype: "shell", code: "echo $HOME" },
      { filetype: "python3", code: "def run():\n    return 1" },
      { filetype: "golang", code: "package main\nfunc main() {}" },
      { filetype: "csharp", code: "class Example { static void Main() {} }" },
      { filetype: "c-sharp", code: "class Example { static void Main() {} }" },
      { filetype: "tsx", code: "const x = 1" },
      { filetype: "jsx", code: "const x = 1" },
      { filetype: "zsh", code: "echo $HOME" },
      { filetype: "ps", code: "function Test { $value = 1 }" },
      { filetype: "proto", code: 'syntax = "proto3";' },
    ]

    for (const { code, filetype } of cases) {
      expect(hasColoredSegment(code, filetype)).toBe(true)
    }
  })

  it("normalizes CRLF and terminal newlines before highlighting", () => {
    expect(renderedLines("const x = 1\r\nconst y = 2\r\n", "typescript")).toEqual([
      "const x = 1",
      "const y = 2",
    ])
    expect(renderedText("const x = 1\r\nconst y = 2\r\n", "typescript")).not.toContain("\r")
  })

  it("does not add a phantom rendered line for a terminal newline", () => {
    expect(renderedLines("const x = 1\n", "typescript")).toEqual(["const x = 1"])
    expect(renderedLines("hello\n", "unknown-language")).toEqual(["hello"])
  })

  it("falls back to plain text for unknown languages", () => {
    const result = highlightCode("hello world", "obscurelang")
    expect(result).toHaveLength(1)
    expect(result[0]![0]!.color).toBeUndefined()
  })

  it("preserves unknown-language content through the normalized plain fallback", () => {
    expectPlainSegments("alpha\r\nbeta\r\n", "obscurelang")
    expect(renderedLines("alpha\r\nbeta\r\n", "obscurelang")).toEqual(["alpha", "beta"])
  })

  it("preserves oversized content through the normalized plain fallback", () => {
    const oversized = `const x = 1\r\n${"a".repeat(MAX_HIGHLIGHT_BYTES)}`

    expectPlainSegments(oversized, "typescript")
    expect(renderedLines(oversized, "typescript")).toEqual([
      "const x = 1",
      "a".repeat(MAX_HIGHLIGHT_BYTES),
    ])
    expect(renderedText(oversized, "typescript")).not.toContain("\r")
  })

  it("does not add a phantom rendered line in guardrail fallback", () => {
    const oversized = `${"a".repeat(MAX_HIGHLIGHT_BYTES + 1)}\n`

    expectPlainSegments(oversized, "typescript")
    expect(renderedLines(oversized, "typescript")).toEqual(["a".repeat(MAX_HIGHLIGHT_BYTES + 1)])
  })

  it("falls back when input exceeds the line guardrail without a final newline", () => {
    const tooManyLines = Array.from(
      { length: MAX_HIGHLIGHT_LINES + 1 },
      (_, i) => `const x${i} = 1`,
    ).join("\n")

    expectPlainSegments(tooManyLines, "typescript")
    expect(renderedLines(tooManyLines, "typescript")).toHaveLength(MAX_HIGHLIGHT_LINES + 1)
  })

  it("falls back when one line exceeds the line-length guardrail", () => {
    const declaration = (length: number) => `const ${"x".repeat(length - "const  = 1".length)} = 1`
    const atLimit = declaration(MAX_HIGHLIGHT_LINE_LENGTH)
    const overLimit = declaration(MAX_HIGHLIGHT_LINE_LENGTH + 1)

    expect(hasColoredSegment(`${atLimit}\nconst y = 2`, "typescript")).toBe(true)
    for (const code of [`${overLimit}\nconst y = 2`, `const y = 2\n${overLimit}`]) {
      expectPlainSegments(code, "typescript")
      expect(renderedText(code, "typescript")).toBe(code)
    }
  })

  it("handles empty content", () => {
    expect(renderedLines("", "typescript")).toEqual([""])
    expect(renderedLines("", "obscurelang")).toEqual([""])
  })

  it("colors multi-line tokens across line breaks", () => {
    const lines = highlightCode("/* comment\n   continues */\nconst x = 1", "typescript")
    expect(lines).toHaveLength(3)
    expect(lines[1]![0]!.color).toBeDefined()
  })

  it("decodes HTML entities", () => {
    const lines = highlightCode('const x = "<div>"', "typescript")
    const allText = lines[0]!.map((s) => s.text).join("")
    expect(allText).toContain("<div>")
  })
})

describe("createHighlighter", () => {
  it("uses only renderer-owned syntax roles", () => {
    const highlighted = createHighlighter(writeColors)("const answer: number = 42", "typescript").flat()

    expect(highlighted.find((segment) => segment.text === "const")?.color).toEqual(writeColors.keyword)
    expect(highlighted.find((segment) => segment.text === "number")?.color).toEqual(writeColors.type)
    expect(highlighted.find((segment) => segment.text === "42")?.color).toEqual(writeColors.number)
  })

  it("colors plain and unknown-language segments with the palette text role", () => {
    expect(createHighlighter(writeColors, true)("plain", undefined)).toEqual([
      [{ text: "plain", color: writeColors.text }],
    ])
  })

  it("colors unscoped segments in a known language with the palette text role", () => {
    const highlighted = createHighlighter(writeColors, true)("const answer = 42", "typescript").flat()

    expect(highlighted.find((segment) => segment.text.includes("answer"))?.color).toEqual(writeColors.text)
  })

  it("colors unscoped segments after a streaming append with the palette text role", () => {
    const highlight = createHighlighter(writeColors, true)
    highlight("const answer = 42\nconst", "typescript")

    const appended = highlight("const answer = 42\nconst result = answer", "typescript").flat()
    expect(appended.filter((segment) => /answer|result/.test(segment.text)).every((segment) => segment.color?.toString() === writeColors.text.toString())).toBe(true)
  })

  it("returns same reference for identical content", () => {
    const hl = createHighlighter(chatSyntaxColors(mockTheme))
    const a = hl("const x = 1", "typescript")
    const b = hl("const x = 1", "typescript")
    expect(a).toBe(b)
  })

  it("invalidates cache when filetype changes", () => {
    const hl = createHighlighter(chatSyntaxColors(mockTheme))
    const a = hl("print('hi')", "python")
    const b = hl("print('hi')", "typescript")
    expect(a).not.toBe(b)
  })

  it("reuses cache entries after code and language normalization", () => {
    const hl = createHighlighter(chatSyntaxColors(mockTheme))
    const a = hl("const x = 1\r\n", "typescript title=demo")
    const b = hl("const x = 1\n", "typescript,no_run")
    expect(b).toBe(a)
  })

  it("matches full-highlight output after normalized streaming appends", () => {
    const streaming = createHighlighter(chatSyntaxColors(mockTheme))
    streaming("const x = 1\r\nconst", "typescript title=demo")

    const incremental = streaming("const x = 1\r\nconst y = 2", "typescript,no_run")
    const full = highlightedSegments("const x = 1\nconst y = 2", "typescript")

    expect(
      incremental.map((line) =>
        line.map((segment) => ({ text: segment.text, colored: segment.color !== undefined })),
      ),
    ).toEqual(full)
  })
})
