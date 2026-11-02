import { RGBA } from "@opentui/core"
import { describe, expect, it, spyOn } from "bun:test"
import { marked } from "marked"
import { configureMarkdownLexer, plainOf } from "../../../../src/tui/output-blocks/markdown/format-token.js"
import { foldTokensToSegments, lexMarkdown, renderToLineModel, TEXT_SEGMENT_LINES, type MarkdownSegment } from "../../../../src/tui/output-blocks/markdown/line-model.js"
import { createStreamingSegments } from "../../../../src/tui/output-blocks/markdown/streaming-line-model.js"
import { assistantDisplayContent } from "../../../../src/tui/output-blocks/text-block.js"
import type { MarkdownStyles, StyleSpec } from "../../../../src/tui/output-blocks/markdown/markdown-styles.js"
import { BOLD, ITALIC, UNDERLINE } from "../../../../src/tui/utils/text-attributes.js"

const style: StyleSpec = { attr: 0 }
const linkColor = RGBA.fromInts(30, 140, 220, 255)
const styles: MarkdownStyles = {
  h1: style, h2: style, h3: style, h4: style, h5: style, h6: style,
  strong: style, emphasis: { attr: ITALIC }, code: style, codeBlock: style,
  link: { attr: UNDERLINE, fg: linkColor }, listMarker: style, blockquoteBody: style, blockquoteBar: style,
  horizontalRule: style, image: style,
}

/** Strip the volatile-tail streaming flag: it is render-mode metadata for the
 *  live <code> renderable, not content, so equivalence compares without it. */
function settled(segments: readonly MarkdownSegment[]): MarkdownSegment[] {
  return segments.map((seg) => {
    if (seg.kind !== "code" || seg.streaming !== true) return seg
    const { streaming: _streaming, ...rest } = seg
    return rest
  })
}

/** Stream `source` in fixed-size chunks and assert the incremental segments
 *  equal a full re-lex at every prefix (the property full re-lexing had). */
function assertIncrementalMatchesFull(source: string, chunkSize: number, unwrapFences = false, using: MarkdownStyles = styles): void {
  const streaming = createStreamingSegments()
  for (let end = chunkSize; end < source.length + chunkSize; end += chunkSize) {
    const prefix = source.slice(0, Math.min(end, source.length))
    const incremental = streaming(prefix, using, unwrapFences)
    const full = renderToLineModel(prefix, using, unwrapFences)
    expect(settled(incremental)).toEqual(full)
  }
}

const PROSE = [
  "# Heading one",
  "",
  "First paragraph with **bold**, _emphasis_, `codespan`, and a [link](https://example.com).",
  "",
  "Second paragraph continues the narration with enough text to span multiple flushes when chunked small.",
  "",
  "- tight item one",
  "- tight item two",
  "- tight item three",
  "",
  "1. loose item alpha",
  "",
  "2. loose item beta",
  "",
  "Third paragraph before a fence.",
  "",
  "```ts",
  "const x = 1",
  "function f() {",
  "  return x + 1",
  "}",
  "```",
  "",
  "Paragraph after the fence.",
  "",
  "| A | B |",
  "|---|---|",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "> a blockquote line",
  "> continues here",
  "",
  "Setext candidate",
  "---",
  "",
  "Final paragraph after a setext heading and a blank line.",
].join("\n")

