/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { ModalSelect } from "../../../../src/tui/components/modal-select.js"
import type { ModalSelectOption, FilteredResult } from "../../../../src/tui/components/modal-select-types.js"
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"

const theme = resolveTheme(flywheelTheme, "dark")

function option(id: string): ModalSelectOption<string> {
  return { id, title: id, value: id, footer: "hint" }
}

describe("ModalSelect", () => {

  it("marks clipped option rows with a truncation marker", async () => {
    const resultModel: FilteredResult<string> = {
      rows: [{
        kind: "option",
        id: "long",
        rowIndex: 0,
        option: { id: "long", title: "Settings", value: "long", description: "A description that cannot fit" },
      }],
      totalMatches: 1,
      capped: false,
    }
    const result = await testRender(() => (
      <ThemeProvider mode="dark">
        <ModalSelect
          result={resultModel}
          cursor={0}
          theme={theme}
          listMaxHeight={2}
          onRowClick={() => {}}
          footerRows={["Enter open"]}
        />
      </ThemeProvider>
    ), { width: 24, height: 4 })

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("...")
    } finally {
      result.renderer.destroy()
    }
  })

  it("aligns titles across current, status-icon, and plain rows", async () => {
    const resultModel: FilteredResult<string> = {
      rows: [
        { kind: "option", id: "current", rowIndex: 0, option: option("current") },
        { kind: "option", id: "create", rowIndex: 1, option: { ...option("create"), statusIcon: "+" } },
        { kind: "option", id: "plain", rowIndex: 2, option: { ...option("plain"), description: "description", rightDetail: "detail" } },
      ],
      totalMatches: 3,
      capped: false,
    }
    const result = await testRender(() => (
      <ThemeProvider mode="dark">
        <ModalSelect result={resultModel} cursor={0} current="current" theme={theme} listMaxHeight={3} onRowClick={() => {}} footerRows={["Enter open"]} />
      </ThemeProvider>
    ), { width: 70, height: 6 })

    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const columnOf = (title: string): number => (lines.find((line) => line.includes(title)) ?? "").indexOf(title)
      expect(columnOf("create")).toBe(columnOf("current"))
      expect(columnOf("plain")).toBe(columnOf("current"))
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const spanWith = (text: string) => spans.find((span) => span.text.includes(text))
      const dim = createTextAttributes({ dim: true })
      expect(spanWith("current")?.fg.equals(theme.text)).toBe(true)
      expect(spanWith("plain")?.fg.equals(theme.textSubtle)).toBe(true)
      const plainSpans = result.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("plain")))?.spans ?? []
      for (const text of ["plain", "hint", "description", "detail"]) {
        const span = plainSpans.find((candidate) => candidate.text.includes(text))
        expect(span).toBeDefined()
        expect((span?.attributes ?? 0) & dim).toBe(0)
        if (text !== "plain") expect(span?.fg.equals(theme.textMuted)).toBe(true)
      }
    } finally {
      result.renderer.destroy()
    }
  })
})
