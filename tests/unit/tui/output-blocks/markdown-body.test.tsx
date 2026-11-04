/** @jsxImportSource @opentui/solid */
import { describe, expect, it, spyOn } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTextAttributes, TextBuffer, TextRenderable, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { ThemeProvider, useTheme } from "@tui/context/theme.js"
import { MarkdownBody } from "@tui/output-blocks/markdown/markdown-body.js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "@tui/output-blocks/block-frame.js"
import { markdownTextChunk } from "@tui/output-blocks/markdown/format-token.js"
import { TEXT_SEGMENT_LINES } from "@tui/output-blocks/markdown/line-model.js"
import { BOLD, ITALIC, UNDERLINE } from "@tui/utils/text-attributes.js"
import { consumeSelectedText, hasSelectedCells } from "@tui/utils/selection.js"

const DIM = createTextAttributes({ dim: true })

describe("MarkdownBody readable subdued styles", () => {
  it.each(["dark", "light"] as const)("updates rendered prose, role colors, and blockquotes in %s mode", async (mode) => {
    const [subdued, setSubdued] = createSignal(true)
    const [theme, publishTheme] = createSignal("flywheel")
    let context: ReturnType<typeof useTheme> | undefined
    function Harness() {
      context = useTheme()
      return <MarkdownBody dimColor={subdued()} inlineSuffix={[markdownTextChunk(" suffix", context.theme.warning, ITALIC)]}>
        {"# Heading\n\nPlain **bold** *italic* [link](https://example.com) `code`\n\n> quoted\n\nTail"}
      </MarkdownBody>
    }
    const result = await testRender(() => <ThemeProvider mode={mode} themeName={theme()}><Harness /></ThemeProvider>, { width: 70, height: 16 })
    const span = (text: string) => {
      const found = result.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(text))
      if (!found) throw new Error(`Missing Markdown span: ${text}`)
      return found
    }
    try {
      await result.renderOnce()
      if (!context) throw new Error("Missing theme")
      for (const [subtle, themeName] of [[true, "nord"], [true, "catppuccin"], [false, "catppuccin"]] as const) {
        publishTheme(themeName)
        setSubdued(subtle)
        await result.renderOnce()
        const palette = subtle ? context.subtleTheme : context.theme
        expect(span("Plain").fg.equals(palette.text)).toBe(true)
        expect(span("Heading").fg.equals(palette.markdownHeading)).toBe(true)
        expect(span("link").fg.equals(palette.markdownLink)).toBe(true)
        expect(span("code").fg.equals(palette.markdownCode)).toBe(true)
        expect(span("quoted").fg.equals(palette.text)).toBe(true)
        expect(span("bold").attributes & BOLD).toBe(BOLD)
        expect(span("italic").attributes & ITALIC).toBe(ITALIC)
        expect(span("link").attributes & UNDERLINE).toBe(UNDERLINE)
        expect(span("quoted").attributes & ITALIC).toBe(ITALIC)
        expect(span("suffix").fg.equals(context.theme.warning)).toBe(true)
        expect(result.captureSpans().lines.flatMap((line) => line.spans).every((item) => (item.attributes & DIM) === 0)).toBe(true)
        expect(result.captureCharFrame()).toContain("Tail suffix")
      }
    } finally { result.renderer.destroy() }
  })

  it("keeps a suffix after a breakout and nested quote markers free of terminal dimming", async () => {
    let context: ReturnType<typeof useTheme> | undefined
    function Harness() {
      context = useTheme()
      return <MarkdownBody dimColor inlineSuffix={[markdownTextChunk("suffix", context.theme.warning, ITALIC)]}>
        {"> outer\n>> nested"}
      </MarkdownBody>
    }
    const result = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 60, height: 8 })
    try {
      await result.renderOnce()
      if (!context) throw new Error("Missing theme")
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const suffix = spans.find((item) => item.text.includes("suffix"))
      expect(suffix?.fg.equals(context.theme.warning)).toBe(true)
      expect((suffix?.attributes ?? 0) & ITALIC).toBe(ITALIC)
      expect(spans.find((item) => item.text.includes("│"))?.fg.equals(context.subtleTheme.markdownBlockQuote)).toBe(true)
      expect(spans.every((item) => (item.attributes & DIM) === 0)).toBe(true)
      expect(result.captureCharFrame()).toContain("nested")
    } finally { result.renderer.destroy() }
  })

  it.each([70, 18])("renders table grid or cards with opaque subdued cell colors at width %s", async (width) => {
    const [content, setContent] = createSignal("| Label | Value |\n| --- | --- |\n| plain | `code` and [link](https://example.com) with many words filling the value across several more wrapped lines in this narrow table |")
    let context: ReturnType<typeof useTheme> | undefined
    function Harness() {
      context = useTheme()
      return <MarkdownBody dimColor>{content()}</MarkdownBody>
    }
    const result = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width, height: 30 })
    try {
      await result.renderOnce()
      await result.renderOnce()
      if (!context) throw new Error("Missing theme")
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      for (const [text, color] of [["plain", context.subtleTheme.text], ["code", context.subtleTheme.markdownCode], ["link", context.subtleTheme.markdownLink]] as const) {
        const found = spans.find((item) => item.text.includes(text))
        expect(found?.fg.equals(color)).toBe(true)
      }
      const label = spans.find((item) => item.text.includes("Label"))
      expect(label?.fg.equals(context.subtleTheme.text)).toBe(true)
      expect((label?.attributes ?? 0) & BOLD).toBe(BOLD)
      expect(spans.every((item) => (item.attributes & DIM) === 0)).toBe(true)
      expect(result.captureCharFrame()).toContain(width === 18 ? "Label:" : "┌")
      const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
      const cell = descendants(result.renderer.root).find(node => node instanceof TextRenderable && node.plainText.includes("plain"))
      if (!cell) throw new Error("Table cell did not render")
      setContent(content().replace("plain", "plain growth") + "\n| appended | next |")
      await result.renderOnce()
      await result.renderOnce()
      expect(descendants(result.renderer.root).includes(cell)).toBe(true)
      expect(result.captureCharFrame()).toContain("appended")
    } finally { result.renderer.destroy() }
  })
})

