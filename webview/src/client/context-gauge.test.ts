import { describe, expect, test } from "bun:test"

import { contextGaugeCopy } from "../../../src/protocol/client/context-compaction.js"

describe("contextGaugeCopy", () => {
  test("clamps a session past the cap to a full ring", () => {
    const copy = contextGaugeCopy({ contextPercent: 90, contextPromptTokens: 300_000, compactionThreshold: 270_000 })
    expect(copy.used).toBe(1)
    expect(copy.reading).toBe("0% of context remaining until auto-compact.")
  })
})
