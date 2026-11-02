import { describe, expect, test } from "bun:test"

import { sparkline } from "../../../../src/tui/components/sparkline.js"

describe("sparkline", () => {
  test("draws each column as its highest point, leaves empty columns blank, and marks a reset", () => {
    const points = [{ atMs: 0, fraction: 0 }, { atMs: 10, fraction: 0.5 }, { atMs: 20, fraction: 1 }]
    expect(sparkline(points, [30], 0, 40, 4)).toBe("▁▅█╎")
  })

  test("a reset in a column that has a point keeps the point", () => {
    expect(sparkline([{ atMs: 0, fraction: 1 }], [0], 0, 10, 2)).toBe("█ ")
  })
})
