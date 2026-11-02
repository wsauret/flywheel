import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { extractContent, TOOL_CONTENT_INLINE_MAX_BYTES } from "../../../src/infra/tool-content.js"

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

describe("extractContent", () => {
  test("text at the inline threshold stays inline", () => {
    const text = "a".repeat(TOOL_CONTENT_INLINE_MAX_BYTES)
    expect(extractContent(text)).toEqual({ kind: "inline", text })
  })

  test("one byte over the threshold becomes a reference plus its content row", () => {
    const text = "a".repeat(TOOL_CONTENT_INLINE_MAX_BYTES + 1)

    const extracted = extractContent(text)

    if (extracted.kind !== "reference") throw new Error("expected a reference")
    expect(extracted.reference).toEqual({
      sha256: sha256Of(text),
      bytes: TOOL_CONTENT_INLINE_MAX_BYTES + 1,
      preview: `${text.slice(0, 240)}...`,
    })
    expect(extracted.row).toEqual({
      sha256: sha256Of(text),
      content: text,
      bytes: TOOL_CONTENT_INLINE_MAX_BYTES + 1,
    })
  })

  test("the threshold measures UTF-8 bytes, not characters", () => {
    // Two-byte characters: half the threshold in characters plus one crosses
    // it in bytes while staying far under it in character count.
    const text = "é".repeat(TOOL_CONTENT_INLINE_MAX_BYTES / 2 + 1)

    const extracted = extractContent(text)

    if (extracted.kind !== "reference") throw new Error("expected a reference")
    expect(extracted.row.bytes).toBe(Buffer.byteLength(text))
    expect(extracted.reference.sha256).toBe(sha256Of(text))
  })
})
