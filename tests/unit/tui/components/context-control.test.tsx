/** @jsxImportSource @opentui/solid */
import { describe, expect, it, mock } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"

const { testRender, useKeyboard } = await import("@opentui/solid")
const { ContextControl } = await import("../../../../src/tui/components/context-control.js")
const { ModalProvider, useModal } = await import("../../../../src/tui/components/modal.js")
const { QuestionInputProvider } = await import("../../../../src/tui/components/question-input.js")
const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const { ToastProvider } = await import("../../../../src/tui/context/toast.js")
const { contextGaugeCopy } = await import("../../../../src/protocol/client/context-compaction.js")

const clipboard = { copy: async (_text: string) => {}, readImage: async () => null }

function textByContent(root: Renderable, content: string): TextRenderable | undefined {
  const nodes: Renderable[] = [root]
  for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.getChildren())
  return nodes.find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText === content)
}

function renderControl(mode: "dark" | "light", compact: () => Promise<boolean>) {
  function Harness() {
    const modal = useModal()
    const { theme } = useTheme()
    useKeyboard((event) => modal.input(event))
    return <box flexDirection="row" justifyContent="flex-end" width={80}>
      <ContextControl label="73% ctx" color={theme.text} compacting={false} onCompact={compact}
        copy={contextGaugeCopy({ contextPercent: 28, contextPromptTokens: 256700, compactionThreshold: 350000 })} />
    </box>
  }
  return testRender(() => <ToastProvider><ThemeProvider mode={mode}><QuestionInputProvider>
    <ModalProvider clipboard={clipboard}><Harness /></ModalProvider>
  </QuestionInputProvider></ThemeProvider></ToastProvider>, { width: 80, height: 16, kittyKeyboard: true })
}

describe("context control", () => {
  it("overlays its header substring without consuming row width", async () => {
    const copy = contextGaugeCopy({ contextPercent: 28, contextPromptTokens: 256700, compactionThreshold: 350000 })
    function Harness() {
      const { theme } = useTheme()
      return <box position="relative" flexDirection="row">
        <text>stats text</text>
        <ContextControl
          overlayLeft={1}
          label="ctx"
          color={theme.text}
          compacting={false}
          copy={copy}
          onCompact={async () => true}
        />
        <text>tail</text>
      </box>
    }
    const result = await testRender(() => <ToastProvider><ThemeProvider mode="dark"><QuestionInputProvider>
      <ModalProvider clipboard={clipboard}><Harness /></ModalProvider>
    </QuestionInputProvider></ThemeProvider></ToastProvider>, { width: 40, height: 4 })
    try {
      await result.renderOnce()
      expect(textByContent(result.renderer.root, "tail")?.x).toBe("stats text".length)
      await result.mockMouse.pressDown(2, 0)
      await result.mockMouse.release(2, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Context")
    } finally { result.renderer.destroy() }
  })

  it.each(["dark", "light"] as const)("opens details without compacting in %s mode", async (mode) => {
    const compact = mock(async () => true)
    const result = await renderControl(mode, compact)
    try {
      await result.renderOnce()
      const before = result.captureSpans().lines[0]?.spans.find((span) => span.text.includes("73%"))?.bg
      await result.mockMouse.moveTo(75, 0)
      await result.renderOnce()
      const hovered = result.captureSpans().lines[0]?.spans.find((span) => span.text.includes("73%"))?.bg
      expect(before).toBeDefined()
      expect(hovered).toBeDefined()
      if (!before || !hovered) throw new Error("Context control colors were not rendered")
      expect(hovered.equals(before)).toBe(false)
      await result.mockMouse.pressDown(79, 0)
      await result.mockMouse.release(79, 0)
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("27% of context remaining until auto-compact.")
      expect(frame).toContain("256,700 of 350,000 tokens before compaction.")
      expect(frame.split("\n")[1]).toContain("╭")
      expect(compact).not.toHaveBeenCalled()
      const action = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Compact now"))
      const detail = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("256,700"))
      expect(action).toBeDefined()
      if (!action || !detail) throw new Error("Context action or detail was not rendered")
      expect(action.bg.equals(detail.bg)).toBe(false)
      await result.mockMouse.pressDown(0, 0)
      await result.mockMouse.release(0, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Compact now")
    } finally { result.renderer.destroy() }
  })

  it("Escape dismisses; Enter explicitly compacts", async () => {
    const compact = mock(async () => true)
    const result = await renderControl("dark", compact)
    try {
      await result.renderOnce()
      await result.mockMouse.pressDown(75, 0)
      await result.mockMouse.release(75, 0)
      await result.renderOnce()
      await result.mockInput.pressKey("ESCAPE")
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Compact now")
      expect(compact).not.toHaveBeenCalled()
      await result.mockMouse.pressDown(75, 0)
      await result.mockMouse.release(75, 0)
      await result.renderOnce()
      await result.mockInput.pressKey("RETURN")
      await result.renderOnce()
      expect(compact).toHaveBeenCalledTimes(1)
      expect(result.captureCharFrame()).not.toContain("Compact now")
    } finally { result.renderer.destroy() }
  })

  it("clicking the highlighted action compacts once and closes the popup", async () => {
    const compact = mock(async () => true)
    const result = await renderControl("dark", compact)
    try {
      await result.renderOnce()
      await result.mockMouse.pressDown(75, 0)
      await result.mockMouse.release(75, 0)
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Compact now"))
      const x = lines[y]?.indexOf("Compact now") ?? -1
      expect(x).toBeGreaterThanOrEqual(0)
      await result.mockMouse.pressDown(x, y)
      await result.mockMouse.release(x, y)
      await result.renderOnce()
      expect(compact).toHaveBeenCalledTimes(1)
      expect(result.captureCharFrame()).not.toContain("Compact now")
    } finally { result.renderer.destroy() }
  })
})
