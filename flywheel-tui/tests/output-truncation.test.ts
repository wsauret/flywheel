import { describe, it, expect } from "bun:test"
import { truncateArrayHead } from "../src/infra/output/truncate-output"

describe("truncateArrayHead", () => {
  it("returns array unchanged when under the limit", () => {
    const result = truncateArrayHead(["a", "b"], 3)
    expect(result).toEqual({ lines: ["a", "b"], truncated: false, omitted: 0 })
  })

  it("returns array unchanged when exactly at the limit", () => {
    const result = truncateArrayHead(["a", "b", "c"], 3)
    expect(result).toEqual({ lines: ["a", "b", "c"], truncated: false, omitted: 0 })
  })

  it("keeps only the first maxLines items", () => {
    const result = truncateArrayHead(["a", "b", "c", "d", "e"], 3)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(2)
    expect(result.lines).toEqual(["a", "b", "c"])
  })

  it("truncates 50 items with maxLines=20 → first 20, omitted=30", () => {
    const items = Array.from({ length: 50 }, (_, i) => `line${i}`)
    const result = truncateArrayHead(items, 20)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(30)
    expect(result.lines.length).toBe(20)
    expect(result.lines[0]).toBe("line0")
    expect(result.lines[19]).toBe("line19")
  })

  it("handles empty array", () => {
    const result = truncateArrayHead([], 3)
    expect(result).toEqual({ lines: [], truncated: false, omitted: 0 })
  })

  it("handles maxLines=0", () => {
    const result = truncateArrayHead(["a", "b"], 0)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toBe(2)
    expect(result.lines).toEqual([])
  })
})
