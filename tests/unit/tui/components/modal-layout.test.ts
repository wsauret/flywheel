import { describe, expect, it } from "bun:test"

import { computeModalListHeight, computeModalWidth, computeResponsivePaneLayout } from "../../../../src/tui/components/modal-layout.js"

describe("modal layout helpers", () => {
  it("keeps modal width inside narrow terminals", () => {
    expect(computeModalWidth(80, 76)).toBe(80)
    expect(computeModalWidth(30, 76)).toBe(30)
    expect(computeModalWidth(120, 76)).toBe(76)
  })

  it("reduces list height so modal chrome remains visible", () => {
    expect(computeModalListHeight(24, 12)).toBe(12)
    expect(computeModalListHeight(40, 12)).toBe(18)
  })

  it("very narrow terminal clamps to minimum width", () => {
    expect(computeModalWidth(20, 76)).toBe(24)
  })

  it("very short terminal clamps to minimum list height", () => {
    expect(computeModalListHeight(10, 12)).toBe(4)
  })

  it("accepts a caller-specific maximum list height", () => {
    expect(computeModalListHeight(40, 12, 24)).toBe(24)
    expect(computeModalListHeight(40, 12, 12)).toBe(12)
  })

  it("stacks session panes below 120 columns", () => {
    const layout = computeResponsivePaneLayout(119, 100, 20)

    expect(layout.mode).toBe("stacked")
    expect(layout.listWidth).toBe(100)
    expect(layout.previewWidth).toBe(100)
  })

  it("splits session panes at 120 columns and preserves the content width", () => {
    const layout = computeResponsivePaneLayout(120, 101, 20)

    expect(layout.mode).toBe("split")
    expect(layout.listWidth + layout.previewWidth + layout.gap).toBe(101)
    expect(Math.abs(layout.listWidth - layout.previewWidth)).toBeLessThanOrEqual(1)
  })
})
