import { describe, expect, it } from "bun:test"

import { formatCostSplit } from "../../../src/protocol/client/format.js"

describe("formatCostSplit", () => {
  it("returns empty when nothing was spent", () => {
    expect(formatCostSplit(0, 0)).toBe("")
  })

  it("shows plain billed spend when everything is metered", () => {
    expect(formatCostSplit(1.34, 1.34)).toBe("$1.34")
  })

  it("rounds sub-cent estimates to cents", () => {
    expect(formatCostSplit(3.7598, 3.75)).toBe("$3.75 · ~$0.01")
    expect(formatCostSplit(1.344, 1.34)).toBe("$1.34 · ~$0.00")
  })

  it("rounds sub-cent billed spend to cents", () => {
    expect(formatCostSplit(0.0098, 0.0098)).toBe("$0.01")
    expect(formatCostSplit(0.004, 0.004)).toBe("$0.00")
  })
})
