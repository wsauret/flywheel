/** @jsxImportSource @opentui/solid */
import { describe, expect, it, mock } from "bun:test"

const { testRender } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
const { Button } = await import("../../../../src/tui/components/button.js")
const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const { BOLD } = await import("../../../../src/tui/utils/text-attributes.js")

describe("Button", () => {
  it.each(["dark", "light"] as const)("shares hover and focus highlights in %s mode", async (mode) => {
    const press = mock(() => {})
    const [focused, setFocused] = createSignal(false)
    const result = await testRender(() => <ThemeProvider mode={mode}>
      <Button label="Apply" hotkey="enter" focused={focused()} onPress={press} />
    </ThemeProvider>, { width: 30, height: 3 })
    const labelSpan = () => {
      const span = result.captureSpans().lines[0]?.spans.find((item) => item.text.includes("Apply"))
      if (!span) throw new Error("Button label was not rendered")
      return span
    }
    try {
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n")[0]).toMatch(/^ Apply enter /)
      const normal = labelSpan()
      await result.mockMouse.moveTo(0, 0)
      await result.renderOnce()
      const hover = labelSpan()
      expect(hover.bg.equals(normal.bg)).toBe(false)
      expect(hover.fg.equals(normal.fg)).toBe(false)
      await result.mockMouse.moveTo(20, 2)
      setFocused(true)
      await result.renderOnce()
      expect(labelSpan().bg.equals(hover.bg)).toBe(true)
      expect(result.captureCharFrame()).toContain("> Apply")
      setFocused(false)
      await result.mockMouse.pressDown(0, 0)
      await result.mockMouse.release(0, 0)
      expect(press).toHaveBeenCalledTimes(1)
    } finally { result.renderer.destroy() }
  })

  it.each(["dark", "light"] as const)("renders a muted action without a hotkey in %s mode", async (mode) => {
    const [focused, setFocused] = createSignal(false)
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      const { theme } = useTheme()
      colors = theme
      return <Button label="Dismiss" muted focused={focused()} onPress={() => {}} />
    }
    const result = await testRender(() => <ThemeProvider mode={mode}><Harness /></ThemeProvider>, { width: 20, height: 3 })
    const labelSpan = () => {
      const span = result.captureSpans().lines[0]?.spans.find((item) => item.text.includes("Dismiss"))
      if (!span) throw new Error("Dismiss was not rendered")
      return span
    }
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Button theme was not provided")
      const normal = labelSpan()
      expect(normal.fg.equals(colors.textMuted)).toBe(true)
      expect(normal.attributes & BOLD).toBe(0)
      const background = colors.backgroundElement
      const surface = result.captureSpans().lines[0]?.spans.filter((span) => span.bg.equals(background)).map((span) => span.text).join("")
      expect(surface).toBe(" Dismiss ")
      await result.mockMouse.moveTo(0, 0)
      await result.renderOnce()
      expect(labelSpan().bg.equals(colors.primary)).toBe(true)
      expect(labelSpan().fg.equals(colors.background)).toBe(true)
      await result.mockMouse.moveTo(15, 2)
      setFocused(true)
      await result.renderOnce()
      expect(labelSpan().bg.equals(colors.primary)).toBe(true)
      expect(labelSpan().fg.equals(colors.background)).toBe(true)
    } finally { result.renderer.destroy() }
  })
})