describe("MarkdownBody streaming cost", () => {
  it("sets a bounded amount of styled text per delta while one paragraph grows", async () => {
    // Hot-path work count: OpenTUI's styled-text update costs O(chunks x lines)
    // of the renderable it rewrites, so the text rewritten per delta must not
    // grow with the reply.
    const [content, setContent] = createSignal("")
    const result = await testRender(() => <ThemeProvider mode="dark"><MarkdownBody>{content()}</MarkdownBody></ThemeProvider>, { width: 80, height: 10 })
    const setStyledText = spyOn(TextBuffer.prototype, "setStyledText")
    try {
      const rewrittenPerDelta: number[] = []
      let source = ""
      for (let i = 0; i < TEXT_SEGMENT_LINES * 8; i++) {
        source += `${i === 0 ? "" : "\n"}[tick ${String(i).padStart(4, "0")}] relay throughput text line.`
        setStyledText.mockClear()
        setContent(source)
        rewrittenPerDelta.push(setStyledText.mock.calls.reduce((sum, [text]) => sum + text.chunks.reduce((length, chunk) => length + chunk.text.length, 0), 0))
      }
      const early = Math.max(...rewrittenPerDelta.slice(TEXT_SEGMENT_LINES * 2, TEXT_SEGMENT_LINES * 4))
      const late = Math.max(...rewrittenPerDelta.slice(TEXT_SEGMENT_LINES * 6))
      expect(late).toBeLessThanOrEqual(early)
      const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
      const rows = descendants(result.renderer.root).filter((node) => node instanceof TextRenderable)
      expect(rows.map((row) => row instanceof TextRenderable ? row.plainText : "").join("\n")).toBe(source)
    } finally {
      setStyledText.mockRestore()
      result.renderer.destroy()
    }
  })
})

