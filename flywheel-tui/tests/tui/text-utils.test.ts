import { describe, it, expect } from "bun:test"
import { truncate, MAX_BLOCK_LINE_LENGTH } from "../../src/tui/utils/text"

describe("truncate", () => {
  it("returns text unchanged when shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("returns text unchanged when exactly maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello")
  })

  it("truncates with ellipsis when text exceeds maxLen", () => {
    expect(truncate("hello world", 8)).toBe("hello w\u2026")
  })

  it("truncates to maxLen total characters including ellipsis", () => {
    const result = truncate("abcdefghij", 6)
    expect(result).toBe("abcde\u2026")
    expect(result.length).toBe(6)
  })

  it("hard-slices without ellipsis when maxLen < 4", () => {
    expect(truncate("hello", 3)).toBe("hel")
    expect(truncate("hello", 2)).toBe("he")
    expect(truncate("hello", 1)).toBe("h")
    expect(truncate("hello", 0)).toBe("")
  })

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("")
  })

  it("handles single character", () => {
    expect(truncate("x", 1)).toBe("x")
  })

  it("handles maxLen of exactly 4 (boundary for ellipsis behavior)", () => {
    expect(truncate("abcde", 4)).toBe("abc\u2026")
  })
})

describe("MAX_BLOCK_LINE_LENGTH", () => {
  it("is 80", () => {
    expect(MAX_BLOCK_LINE_LENGTH).toBe(80)
  })
})