describe("createStreamingSegments", () => {
  it("keeps assistant progress compact as streaming text grows past trailing newlines", () => {
    const streaming = createStreamingSegments()
    for (const source of ["First paragraph.\n", "First paragraph.\n\n", "First paragraph.\n\nSecond paragraph.\n\n"]) {
      const display = assistantDisplayContent(source)
      expect(settled(streaming(display, styles))).toEqual(renderToLineModel(display, styles))
    }
    expect(settled(streaming(assistantDisplayContent("First paragraph.\n\nSecond paragraph.\n\n"), styles)))
      .toEqual(renderToLineModel("First paragraph.\n\nSecond paragraph.", styles))
  })

  it("matches full re-lex at every prefix for mixed markdown (small chunks)", () => {
    assertIncrementalMatchesFull(PROSE, 3)
  })

  it("flags a volatile code segment as streaming and settles it after commit", () => {
    const streaming = createStreamingSegments()
    // Open fence at the live edge: the code segment must carry the streaming
    // flag so the renderer drives one live incremental renderable.
    const open = streaming("Intro.\n\n```ts\nconst a = 1\nconst b = 2", styles)
    const openSegment = open.find((seg) => seg.kind === "code")
    if (openSegment?.kind !== "code") throw new Error("expected an open code segment")
    expect(openSegment.streaming).toBe(true)

    // Close the fence and stream enough trailing paragraphs to commit it past
    // the guard band: the settled segment must NOT carry the flag.
    const closed = streaming("Intro.\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nAfter one.\n\nAfter two.\n\nAfter three.\n\nAfter four.", styles)
    const closedCode = closed.find((seg) => seg.kind === "code")
    if (closedCode?.kind !== "code") throw new Error("expected the committed code segment")
    expect(closedCode.streaming).toBeUndefined()
  })

  it("handles a fence whose body contains blank lines", () => {
    const source = "Before.\n\n```\nfirst\n\nsecond\n\n\nthird\n```\n\nAfter the gappy fence."
    assertIncrementalMatchesFull(source, 5)
  })

  it("handles loose list continuations that reach past blank lines", () => {
    const source = "Para.\n\n1. **One.**\n\n   body one.\n\n2. **Two.**\n\n   body two.\n\nDone."
    assertIncrementalMatchesFull(source, 4)
  })

  it("handles setext headings forming late", () => {
    const source = "Para one.\n\nPara two.\n\nBecomes a heading\n===\n\nPara three.\n\nPara four to push the commit point."
    assertIncrementalMatchesFull(source, 6)
  })

  it("matches full re-lex with fence unwrapping enabled", () => {
    const source = "Intro.\n\n```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n\nOutro paragraph."
    assertIncrementalMatchesFull(source, 9, true)
  })

  it("falls back to a full re-lex on non-append updates", () => {
    const streaming = createStreamingSegments()
    streaming(PROSE, styles)
    const replaced = "Entirely different content.\n\nWith two paragraphs."
    expect(streaming(replaced, styles)).toEqual(renderToLineModel(replaced, styles))
  })

  it("resets committed state when styles change", () => {
    const streaming = createStreamingSegments()
    streaming(PROSE, styles)
    const otherStyles: MarkdownStyles = { ...styles }
    expect(streaming(PROSE, otherStyles)).toEqual(renderToLineModel(PROSE, otherStyles))
  })

  it("keeps committed paragraph segments identity-stable across later flushes", () => {
    // The render-freeze class (render #1): a growing tail must not rebuild
    // committed segments. Solid's <For> reuses rows by object identity, so
    // identity stability here is exactly "no re-render of settled paragraphs".
    const streaming = createStreamingSegments()
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} with enough words to look real.`)
    const source = paragraphs.join("\n\n")
    let prev = streaming(source.slice(0, Math.floor(source.length / 2)), styles)
    for (let end = Math.floor(source.length / 2) + 7; end < source.length + 7; end += 7) {
      const next = streaming(source.slice(0, Math.min(end, source.length)), styles)
      // Every segment of the previous flush except the volatile suffix must be
      // the SAME object in the next flush. The volatile region is the guard
      // band (two trailing blocks) plus the open paragraph; four segments
      // (two paragraphs + their leading blanks) is a safe upper bound.
      const stablePrefix = Math.max(0, prev.length - 5)
      for (let i = 0; i < stablePrefix; i++) expect(next[i]).toBe(prev[i]!)
      prev = next
    }
    expect(prev).toEqual(renderToLineModel(source, styles))
  })

  it("matches full re-lex at every prefix while one paragraph grows past several text segments", () => {
    // No blank line ever arrives, so only line cuts can advance the prefix. A
    // heading directly above shifts the segment boundaries inside the run.
    const lines = Array.from({ length: TEXT_SEGMENT_LINES * 3 }, (_, i) => `Line ${i} has **bold ${i}**, \`code\`, and [a link](https://example.com/${i}).`)
    assertIncrementalMatchesFull(`## Heading above\n${lines.join("\n")}`, 41)
  })

  it("refuses a line cut that an inline span crosses, and checks each refused cut once", () => {
    // The span opens on the last line before the first segment boundary and
    // closes on the line after it, so both ends are present when that cut is
    // first checked.
    const lines = Array.from({ length: TEXT_SEGMENT_LINES * 3 }, (_, i) => i === TEXT_SEGMENT_LINES - 1 ? "an **opened" : i === TEXT_SEGMENT_LINES ? "span** closed" : `plain line ${i}`)
    const source = lines.join("\n")
    assertIncrementalMatchesFull(source, 23)
    // Work count: one tail lex per delta, plus at most two lexes for each
    // checked segment boundary. Rechecking the refused boundary on every
    // later delta would add two lexes per delta.
    const lexer = spyOn(marked, "lexer")
    try {
      const streaming = createStreamingSegments()
      let deltas = 0
      for (let end = 23; end < source.length + 23; end += 23) {
        streaming(source.slice(0, Math.min(end, source.length)), styles)
        deltas += 1
      }
      expect(lexer.mock.calls.length).toBeLessThanOrEqual(deltas + 2 * 2)
    } finally {
      lexer.mockRestore()
    }
  })

  it.each([
    ["strong", "an **opened", "span** closed"],
    ["emphasis", "an _opened", "span_ closed"],
    ["code", "an `opened", "span` closed"],
    ["link", "an [opened", "span](https://example.com) closed"],
  ])("matches full re-lex at every prefix when a %s span closes well after a segment boundary", (_name, opener, closer) => {
    // The closer arrives after the boundary's cut is first checked, so only
    // the unpaired opener can keep the cut from committing a stale style.
    const lines = Array.from({ length: TEXT_SEGMENT_LINES * 2 + 8 }, (_, i) => i === TEXT_SEGMENT_LINES - 1 ? opener : i === TEXT_SEGMENT_LINES + 12 ? closer : `plain line ${i}`)
    assertIncrementalMatchesFull(lines.join("\n"), 19)
  })

  it.each(["---", "==="])("matches full re-lex at every prefix when a %s setext underline ends a paragraph that line cuts split", (underline) => {
    // The underline turns the whole paragraph into a heading, reaching back
    // across every line cut already taken inside it. Headings carry their own
    // attribute here so that a partly restyled paragraph shows.
    const lines = Array.from({ length: TEXT_SEGMENT_LINES * 2 + 12 }, (_, i) => `plain line ${i}`)
    assertIncrementalMatchesFull(`${lines.join("\n")}\n${underline}\n\nAfter the heading.`, 13, false, { ...styles, h1: { attr: BOLD }, h2: { attr: BOLD } })
  })

  it("lexes a bounded tail per delta while one paragraph grows without blank lines", () => {
    // Hot-path work count: each delta appends one line to a single paragraph.
    // The characters lexed per delta must not grow with the reply.
    const lexer = spyOn(marked, "lexer")
    try {
      const streaming = createStreamingSegments()
      const lexedPerDelta: number[] = []
      let source = ""
      let lexed = 0
      for (let i = 0; i < TEXT_SEGMENT_LINES * 10; i++) {
        source += `${i === 0 ? "" : "\n"}[tick ${String(i).padStart(4, "0")}] relay throughput text line.`
        streaming(source, styles)
        const total = lexer.mock.calls.reduce((sum, [input]) => sum + input.length, 0)
        lexedPerDelta.push(total - lexed)
        lexed = total
      }
      const early = Math.max(...lexedPerDelta.slice(TEXT_SEGMENT_LINES * 2, TEXT_SEGMENT_LINES * 4))
      const late = Math.max(...lexedPerDelta.slice(TEXT_SEGMENT_LINES * 8))
      expect(late).toBeLessThanOrEqual(early)
      expect(streaming(source, styles)).toEqual(renderToLineModel(source, styles))
    } finally {
      lexer.mockRestore()
    }
  })

  it("is stable when the same source is rendered twice", () => {
    const streaming = createStreamingSegments()
    streaming(PROSE, styles)
    expect(streaming(PROSE, styles)).toEqual(renderToLineModel(PROSE, styles))
  })
})

