/** @jsxImportSource @opentui/solid */
import { describe, expect, it, spyOn } from "bun:test"
import { CodeRenderable, TextRenderable, createTextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import hljs from "highlight.js/lib/common"
import { batch, createSignal } from "solid-js"
import { isServer } from "solid-js/web"
import { SyntaxCode } from "@tui/components/syntax-code.js"
import { ThemeProvider, useTheme } from "@tui/context/theme.js"
import { chatSyntaxColors } from "@tui/adapters/syntax-highlight.js"
import { contrastRatio } from "@tui/context/theme/color-contrast.js"

const DIM = createTextAttributes({ dim: true })

describe("SyntaxCode", () => {
  it("owns fallback highlighting only while the native streaming branch is inactive", async () => {
    expect(isServer).toBe(false)
    const highlight = spyOn(hljs, "highlight")
    const [content, setContent] = createSignal("const first = 1\nconst second = 2")
    const [lineNumbers, setLineNumbers] = createSignal(false)
    const [streaming, setStreaming] = createSignal(true)
    const [dimColor, setDimColor] = createSignal(false)
    const [themeName, publishTheme] = createSignal("github")
    let theme: ReturnType<typeof useTheme> | undefined
    function Harness() {
      theme = useTheme()
      return <box backgroundColor={theme.theme.background}>
        <SyntaxCode filetype="typescript" content={content()} lineNumbers={lineNumbers()} streaming={streaming()} dimColor={dimColor()} />
      </box>
    }
    const result = await testRender(() => <ThemeProvider mode="light" themeName={themeName()}><Harness /></ThemeProvider>, { width: 60, height: 8 })
    const children = () => result.renderer.root.getChildren()[0]?.getChildren() ?? []
    const nativeCode = () => children().find((child) => child instanceof CodeRenderable)
    const fallbackLines = () => children().filter((child) => child instanceof TextRenderable)
    try {
      await result.renderOnce()
      const native = nativeCode()
      if (!native || !theme) throw new Error("Native code and its theme were not mounted")
      const background = theme.theme.background
      const expectReadableSpans = () => {
        const spans = result.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.trim())
        expect(spans.length).toBeGreaterThan(0)
        for (const span of spans) {
          expect(span.bg.equals(background)).toBe(true)
          expect(contrastRatio(span.fg, span.bg)).toBeGreaterThanOrEqual(4.5)
        }
      }
      expectReadableSpans()
      expect(native.fg.equals(theme.theme.text)).toBe(true)
      expect(native.content).toBe(content())
      expect(native.streaming).toBe(true)
      expect(native.syntaxStyle).toBe(theme.syntax)
      expect(highlight).not.toHaveBeenCalled()
      await native.highlightingDone
      await result.renderOnce()
      expectReadableSpans()

      setContent((previous) => `${previous}\nconst third = 3`)
      await result.renderOnce()
      expect(nativeCode()).toBe(native)
      expect(native.content).toBe(content())
      expect(result.captureCharFrame()).toContain("const third = 3")
      expect(highlight).not.toHaveBeenCalled()
      expectReadableSpans()
      expect(native.fg.equals(theme.theme.text)).toBe(true)
      await native.highlightingDone
      await result.renderOnce()
      expectReadableSpans()

      batch(() => { setStreaming(false); setDimColor(true) })
      await result.renderOnce()
      expect(native.streaming).toBe(false)
      expect(native.syntaxStyle).toBe(theme.subtleSyntax)
      expect(native.fg.equals(theme.subtleTheme.text)).toBe(true)
      expect(highlight).not.toHaveBeenCalled()

      setLineNumbers(true)
      await result.renderOnce()
      await new Promise<void>((resolve) => process.nextTick(resolve))
      expect(nativeCode()).toBeUndefined()
      expect(native.isDestroyed).toBe(true)
      expect(highlight).toHaveBeenCalledTimes(1)
      expect(highlight).toHaveBeenLastCalledWith(content(), { language: "typescript", ignoreIllegals: true })
      const lines = fallbackLines()
      expect(lines.map((line) => line.content.chunks.map((chunk) => chunk.text).join(""))).toEqual([
        " 1  const first = 1", " 2  const second = 2", " 3  const third = 3",
      ])
      const keyword = result.captureSpans().lines[0]?.spans.find((span) => span.text === "const")
      expect(keyword?.fg.equals(chatSyntaxColors(theme.subtleTheme).keyword)).toBe(true)
      expect((keyword?.attributes ?? 0) & DIM).toBe(0)
      expect(lines[0]?.content.chunks[0]?.fg?.equals(theme.subtleTheme.text)).toBe(true)
      expect(lines.every((line) => line.selectable && line.wrapMode === "word")).toBe(true)

      setLineNumbers(false)
      await result.renderOnce()
      await new Promise<void>((resolve) => process.nextTick(resolve))
      expect(nativeCode()).toBeInstanceOf(CodeRenderable)
      expect(lines.every((line) => line.isDestroyed)).toBe(true)
      highlight.mockClear()
      setContent((previous) => `${previous}\nconst fourth = 4`)
      publishTheme("catppuccin")
      await result.renderOnce()
      expect(nativeCode()?.content).toBe(content())
      expect(highlight).not.toHaveBeenCalled()

      setLineNumbers(true)
      await result.renderOnce()
      expect(highlight).toHaveBeenCalledTimes(1)
      expect(highlight).toHaveBeenLastCalledWith(content(), { language: "typescript", ignoreIllegals: true })
      expect(result.captureCharFrame()).toContain(" 4  const fourth = 4")
      const remountedKeyword = result.captureSpans().lines[0]?.spans.find((span) => span.text === "const")
      expect(remountedKeyword?.fg.equals(chatSyntaxColors(theme.subtleTheme).keyword)).toBe(true)
    } finally {
      result.renderer.destroy()
      highlight.mockRestore()
    }
  })

  it("keeps fallback language aliases, readable subdued palettes, and reactive gutters", async () => {
    expect(isServer).toBe(false)
    const highlight = spyOn(hljs, "highlight")
    const [writePalette, setWritePalette] = createSignal(false)
    const [lineNumbers, setLineNumbers] = createSignal(false)
    const [lineNumberWidth, setLineNumberWidth] = createSignal<number | undefined>()
    const [dimColor, setDimColor] = createSignal(false)
    const [filetype, setFiletype] = createSignal("python3")
    let theme: ReturnType<typeof useTheme> | undefined
    function Harness() {
      const context = useTheme()
      theme = context
      return <SyntaxCode filetype={filetype()} content={'def fallback(value):\n    return "ready"'}
        colors={writePalette() ? context.writeSyntaxColors : undefined}
        lineNumbers={lineNumbers()} lineNumberWidth={lineNumberWidth()} dimColor={dimColor()} />
    }
    const result = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 60, height: 5 })
    const spanWith = (text: string) => result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))
    try {
      await result.renderOnce()
      if (!theme) throw new Error("Fallback theme was not mounted")
      expect(result.renderer.root.getChildren().some((child) => child instanceof CodeRenderable)).toBe(false)
      expect(highlight).toHaveBeenLastCalledWith('def fallback(value):\n    return "ready"', { language: "python", ignoreIllegals: true })
      expect(result.captureCharFrame().split("\n").slice(0, 2).map((line) => line.trimEnd())).toEqual([
        "def fallback(value):", '    return "ready"',
      ])
      expect(spanWith("def")?.fg.equals(theme.chatSyntaxColors.keyword)).toBe(true)
      expect(spanWith('"ready"')?.fg.equals(theme.chatSyntaxColors.string)).toBe(true)

      setDimColor(true)
      await result.renderOnce()
      expect(spanWith("def")?.fg.equals(chatSyntaxColors(theme.subtleTheme).keyword)).toBe(true)
      expect((spanWith("def")?.attributes ?? 0) & DIM).toBe(0)

      batch(() => {
        setWritePalette(true)
        setLineNumbers(true)
        setLineNumberWidth(3)
        setDimColor(true)
      })
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n").slice(0, 2).map((line) => line.trimEnd())).toEqual([
        "   1  def fallback(value):", '   2      return "ready"',
      ])
      expect(spanWith("def")?.fg.equals(theme.writeSyntaxColors.keyword)).toBe(true)
      expect(spanWith('"ready"')?.fg.equals(theme.writeSyntaxColors.string)).toBe(true)
      expect(spanWith(":")?.fg.equals(theme.writeSyntaxColors.text)).toBe(true)
      expect((spanWith("def")?.attributes ?? 0) & DIM).toBe(0)
      expect(spanWith("1")?.fg.equals(theme.writeSyntaxColors.text)).toBe(true)
      expect((spanWith("1")?.attributes ?? 0) & DIM).toBe(0)

      const callsBeforeGutterChange = highlight.mock.calls.length
      batch(() => { setLineNumberWidth(undefined); setDimColor(false) })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(" 1  def fallback(value):")
      expect((spanWith("def")?.attributes ?? 0) & DIM).toBe(0)
      expect(highlight).toHaveBeenCalledTimes(callsBeforeGutterChange)

      batch(() => { setWritePalette(false); setDimColor(true); setFiletype("unknown-language") })
      await result.renderOnce()
      const chunks = result.renderer.root.getChildren().filter((child) => child instanceof TextRenderable).flatMap((line) => line.content.chunks)
      const foreground = theme.subtleTheme.text
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every((chunk) => chunk.fg?.equals(foreground) && ((chunk.attributes ?? 0) & DIM) === 0)).toBe(true)
    } finally {
      result.renderer.destroy()
      highlight.mockRestore()
    }
  })
})
