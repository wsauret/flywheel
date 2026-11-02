import { describe, expect, it } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { threadHistoryRangeIndices } from "../../../../src/orchestration/session/conversation/branch-history-pagination"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder"

const blocks: AnyBlock[] = [
  { kind: "userMessage", id: "u0", content: "zero", timestamp: 0, pending: false, injected: false },
  { kind: "text", id: "t1", content: "one", timestamp: 1 },
  { kind: "text", id: "t2", content: "two", timestamp: 2 },
  { kind: "system", id: "s3", message: "three", timestamp: 3 },
]
const history = indexOutputBlocks(blocks)

describe("thread history pagination", () => {
  it("selects absolute slots without reading a row", () => {
    const indexed = { blockCount: history.blockCount, indexOf: history.indexOf, indexOfEntry: history.indexOfEntry, readBlock() { throw new Error("Unexpected hydration") } }
    expect(threadHistoryRangeIndices(indexed, { kind: "tail" }, 2).indices).toEqual([2, 3])
  })

  it("centres a window around the block a chat entry produced, whatever suffix its identity carries", () => {
    const parts: AnyBlock[] = [
      { kind: "userMessage", id: "u0", content: "zero", timestamp: 0, pending: false, injected: false },
      { kind: "text", id: "e1:0", content: "one", timestamp: 1 },
      { kind: "text", id: "e1:1", content: "two", timestamp: 2 },
      // A repeated tool use id carries an occurrence suffix; the key is the id before it.
      { kind: "system", id: "tu#2", message: "three", timestamp: 3 },
      { kind: "text", id: "e3", content: "four", timestamp: 4 },
      { kind: "text", id: "e4", content: "five", timestamp: 5 },
      // Entry ids can hold colons: a message from another session takes its
      // delivery key, and a runtime notice its own prefixed key.
      { kind: "userMessage", id: "msg:sender:call_1", content: "six", timestamp: 6, pending: false, injected: false },
      { kind: "userMessage", id: "msg:sender:call_2", content: "seven", timestamp: 7, pending: false, injected: false },
      { kind: "text", id: "workflow-completion:child:0", content: "eight", timestamp: 8 },
    ]
    const indexed = indexOutputBlocks(parts)
    expect(indexed.indexOfEntry("e1")).toBe(1)
    const protectedPage = threadHistoryRangeIndices(indexed, { kind: "residentSpan", blockIds: ["text:e1:1", "text:gone"], candidates: ["text:e1:0"] }, 1)
    expect(protectedPage.indices).toEqual([2])
    expect(protectedPage.membership).toEqual([
      { blockId: "text:e1:1", index: 2 }, { blockId: "text:gone", index: null }, { blockId: "text:e1:0", index: 1 },
    ])
    expect(indexed.indexOfEntry("tu")).toBe(3)
    expect(indexed.indexOfEntry("msg:sender:call_2")).toBe(7)
    expect(indexed.indexOfEntry("workflow-completion:child")).toBe(8)
    expect(threadHistoryRangeIndices(indexed, { kind: "around", entryId: "tu" }, 3).indices).toEqual([2, 3, 4])
    // Near an end the window slides inward rather than shrinking.
    expect(threadHistoryRangeIndices(indexed, { kind: "around", entryId: "u0" }, 3).indices).toEqual([0, 1, 2])
    expect(threadHistoryRangeIndices(indexed, { kind: "around", entryId: "e4" }, 4).indices).toEqual([3, 4, 5, 6])
    // An entry with no block resolves to the tail and says so.
    expect(threadHistoryRangeIndices(indexed, { kind: "around", entryId: "gone" }, 2)).toEqual({ anchor: { kind: "tail" }, indices: [7, 8] })
  })

  it("resolves an in-flight agent group by its provider tool-use id", () => {
    const indexed = indexOutputBlocks([{
      kind: "agentGroup",
      containerKind: "subagent",
      id: "minted-block-id",
      toolUseId: "provider-tool-use-id",
      label: "Explorer",
      description: "Inspect output",
      agentType: "explorer",
      status: "active",
      children: [],
      totalToolCount: 0,
      timestamp: 1,
    }])

    expect(indexed.indexOf("tool:minted-block-id")).toBe(0)
    expect(indexed.indexOfEntry("provider-tool-use-id")).toBe(0)
    expect(threadHistoryRangeIndices(indexed, { kind: "around", entryId: "provider-tool-use-id" }, 1))
      .toEqual({ anchor: { kind: "around", entryId: "provider-tool-use-id" }, indices: [0] })
  })
})
