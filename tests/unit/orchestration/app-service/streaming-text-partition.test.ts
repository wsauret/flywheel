import { describe, expect, test } from "bun:test"
import type { StreamingToolTextOp } from "../../../../src/infra/output/output-block-delta.js"
import { partitionStreamingTextDelta } from "../../../../src/orchestration/app-service/streaming-text-partition.js"
import { applyStreamingToolTextOps } from "../../../../src/protocol/client/streaming-text-edits.js"
import type { OutputDelta, OutputView } from "../../../../src/protocol/output-protocol-types.js"

/** What a client holds after it applies every part in order. */
function applied(parts: readonly OutputDelta[], start: OutputView["streamingToolText"] = {}): OutputView["streamingToolText"] | null {
  let held: OutputView["streamingToolText"] | null = start
  for (const part of parts) held &&= applyStreamingToolTextOps(held, part.streamingToolTextOps ?? [])
  return held
}

describe("partitionStreamingTextDelta", () => {
  test.each([["ascii", "x".repeat(9000)], ["multibyte", "界".repeat(3000) + "🙂".repeat(500)]])("splits a long %s text into bounded parts that rebuild it exactly", (_kind, content) => {
    const ops: StreamingToolTextOp[] = [{ kind: "set", toolUseId: "bash-1", entry: { content } }]
    const delta: OutputDelta = { visibleMessageCount: 4, truncateTo: 2, blocks: [{ kind: "append-content", index: 2, blockId: "text:a", contentOffset: 0, text: "hi" }], streamingToolTextOps: ops }
    const parts = partitionStreamingTextDelta(delta)

    expect(parts.length).toBeGreaterThan(1)
    // The structure rides on the first part alone.
    expect(parts[0]).toMatchObject({ visibleMessageCount: 4, truncateTo: 2, blocks: delta.blocks })
    expect(parts.slice(1).every((part) => part.blocks.length === 0 && part.truncateTo === undefined && part.visibleMessageCount === undefined)).toBe(true)
    for (const part of parts) expect(Buffer.byteLength(JSON.stringify(part.streamingToolTextOps), "utf8")).toBeLessThanOrEqual(2048 + 256)
    expect(applied(parts)).toEqual({ "bash-1": { content } })
  })

  test("splits a long append at its offset and leaves small changes in one part", () => {
    const start = { "bash-1": { content: "head" } }
    const text = "y".repeat(5000)
    const parts = partitionStreamingTextDelta({ blocks: [], streamingToolTextOps: [
      { kind: "edit", toolUseId: "bash-1", edits: [{ kind: "append", path: ["content"], offset: 4, text }] },
      { kind: "set", toolUseId: "read-1", entry: { content: "small" } },
    ] })
    expect(parts.length).toBeGreaterThan(2)
    expect(applied(parts, start)).toEqual({ "bash-1": { content: `head${text}` }, "read-1": { content: "small" } })

    const small: OutputDelta = { blocks: [], streamingToolTextOps: [{ kind: "set", toolUseId: "read-1", entry: { content: "small" } }] }
    expect(partitionStreamingTextDelta(small)).toEqual([small])
  })

  test("leaves a delta with no streaming changes whole", () => {
    const structural: OutputDelta = { visibleMessageCount: 1, truncateTo: 0, blocks: [{ kind: "upsert", index: 0, blockId: "text:a", block: { kind: "text", id: "a", content: "z".repeat(9000), timestamp: 1 } }] }
    expect(partitionStreamingTextDelta(structural)).toEqual([structural])
  })
})
