import { describe, expect, test } from "bun:test"

import { formatModuleNumberList, parseModuleNumberList } from "../../../../src/protocol/client/module-number-list.js"

const thresholds = { min: 1, max: 100, suffix: "%" }

describe("a module number list", () => {
  test("reads as Off when empty, and Off reads back as the empty list", () => {
    expect(formatModuleNumberList([], thresholds)).toBe("Off")
    expect(formatModuleNumberList([50, 80], thresholds)).toBe("50%, 80%")
    expect(parseModuleNumberList(formatModuleNumberList([], thresholds), thresholds)).toEqual([])
    expect(parseModuleNumberList("off", thresholds)).toEqual([])
  })
})
