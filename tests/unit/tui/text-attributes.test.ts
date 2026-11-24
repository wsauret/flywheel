import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { BOLD, stStrike } from "../../../src/tui/text-attributes.js"

describe("text-attributes", () => {
  test("stStrike preserves existing chunk attributes", () => {
    const chunk = { __isChunk: true, text: "Interrupted", attributes: BOLD } as const
    const struck = stStrike(chunk)
    expect(struck.text).toBe("Interrupted")
    expect((struck.attributes ?? 0) & BOLD).toBe(BOLD)
    expect((struck.attributes ?? 0) & TextAttributes.STRIKETHROUGH).toBe(TextAttributes.STRIKETHROUGH)
  })
})
