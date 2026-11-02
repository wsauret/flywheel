import { describe, expect, test } from "bun:test"

import type { SessionRuntimeFact } from "../../../src/infra/runtime-fact-types"
import { extractToolContentFact } from "../../../src/infra/tool-content-extraction"

const LARGE_TEXT = "captured tool output line\n".repeat(200)

describe("extractToolContentFact", () => {
  test("identical texts in two fields share one content row", () => {
    const fact: SessionRuntimeFact = {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "t1",
        outcome: "ok",
        content: LARGE_TEXT,
        details: { displayContent: LARGE_TEXT },
        parentToolUseId: "parent-1",
      },
    }

    expect(extractToolContentFact(fact).contentRows).toHaveLength(1)
  })

})
