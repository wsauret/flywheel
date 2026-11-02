import { describe, expect, test } from "bun:test"
import { BOLD, STRIKETHROUGH, stStrike } from "../../../../src/tui/utils/text-attributes.js"

describe("text-attributes", () => {
  test("stStrike preserves existing chunk attributes", () => {
    const chunk = { __isChunk: true, text: "Interrupted", attributes: BOLD } as const
    const struck = stStrike(chunk)
    expect(struck.text).toBe("Interrupted")
    expect((struck.attributes ?? 0) & BOLD).toBe(BOLD)
    expect((struck.attributes ?? 0) & STRIKETHROUGH).toBe(STRIKETHROUGH)
  })
})
