/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import type { StatusRow } from "../../../../src/tui/hooks/use-status-modal.js"
import { StatusModal } from "../../../../src/tui/modals/status-modal.js"

const theme = resolveTheme(flywheelTheme, "dark")

const ROWS: readonly StatusRow[] = [
  { label: "Session", value: "s1 · chat · active" },
  { label: "Papercuts", value: "3 waiting", hint: "Pick this to work through them.", action: { kind: "command", id: "papercuts" } },
  { label: "Definitions", value: "1 problem", tone: "warning", hint: "a.yaml (project): unreadable\nb.yaml (user): unreadable" },
]

describe("StatusModal", () => {
  it("renders module rows after the kernel rows with the command in the primary colour and a warning tone on the label", async () => {
    const rendered = await testRender(() => (
      <ThemeProvider mode="dark">
        <StatusModal rows={ROWS} cursor={-1} onClose={() => {}} onRowClick={() => {}} />
      </ThemeProvider>
    ), { width: 100, height: 20 })
    try {
      await rendered.renderOnce()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("Session     s1 · chat · active")
      expect(frame).toContain("Papercuts   3 waiting  /papercuts  Pick this to work through them.")
      expect(frame).toContain("Definitions 1 problem  a.yaml (project): unreadable · b.yaml (user): unreadable")
      expect(frame.indexOf("Session")).toBeLessThan(frame.indexOf("Papercuts"))
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes("/papercuts"))?.fg.equals(theme.primary)).toBe(true)
      expect(spans.find((span) => span.text.includes("Definitions"))?.fg.equals(theme.warning)).toBe(true)
      expect(spans.find((span) => span.text.includes("Papercuts"))?.fg.equals(theme.text)).toBe(true)
    } finally {
      rendered.renderer.destroy()
    }
  })
})