const LONG_PLAIN_PREFIX = "Plain narration ".repeat(48).trimEnd()

describe.each(["streamed", "settled"] as const)("Markdown after a long plain prefix (%s)", (mode) => {
  function renderLateMarkdown(suffix: string): MarkdownSegment[] {
    const source = LONG_PLAIN_PREFIX + suffix
    const render = mode === "streamed"
      ? createStreamingSegments()
      : (content: string, theme: MarkdownStyles) => renderToLineModel(content, theme, false, true)
    const chunkSize = mode === "streamed" ? 17 : source.length
    let model: MarkdownSegment[] = []
    configureMarkdownLexer()
    for (let end = chunkSize; end < source.length + chunkSize; end += chunkSize) {
      const prefix = source.slice(0, end)
      model = render(prefix, styles)
      // Both public render paths share lexMarkdown, so neither is the oracle.
      expect(settled(model)).toEqual(foldTokensToSegments(marked.lexer(prefix), styles))
    }
    return model
  }

  it("renders a late fence as a code segment with language and tail metadata", () => {
    const model = renderLateMarkdown("\n\n```ts\nconst answer = 42\n```")
    expect(model.map((segment) => segment.kind)).toEqual(["text", "blank", "code"])
    expect(model[2]).toEqual({
      kind: "code",
      lang: "ts",
      text: "const answer = 42",
      ...(mode === "streamed" ? { streaming: true } : {}),
    })
  })

  it("renders a late link with its target, color, and underline", () => {
    const model = renderLateMarkdown(" [late link](https://example.com/late)")
    const chunks = model.flatMap((segment) => segment.kind === "text" ? segment.lines.flat() : [])
    expect(plainOf(chunks)).toBe(`${LONG_PLAIN_PREFIX} late link`)
    expect(chunks.find((chunk) => chunk.link)).toMatchObject({
      text: "late link",
      link: { url: "https://example.com/late" },
      fg: linkColor,
      attributes: UNDERLINE,
    })
  })

  it("renders late emphasis with italic attributes and no delimiters", () => {
    const model = renderLateMarkdown(" *late emphasis*")
    const chunks = model.flatMap((segment) => segment.kind === "text" ? segment.lines.flat() : [])
    expect(plainOf(chunks)).toBe(`${LONG_PLAIN_PREFIX} late emphasis`)
    expect(plainOf(chunks.filter((chunk) => chunk.attributes === ITALIC))).toBe("late emphasis")
  })
})

it("reuses settled lexer tokens after a long plain prefix", () => {
  configureMarkdownLexer()
  const source = `${LONG_PLAIN_PREFIX}\n\n\`\`\`ts\nconst cached = 42\n\`\`\``
  const tokens = lexMarkdown(source, true)
  expect(tokens).toEqual(marked.lexer(source))
  expect(lexMarkdown(source, true)).toBe(tokens)
})
