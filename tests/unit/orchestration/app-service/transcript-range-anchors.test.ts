import { expect, it } from "bun:test"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import type { OutputRangeRequest } from "../../../../src/protocol/transcript-protocol-types.js"
import { outputSeamBlocks } from "../runner/_output-session-fixtures.js"

it("asserts every range anchor against one absolute sequence", async () => {
  const blocks = outputSeamBlocks()
  const consistencyToken = "sequence:v1"

  const rangeCases: readonly [OutputRangeRequest, readonly [number, number], OutputRangeRequest["anchor"]][] = [
    [{ anchor: { kind: "tail" }, maxBlocks: 4, maxBytes: 4096 }, [7, 10], { kind: "tail" }],
    [{ anchor: { kind: "beforeBlock", blockId: "tool:tool-error" }, maxBlocks: 3, maxBytes: 4096 }, [3, 5], { kind: "beforeBlock", blockId: "tool:tool-error" }],
    [{ anchor: { kind: "afterBlock", blockId: "tool:tool-error" }, maxBlocks: 3, maxBytes: 4096 }, [5, 7], { kind: "afterBlock", blockId: "tool:tool-error" }],
    [{ anchor: { kind: "afterBlock", blockId: "tool:vanished" }, maxBlocks: 4, maxBytes: 4096 }, [7, 10], { kind: "tail" }],
    [{ anchor: { kind: "around", entryId: "tool-error" }, maxBlocks: 3, maxBytes: 1 }, [5, 5], { kind: "around", entryId: "tool-error" }],
    [{ anchor: { kind: "around", entryId: "system-error" }, maxBlocks: 4, maxBytes: 1 }, [10, 10], { kind: "around", entryId: "system-error" }],
    [{ anchor: { kind: "around", entryId: "tool-error" }, maxBlocks: 3, maxBytes: 4096 }, [4, 6], { kind: "around", entryId: "tool-error" }],
    [{ anchor: { kind: "around", entryId: "vanished" }, maxBlocks: 4, maxBytes: 4096 }, [7, 10], { kind: "tail" }],
  ]
  for (const [request, expected, served] of rangeCases) {
    const actual = await hydrateDerivedOutputRange({ ...indexOutputBlocks(blocks), consistencyToken }, request)
    if (actual.kind !== "ok") throw new Error(`expected ${request.anchor.kind} range`)
    expect([actual.window.startBlockIndex, actual.window.endBlockIndex], request.anchor.kind).toEqual([...expected])
    expect(actual.consistencyToken).toBe(consistencyToken)
    expect(actual.anchor).toEqual(served)
    expect(actual.blocks.map(blockIdentity)).toEqual(blocks.slice(expected[0], expected[1] + 1).map(blockIdentity))
  }
})
