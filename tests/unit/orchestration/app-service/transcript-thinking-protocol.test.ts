import { describe, expect, it } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { applyOutputDelta, buildBlockIndex } from "../../../../src/protocol/client/transcript-delta.js"

const settled: AnyBlock = { kind: "thinking", id: "t-1", content: "an earlier thought", status: "completed", timestamp: 1, completedAt: 2 }
const streaming: AnyBlock = { kind: "thinking", id: "t-2", content: "the model is still", status: "streaming", timestamp: 3 }

async function tail(includeThinkingContent: boolean) {
  const history = { ...indexOutputBlocks([settled, streaming]), consistencyToken: "sequence:v1" }
  const range = await hydrateDerivedOutputRange(history, { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 32_768, includeThinkingContent })
  if (range.kind !== "ok") throw new Error("expected a tail range")
  return range
}

describe("thinking content in transcript reads", () => {
  it("omits settled thinking content on request and keeps the thought still streaming", async () => {
    const range = await tail(false)
    expect(range.blocks.map((block) => block.kind === "thinking" ? block.content : "")).toEqual(["", "the model is still"])
  })

  it("lets a live append continue a thought read mid-stream with thinking hidden", async () => {
    const range = await tail(false)
    const view = { blocks: [...range.blocks], streamingToolText: {} }
    const applied = applyOutputDelta(view, {
      blocks: [{ kind: "append-content", index: 1, blockId: "thinking:t-2", contentOffset: "the model is still".length, text: " thinking" }],
    }, buildBlockIndex(view.blocks), 0)
    expect(applied).toBe(true)
    expect(view.blocks[1]).toMatchObject({ content: "the model is still thinking" })
  })
})
