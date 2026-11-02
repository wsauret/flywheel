/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"

const { testRender } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
const { ThinkingBlock } = await import("../../../../src/tui/output-blocks/thinking-block.js")
const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const { BlockDisclosureProvider, createBlockDisclosureChannel } = await import("../../../../src/tui/context/block-disclosure.js")
const { TickPoolProvider } = await import("../../../../src/tui/context/tick-pool-context.js")

describe("thinking body hitbox", () => {
  it("toggles and highlights from the rail and padding beside its shown body, while the space beside its header does nothing", async () => {
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <ThinkingBlock block={{ kind: "thinking", id: "think", content: "one\ntwo\nthree\nfour\nfive", status: "completed", timestamp: 1, completedAt: 1 }} />
    }
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode="dark"><TickPoolProvider>
      <Harness />
    </TickPoolProvider></ThemeProvider></BlockDisclosureProvider>, { width: 60, height: 10 })
    const rows = () => result.captureCharFrame().split("\n")
    const header = () => rows()[0] ?? ""
    try {
      await result.renderOnce()
      expect(header()).toContain("▸")
      await result.mockMouse.click(50, 0)
      await result.renderOnce()
      expect(header()).toContain("▸")

      // The rail cell and the padding cell beside the preview's first line.
      const preview = rows().findIndex((row) => row.includes("three"))
      const rail = rows()[preview]?.indexOf("┃") ?? -1
      await result.mockMouse.moveTo(rail, preview)
      await result.renderOnce()
      const text = result.captureSpans().lines[preview]?.spans.find((span) => span.text.includes("three"))
      if (!colors) throw new Error("Missing theme")
      expect(text?.bg.equals(colors.backgroundElement)).toBe(true)
      await result.mockMouse.click(rail, preview)
      await result.renderOnce()
      expect(header()).toContain("▾")

      await result.mockMouse.click(rail + 1, rows().findIndex((row) => row.includes("one")))
      await result.renderOnce()
      expect(header()).toContain("▸")
    } finally { result.renderer.destroy() }
  })

  it("redraws its rail in the new theme's colour after a mode switch", async () => {
    const [mode, setMode] = createSignal<"dark" | "light">("dark")
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <ThinkingBlock block={{ kind: "thinking", id: "think", content: "one\ntwo\nthree\nfour\nfive", status: "completed", timestamp: 1, completedAt: 1 }} />
    }
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode={mode()}><TickPoolProvider>
      <Harness />
    </TickPoolProvider></ThemeProvider></BlockDisclosureProvider>, { width: 60, height: 10 })
    const railColor = () => {
      const lines = result.captureSpans().lines
      const row = lines.findIndex((line) => line.spans.some((span) => span.text.includes("three")))
      return lines[row]?.spans.find((span) => span.text.includes("┃"))?.fg
    }
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Missing theme")
      const dark = colors.borderSubtle
      expect(railColor()?.equals(dark)).toBe(true)
      setMode("light")
      await result.renderOnce()
      expect(colors.borderSubtle.equals(dark)).toBe(false)
      expect(railColor()?.equals(colors.borderSubtle)).toBe(true)
    } finally { result.renderer.destroy() }
  })
})
