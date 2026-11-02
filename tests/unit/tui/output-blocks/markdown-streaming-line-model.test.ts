import { describe, expect, it } from "bun:test"
import { plainOf } from "../../../../src/tui/output-blocks/markdown/format-token.js"
import type { MarkdownStyles, StyleSpec } from "../../../../src/tui/output-blocks/markdown/markdown-styles.js"
import { renderToLineModel, TEXT_SEGMENT_LINES, type MarkdownSegment } from "../../../../src/tui/output-blocks/markdown/line-model.js"
import { assistantDisplayContent } from "../../../../src/tui/output-blocks/text-block.js"

const style: StyleSpec = { attr: 0 }
const styles: MarkdownStyles = {
  h1: style, h2: style, h3: style, h4: style, h5: style, h6: style,
  strong: style, emphasis: style, code: style, codeBlock: style,
  link: style, listMarker: style, blockquoteBody: style, blockquoteBar: style,
  horizontalRule: style, image: style,
}

/** Flatten a segment model to plain text lines. Blank segments are source-authored spacer rows. */
function modelToPlainLines(model: MarkdownSegment[]): string[] {
  const out: string[] = []
  for (let i = 0; i < model.length; i++) {
    const seg = model[i]!
    switch (seg.kind) {
      case "text":
        for (const line of seg.lines) out.push(plainOf(line))
        break
      case "blank":
        out.push("")
        break
      case "code": {
        const lines = seg.text.split("\n")
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
        for (const line of lines) out.push(line)
        break
      }
      case "table": {
        const header = seg.token.header.map((c) => c.text).join(" | ")
        out.push(header)
        for (const row of seg.token.rows) out.push(row.map((c) => c.text).join(" | "))
        break
      }
      case "blockquote": {
        const lines = seg.token.text.split("\n")
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
        for (const line of lines) out.push(line)
        break
      }
      default: {
        const exhaustive: never = seg
        throw new Error(`Unhandled segment kind: ${String(exhaustive)}`)
      }
    }
  }
  return out
}

function fullPlain(source: string): string[] {
  return modelToPlainLines(renderToLineModel(source, styles))
}

describe("renderToLineModel source spacing", () => {
  it("shows internal blank lines but no trailing rows for assistant progress", () => {
    const source = "First paragraph.\n\nSecond paragraph.\n\n"
    expect(fullPlain(assistantDisplayContent(source))).toEqual(["First paragraph.", "", "Second paragraph."])
  })

  it("preserves 3+ blank lines between paragraphs", () => {
    expect(fullPlain("a\n\n\n\nb")).toEqual(["a", "", "", "", "b"])
  })

  it("preserves leading and trailing blank lines of the message", () => {
    expect(fullPlain("\n\nonly\n\n")).toEqual(["", "", "only", "", ""])
  })

  it("preserves source spacing around a code breakout", () => {
    const lines = fullPlain("Before.\n\n```ts\nconst x = 1\n```\n\nAfter.")
    expect(lines).toEqual(["Before.", "", "const x = 1", "", "After."])
  })

  it("renders a tight list without adding blank lines between items", () => {
    expect(fullPlain("- a\n- b\n- c")).toEqual(["- a", "- b", "- c"])
  })

  it("renders HTML-like angle-bracket text literally", () => {
    // marked's html/tag tokenizers are disabled in configureMarkdownLexer; <pipeline>
    // must survive as literal text.
    expect(fullPlain("**Deploy <pipeline> now**")).toEqual(["Deploy <pipeline> now"])
    expect(fullPlain("`x` <pipeline>_<subtype>_changelog")).toEqual(["x <pipeline>_<subtype>_changelog"])
  })

  it("preserves one blank line between loose list items", () => {
    expect(fullPlain("1. alpha\n\n2. beta\n\n3. gamma")).toEqual(["1. alpha", "", "2. beta", "", "3. gamma"])
  })

  it("preserves one blank line before later multi-paragraph ordered list items", () => {
    const lines = fullPlain("1. **One.**\n\n   body one.\n\n2. **Two.**\n\n   body two.")
    expect(lines).toEqual(["1. One.", "", "body one.", "", "2. Two.", "", "body two."])
  })

  it("keeps a list that interrupts a paragraph on its own line", () => {
    // Shift+enter produces a single newline; the interrupting list has no
    // `space` token, so the fold must own the line break.
    const lines = fullPlain("a couple questions:\n1. why\n2. that\n3. the rail")
    expect(lines).toEqual(["a couple questions:", "1. why", "2. that", "3. the rail"])
  })

  it("does not double the line break between adjacent lists of different type", () => {
    // list_item already emits its trailing newline; the fold's separator must
    // not stack a second one on top.
    expect(fullPlain("- a\n1. b")).toEqual(["- a", "1. b"])
  })
})