describe("MarkdownBody copied text", () => {
  // A person drags from the first cell to the end of the last line and copies.
  // Each case asserts the screen rows and the copied string, so a fix that
  // changes copy must leave the rendered rows as they are.
  async function dragCopy(source: string, drag?: (rows: string[]) => [number, number, number, number]): Promise<{ rows: string[]; copied: string | null }> {
    const result = await testRender(() => <ThemeProvider mode="dark"><MarkdownBody>{source}</MarkdownBody></ThemeProvider>, { width: 60, height: 80 })
    try {
      // A table measures its columns on the first pass and lays out on the next.
      await result.renderOnce()
      await result.renderOnce()
      const frame = result.captureCharFrame().split("\n").map((row) => row.trimEnd())
      const rows = frame.slice(0, frame.findLastIndex((row) => row !== "") + 1)
      const [fromX, fromY, toX, toY] = drag?.(rows) ?? [0, 0, rows[rows.length - 1]?.length ?? 0, rows.length - 1]
      await result.mockMouse.drag(fromX, fromY, toX, toY)
      await result.renderOnce()
      return { rows, copied: consumeSelectedText(result.renderer) }
    } finally { result.renderer.destroy() }
  }

  it.each([
    ["a blank line between paragraphs", "kilo\n\nline 0201", ["kilo", "", "line 0201"], "kilo\n\nline 0201"],
    ["a blank line between code blocks", "```\na\n```\n\n```\nb\n```", ["a", "", "b"], "a\n\nb"],
  ])("copies %s as an empty line", async (_name, source, rows, copied) => {
    expect(await dragCopy(source)).toEqual({ rows, copied })
  })

  // Decoration is not text: the blockquote bar, table borders, and table rule
  // rows do not copy. Cells that share a row keep their screen gap as spaces.
  const REPLY = "intro\n\n> q1\n> q2\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - nested\n- two\n\n  ```js\n  const x = 1\n  ```\n- three\n\nz"

  it("copies every row of a reply with a blockquote, a table, a nested list, and code inside a list", async () => {
    expect(await dragCopy(REPLY)).toEqual({
      rows: ["intro", "", "┃ q1", "┃ q2", "", "┌───┬───┐", "│ a │ b │", "├───┼───┤", "│1  │2  │", "└───┴───┘", "- one", "  - nested", "- two", "", "const x = 1", "- three", "", "z"],
      copied: "intro\n\nq1\nq2\n\na   b\n1   2\n- one\n  - nested\n- two\n\nconst x = 1\n- three\n\nz",
    })
  })

  it("highlights the quote and every table cell that a full drag copies, and restores the screen after the copy", async () => {
    const result = await testRender(() => <ThemeProvider mode="dark"><MarkdownBody>{REPLY}</MarkdownBody></ThemeProvider>, { width: 60, height: 30 })
    const spans = () => result.captureSpans().lines.map((line) => line.spans.map((span) => ({ text: span.text, fg: span.fg.toString(), bg: span.bg.toString(), attributes: span.attributes })))
    const highlighted = (text: string) => result.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.trim() === text && span.bg.a > 0)
    try {
      await result.renderOnce()
      await result.renderOnce()
      const before = spans()
      await result.mockMouse.drag(0, 0, 1, 17)
      await result.renderOnce()
      expect(["q1", "q2", "a", "b", "1", "2"].filter((text) => !highlighted(text))).toEqual([])
      consumeSelectedText(result.renderer)
      await result.renderOnce()
      expect(spans()).toEqual(before)
    } finally { result.renderer.destroy() }
  })

  type Drag = (rows: string[]) => [number, number, number, number]
  const at = (rows: string[], needle: string): [number, number] => {
    const y = rows.findIndex((row) => row.includes(needle))
    return [rows[y]?.indexOf(needle) ?? -1, y]
  }
  const insideOne = (needle: string): Drag => (rows) => { const [x, y] = at(rows, needle); return [x + 1, y, x + 4, y] }
  const headerToBody: Drag = (rows) => { const [bx, by] = at(rows, "b"); const [ox, oy] = at(rows, "1"); return [bx, by, ox + 1, oy] }
  it.each<[string, string, Drag, string]>([
    ["inside one table cell", "| alpha | beta |\n|---|---|\n| one | two |", insideOne("alpha"), "lpha"],
    ["inside one quote line", "> quoted line\n> next", insideOne("quoted"), "uote"],
    ["from a header cell to the middle of a body row", "| a | b |\n|---|---|\n| 1 | 2 |", headerToBody, "b\n1"],
  ])("keeps the column bounds of a drag %s", async (_name, source, drag, copied) => {
    expect((await dragCopy(source, drag)).copied).toBe(copied)
  })

  // A drag that starts inside a cell copies the same text as a drag over the
  // whole rows from that character on, in either drag direction.
  const TABLE = "x\n\n| alpha | beta |\n|---|---|\n| one | two |\n\nz"
  const pToRowEnd = (rows: string[]): [number, number, number, number] => { const [x, y] = at(rows, "pha"); const [, end] = at(rows, "two"); return [x, y, rows[end]?.length ?? 0, end] }
  it.each<[string, Drag]>([
    ["forward", pToRowEnd],
    // A drag cannot start on a table border, so the backward drag starts on the last letter.
    ["backward", (rows) => { const [px, py] = at(rows, "pha"); const [tx, ty] = at(rows, "two"); return [tx + 2, ty, px, py] }],
  ])("copies a %s drag from inside a table cell as the matching part of the whole rows", async (_name, drag) => {
    const whole = (await dragCopy(TABLE)).copied ?? ""
    expect(whole).toBe("x\n\nalpha beta\none   two\nz")
    expect((await dragCopy(TABLE, drag)).copied).toBe("pha beta\none   two")
  })

  it.each<[string, [number, number, number, number]]>([
    ["starts at the content and ends in the gutter", [BLOCK_GUTTER_WIDTH, 0, 0, 3]],
    ["stays in the gutter dot column", [0, 0, 0, 3]],
    ["stays in the gutter space column", [1, 0, 1, 3]],
  ])("copies whole rows when a drag in a framed reply %s", async (_name, [fromX, fromY, toX, toY]) => {
    const result = await testRender(() => <ThemeProvider mode="dark"><BlockFrame><MarkdownBody>{"aaa\nbbb\n\nccc"}</MarkdownBody></BlockFrame></ThemeProvider>, { width: 40, height: 8 })
    try {
      await result.renderOnce()
      const rows = result.captureCharFrame()
      await result.mockMouse.drag(fromX, fromY, toX, toY)
      await result.renderOnce()
      expect(consumeSelectedText(result.renderer)).toBe("aaa\nbbb\n")
      await result.renderOnce()
      expect(result.captureCharFrame()).toBe(rows)
    } finally { result.renderer.destroy() }
  })

  it("counts a drag over only a blank row as a selection, so it never acts as a click", async () => {
    const result = await testRender(() => <ThemeProvider mode="dark"><MarkdownBody>{"kilo\n\nline 0201"}</MarkdownBody></ThemeProvider>, { width: 60, height: 10 })
    try {
      await result.renderOnce()
      await result.mockMouse.drag(0, 1, 3, 1)
      await result.renderOnce()
      expect(hasSelectedCells(result.renderer.getSelection())).toBe(true)
      expect(consumeSelectedText(result.renderer)).toBeNull()
    } finally { result.renderer.destroy() }
  })

  it("keeps the blank line after a heading that closes a full text segment", async () => {
    // The heading's own trailing blank line falls one line past a segment cut.
    const run = Array.from({ length: TEXT_SEGMENT_LINES - 1 }, (_, i) => `line ${i}`)
    const { rows, copied } = await dragCopy(`${run.join("\n")}\n# Heading\n\`\`\`\nzz\n\`\`\``)
    expect(rows).toEqual([...run, "Heading", "", "zz"])
    expect(copied).toBe([...run, "Heading", "", "zz"].join("\n"))
  })
})
