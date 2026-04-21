import { describe, it, expect } from "bun:test"
import { truncateArrayMiddle } from "../src/infra/output/truncate-output"

describe("truncateArrayMiddle", () => {
  it("returns array unchanged when under the limit", () => {
    const result = truncateArrayMiddle(["a", "b"], 3)
    expect(result).toEqual({ lines: ["a", "b"], truncated: false, omitted: 0 })
  })

  it("returns array unchanged when exactly at the limit", () => {
    const result = truncateArrayMiddle(["a", "b", "c"], 3)
    expect(result).toEqual({ lines: ["a", "b", "c"], truncated: false, omitted: 0 })
  })

  it("truncates 5 items with maxLines=3 → head(1) + tail(1), omitted=3", () => {
    const result = truncateArrayMiddle(["a", "b", "c", "d", "e"], 3)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(3)
    expect(result.lines).toEqual(["a", "e"])
  })

  it("truncates 20 items with maxLines=10 → head(5) + tail(4), omitted=11", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item${i}`)
    const result = truncateArrayMiddle(items, 10)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(11)
    expect(result.lines.length).toBe(9)
    expect(result.lines[0]).toBe("item0")
    expect(result.lines[4]).toBe("item4")
    expect(result.lines[5]).toBe("item16")
    expect(result.lines[8]).toBe("item19")
  })

  it("handles empty array", () => {
    const result = truncateArrayMiddle([], 3)
    expect(result).toEqual({ lines: [], truncated: false, omitted: 0 })
  })

  it("handles maxLines=1 → head(0) + tail(0), omitted=all", () => {
    const result = truncateArrayMiddle(["a", "b", "c"], 1)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(3)
    expect(result.lines).toEqual([])
  })

  it("works with non-string arrays", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
    const result = truncateArrayMiddle(items, 3)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(3)
    expect(result.lines).toEqual([{ id: 1 }, { id: 5 }])
  })
})