describe("renderToLineModel segmentation", () => {
  it("emits code as its own breakout segment, prose as text segments", () => {
    const model = renderToLineModel("Para.\n\n```\ncode\n```\n\nDone.", styles)
    expect(model.map((s) => s.kind)).toEqual(["text", "blank", "code", "blank", "text"])
  })

  it("emits blockquotes between paragraphs with source-authored spacing", () => {
    const model = renderToLineModel("Para one.\n\n> quoted\n\nPara two.", styles)
    expect(model.map((s) => s.kind)).toEqual(["text", "blank", "blockquote", "blank", "text"])
    expect(modelToPlainLines(model)).toEqual(["Para one.", "", "quoted", "", "Para two."])
  })

  it("bounds text segments at every top-level blank line (one segment per paragraph)", () => {
    // Render #1's fix: narration must never accumulate into one since-last-
    // breakout segment, or every streaming flush rebuilds the whole run.
    const model = renderToLineModel("Para one.\n\nPara two.\n\n\nPara three.", styles)
    expect(model.map((s) => s.kind)).toEqual(["text", "blank", "text", "blank", "blank", "text"])
    expect(modelToPlainLines(model)).toEqual(["Para one.", "", "Para two.", "", "", "Para three."])
  })

  it("bounds a long paragraph to text segments of TEXT_SEGMENT_LINES lines split at hard line breaks", () => {
    // Each text segment is one renderable, and its update cost grows with its
    // line count, so no segment may hold an unbounded paragraph.
    const lines = Array.from({ length: TEXT_SEGMENT_LINES * 2 + 5 }, (_, i) => `line ${i}`)
    const model = renderToLineModel(lines.join("\n"), styles)
    expect(model.map((s) => s.kind === "text" ? s.lines.length : s.kind)).toEqual([TEXT_SEGMENT_LINES, TEXT_SEGMENT_LINES, 5])
    expect(modelToPlainLines(model)).toEqual(lines)
  })

  it("appends no phantom blanks after a message-ending code block", () => {
    // Regression: pushTrailingBreakoutNewlines counted every newline in the
    // code token's raw, so a message ending in an N-line fence gained ~N
    // blank rows below it.
    const model = renderToLineModel("Prompt:\n\n```\nline one\nline two\nline three\n```", styles)
    expect(model.map((s) => s.kind)).toEqual(["text", "blank", "code"])
    const closed = renderToLineModel("Prompt:\n\n```\nline one\nline two\n```\n", styles)
    expect(closed.map((s) => s.kind)).toEqual(["text", "blank", "code"])
  })

  it("preserves a source-authored trailing blank line after a message-ending table", () => {
    // marked folds a table's trailing blank line into the token raw.
    const model = renderToLineModel("| A |\n|---|\n| 1 |\n\n", styles)
    expect(model.map((s) => s.kind)).toEqual(["table", "blank"])
  })

  it("emits no external blanks for an unclosed streaming fence ending in blank lines", () => {
    // While a fence is still open, marked keeps trailing newlines in both raw
    // and text; the blanks already render inside the code block, so the fold
    // must not append them again as external blank segments.
    const model = renderToLineModel("```\na\n\n\n", styles)
    expect(model.map((s) => s.kind)).toEqual(["code"])
    expect(model[0]?.kind === "code" ? model[0].text : null).toBe("a\n\n")
  })
})
