import { describe, it, expect } from "bun:test"
import { truncate, wrapText, repeatChar } from "../../src/tui/shared/utils/text"

describe("truncate", () => {
  it("returns string unchanged if within max length", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("truncates with ellipsis when exceeding max length", () => {
    expect(truncate("hello world", 8)).toBe("hello...")
  })

  it("returns string unchanged at exact max length", () => {
    expect(truncate("hello", 5)).toBe("hello")
  })

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("")
  })
})

describe("wrapText", () => {
  it("returns single line when text fits width", () => {
    expect(wrapText("hello world", 20)).toEqual(["hello world"])
  })

  it("wraps text at word boundaries", () => {
    const result = wrapText("hello world foo bar", 11)
    expect(result).toEqual(["hello world", "foo bar"])
  })

  it("preserves explicit newlines", () => {
    const result = wrapText("line one\nline two", 50)
    expect(result).toEqual(["line one", "line two"])
  })

  it("preserves empty lines", () => {
    const result = wrapText("line one\n\nline three", 50)
    expect(result).toEqual(["line one", "", "line three"])
  })

  it("wraps long lines while preserving short ones", () => {
    const result = wrapText("short\nthis is a much longer line that needs wrapping", 20)
    expect(result[0]).toBe("short")
    expect(result.length).toBeGreaterThan(2)
  })
})

describe("repeatChar", () => {
  it("repeats a character the specified number of times", () => {
    expect(repeatChar("-", 5)).toBe("-----")
  })

  it("returns empty string for count 0", () => {
    expect(repeatChar("x", 0)).toBe("")
  })

  it("works with multi-character strings", () => {
    expect(repeatChar("ab", 3)).toBe("ababab")
  })
})
