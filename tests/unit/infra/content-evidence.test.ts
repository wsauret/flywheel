import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"

import { contentEvidence, contentEvidenceWork } from "../../../src/infra/content-evidence.js"
import { SLOW_UNIT_BUDGET_MS } from "../../../src/infra/event-loop-lag.js"
import { runInTaskSlices } from "../../../src/infra/task-scheduling.js"

/** The evidence of the whole UTF-8 encoding, measured in one piece. */
function wholeTextEvidence(text: string) {
  const bytes = Buffer.from(text, "utf8")
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), preview: text.length > 240 ? `${text.slice(0, 240)}...` : text }
}

/** Measures text with the cooperative form on a clock that ends the slice after every unit. */
async function measureInSlices(text: string) {
  let clock = 0
  let yields = 0
  const evidence = await runInTaskSlices("test:evidence", contentEvidenceWork(text), {
    now: () => (clock += SLOW_UNIT_BUDGET_MS),
    yieldToNextTask: async () => { yields += 1 },
  })
  return { evidence, yields }
}

describe("contentEvidenceWork", () => {
  it("measures large text in bounded units with the evidence of the whole encoding", async () => {
    const pairs = "\u{1F600}".repeat(1 << 21)
    const texts = [
      // Surrogate pairs at odd offsets put a pair across every even window edge.
      `a${pairs}`,
      pairs,
      `\uD800${"x".repeat(1 << 21)}\uDC00${"\u4E2D".repeat(1 << 20)}\uD83D`,
    ]
    for (const text of texts) {
      const { evidence, yields } = await measureInSlices(text)
      expect(evidence).toEqual(wholeTextEvidence(text))
      expect(contentEvidence(text)).toEqual(evidence)
      expect(yields).toBeGreaterThan(1)
    }
  })

  it("measures empty and small text in one unit", async () => {
    for (const text of ["", "small \uD83D\uDE00 text"]) {
      expect(await measureInSlices(text)).toEqual({ evidence: wholeTextEvidence(text), yields: 0 })
    }
  })
})
