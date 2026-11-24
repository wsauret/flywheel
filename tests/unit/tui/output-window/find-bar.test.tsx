/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { RowWidthProvider } from "@tui/context/row-width.js"
import { ThemeProvider } from "@tui/context/theme.js"
import { FindBar } from "@tui/output-window/find-bar.js"
import { createFindBar, type FindBar as FindBarModel } from "@tui/output-window/create-find-bar.js"

async function renderBar(width: number) {
  let bar!: FindBarModel
  function Harness() {
    bar = createFindBar({
      client: { query: async () => ({ matches: [], more: false, openFromBlockIndex: 0, blockCount: 0 }) },
      sessionId: () => "s1",
      includeThinking: () => false,
      transcript: () => ({ freshness: () => undefined }),
      report: () => {},
    })
    bar.open()
    return <RowWidthProvider value={{ width: () => width - 2, report: () => {} }}>
      <box position="relative" paddingLeft={1} width={width} height={6}><FindBar bar={bar} /></box>
    </RowWidthProvider>
  }
  const result = await testRender(() => <ThemeProvider mode="dark" themeName="flywheel"><Harness /></ThemeProvider>, { width, height: 6 })
  await result.renderOnce()
  return { result, bar, row: () => result.captureCharFrame().split("\n")[1] ?? "" }
}

describe("FindBar", () => {
  it("closes on a click of its close button and leaves the keys with the prompt", async () => {
    const { result, bar, row } = await renderBar(80)
    try {
      expect(bar.focused()).toBe(true)
      await result.mockMouse.click(row().indexOf("✕"), 1)
      expect(bar.isOpen()).toBe(false)
      expect(bar.focused()).toBe(false)
    } finally { result.renderer.destroy() }
  })

  it.each([80, 44, 36])("keeps the Find field inside a %i column transcript at one width while the status changes", async (width) => {
    const { result, bar, row } = await renderBar(width)
    try {
      const left = row().indexOf("│")
      expect(left).toBeGreaterThanOrEqual(0)
      bar.toggleRegex()
      for (const name of "ab(") bar.input({ name, raw: name })
      await result.renderOnce()
      expect(row()).toContain("bad pattern")
      expect(row().slice(left)).toMatch(/^│ ab\(/)
    } finally { result.renderer.destroy() }
  })
})
