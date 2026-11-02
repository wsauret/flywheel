import { describe, expect, it } from "bun:test"

import { computeToastLayout } from "../../../../src/tui/components/toast-layout.js"

describe("computeToastLayout", () => {
  it("bounds long toasts to the terminal instead of using message length", () => {
    const layout = computeToastLayout(120, 180)

    expect(layout.width).toBe(96)
    expect(layout.left).toBe(22)
    expect(layout.textWidth).toBe(92)
  })

  it("keeps short toasts compact", () => {
    const layout = computeToastLayout(120, 18)

    expect(layout.width).toBe(26)
    expect(layout.left).toBe(92)
    expect(layout.textWidth).toBe(22)
  })

})
