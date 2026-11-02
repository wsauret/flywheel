import { describe, expect, it } from "bun:test"
import { progressBar } from "../../../../src/tui/components/progress-bar.js"

describe("progressBar", () => {
  it("renders empty, partial, and full progress with Usage glyphs", () => {
    expect(progressBar(0, 4)).toBe("░░░░")
    expect(progressBar(0.5, 4)).toBe("██░░")
    expect(progressBar(1, 4)).toBe("████")
  })

  it("clamps fractions and non-positive widths", () => {
    expect(progressBar(-1, 4)).toBe("░░░░")
    expect(progressBar(2, 4)).toBe("████")
    expect(progressBar(0.5, 0)).toBe("")
    expect(progressBar(0.5, -4)).toBe("")
  })
})
