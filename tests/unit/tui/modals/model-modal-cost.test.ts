import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  MODEL_MODAL_COST_COLUMN_WIDTH,
  costBarText,
  costGradient,
  costMarker,
  priceHeaderText,
  priceValueText,
} from "../../../../src/tui/modals/model-modal-cost.js"
import { styledTextContent, theme } from "./_model-modal-fixtures.js"
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }

describe("model modal cost presentation", () => {
  test("builds a themed piecewise gradient through semantic colors", () => {
    const colors = costGradient(theme, 7)
    expect(colors).toHaveLength(7)
    expect(colors[0]).toEqual(theme.success)
    expect(colors[2]).toEqual(theme.info)
    expect(colors[4]).toEqual(theme.primary)
    expect(colors[6]).toEqual(theme.error)
  })

  test("places logarithmic markers at the range boundaries and midpoint", () => {
    expect(costMarker(1, 1, 100, 9)).toBe(0)
    expect(costMarker(10, 1, 100, 9)).toBe(4)
    expect(costMarker(100, 1, 100, 9)).toBe(8)
    expect(costMarker(undefined, 1, 100, 9)).toBeUndefined()
  })

  test("renders a white marker while retaining gradient metadata", () => {
    const white = RGBA.fromInts(255, 255, 255)
    const bar = costBarText(10, [1, 10, 100], theme, 9)
    expect(styledTextContent(bar)).toBe("━━━━●━━━━")
    expect(bar.chunks.find((chunk) => chunk.text === "●")?.fg).toEqual(white)
    expect(bar.chunks[0]?.fg).toEqual(theme.success)
    expect(bar.chunks.at(-1)?.fg).toEqual(theme.error)
  })

  test("uses resolved semantic colors in dark and light themes", () => {
    for (const mode of ["dark", "light"] as const) {
      const resolved = resolveTheme(flywheelTheme, mode)
      const colors = costGradient(resolved, 4)
      expect(colors).toEqual([resolved.success, resolved.info, resolved.primary, resolved.error])
    }
  })

  test("builds an exact three by seventeen price table", () => {
    const header = styledTextContent(priceHeaderText(theme))
    const values = styledTextContent(priceValueText({ input: 10, cacheRead: 0.25, output: 50 }, theme))
    expect(MODEL_MODAL_COST_COLUMN_WIDTH).toBe(17)
    expect(header).toBe("Input            Cached input     Output           ")
    expect(values).toBe("$10 / 1M         $0.25 / 1M       $50 / 1M         ")
    expect(header).toHaveLength(51)
    expect(values).toHaveLength(51)
  })

  test("formats zero, sub-cent, and decimal rates", () => {
    expect(styledTextContent(priceValueText({ input: 0, cacheRead: 0.0025, output: 2.5 }, theme)))
      .toBe("$0 / 1M          $0.0025 / 1M     $2.50 / 1M       ")
  })

  test("shows unavailable cache and all unavailable values without cost", () => {
    expect(styledTextContent(priceValueText({ input: 1, output: 2 }, theme))).toContain("n/a")
    expect(styledTextContent(priceValueText(undefined, theme))).toBe("Pricing unavailable")
    expect(styledTextContent(costBarText(undefined, [], theme, 82))).toBe("")
  })
})
