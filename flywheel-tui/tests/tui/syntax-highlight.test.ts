import { describe, it, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import { createHighlighter } from "@tui/adapters/syntax-highlight.js"

const mockTheme = {
  text: RGBA.fromHex("#cccccc"),
  syntaxKeyword: RGBA.fromHex("#c678dd"),
  syntaxType: RGBA.fromHex("#e5c07b"),
  syntaxNumber: RGBA.fromHex("#d19a66"),
  syntaxString: RGBA.fromHex("#98c379"),
  syntaxComment: RGBA.fromHex("#5c6370"),
  syntaxFunction: RGBA.fromHex("#61afef"),
  syntaxVariable: RGBA.fromHex("#e06c75"),
  syntaxOperator: RGBA.fromHex("#56b6c2"),
  syntaxPunctuation: RGBA.fromHex("#abb2bf"),
} as any

// createHighlighter caches results — create fresh instances per call to avoid stale cache.
function highlightCode(code: string, filetype: string | undefined, _theme: typeof mockTheme) {
  return createHighlighter(mockTheme)(code, filetype)
}

function hasColoredSegment(code: string, filetype: string | undefined): boolean {
  return highlightCode(code, filetype, mockTheme).some((line) =>
    line.some((segment) => segment.color !== undefined),
  )
}

describe("highlightCode", () => {
  it("returns one line per source line", () => {
    const result = highlightCode("const x = 1\nconst y = 2", "typescript", mockTheme)
    expect(result).toHaveLength(2)
  })

  it("produces colored segments for known languages", () => {
    const [[first]] = highlightCode("const x = 1", "typescript", mockTheme)
    expect(first!.color).toBeDefined()
    expect(first!.text).toBe("const")
  })

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
    ]

    for (const { code, filetype } of cases) {
      expect(hasColoredSegment(code, filetype)).toBe(true)
    }
  })

  it("falls back to plain text for unknown languages", () => {
    const result = highlightCode("hello world", "obscurelang", mockTheme)
    expect(result).toHaveLength(1)
    expect(result[0]![0]!.color).toBeUndefined()
  })

  it("falls back to plain text when filetype is undefined", () => {
    const result = highlightCode("line1\nline2\nline3", undefined, mockTheme)
    expect(result).toHaveLength(3)
  })

  it("handles empty content", () => {
    expect(highlightCode("", "typescript", mockTheme)).toHaveLength(1)
  })

  it("colors multi-line tokens across line breaks", () => {
    const lines = highlightCode("/* comment\n   continues */\nconst x = 1", "typescript", mockTheme)
    expect(lines).toHaveLength(3)
    expect(lines[1]![0]!.color).toBeDefined()
  })

  it("decodes HTML entities", () => {
    const lines = highlightCode('const x = "<div>"', "typescript", mockTheme)
    const allText = lines[0]!.map((s) => s.text).join("")
    expect(allText).toContain("<div>")
  })
})

describe("createHighlighter", () => {
  it("returns same reference for identical content", () => {
    const hl = createHighlighter(mockTheme)
    const a = hl("const x = 1", "typescript")
    const b = hl("const x = 1", "typescript")
    expect(a).toBe(b)
  })

  it("returns new result when content changes", () => {
    const hl = createHighlighter(mockTheme)
    const a = hl("const x", "typescript")
    const b = hl("const x = 1", "typescript")
    expect(a).not.toBe(b)
  })

  it("tracks streaming growth", () => {
    const hl = createHighlighter(mockTheme)
    expect(hl("const", "typescript")).toHaveLength(1)
    expect(hl("const x = 1\nconst", "typescript")).toHaveLength(2)
    expect(hl("const x = 1\nconst y = 2\nconst z = 3", "typescript")).toHaveLength(3)
  })

  it("invalidates cache when filetype changes", () => {
    const hl = createHighlighter(mockTheme)
    const a = hl("print('hi')", "python")
    const b = hl("print('hi')", "typescript")
    expect(a).not.toBe(b)
  })
})