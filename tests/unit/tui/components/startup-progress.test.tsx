/** @jsxImportSource @opentui/solid */

import { expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { StartupProgress } from "../../../../src/tui/components/startup-progress.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"

const theme = resolveTheme(flywheelTheme, "dark")

it("renders startup progress with the shared bar and count hierarchy", async () => {
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() { return createComponent(StartupProgress, { step: 2, total: 4, width: 8 }) },
  }), { width: 20, height: 1 })
  try {
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("████░░░░ 2/4")
    const spans = result.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text === "████░░░░")?.fg.equals(theme.primary)).toBe(true)
    expect(spans.find((span) => span.text === "2/4")?.fg.equals(theme.textMuted)).toBe(true)
  } finally {
    result.renderer.destroy()
  }
})
