import { describe, expect, it } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { countFindMatches, findInTranscript } from "../../../../src/orchestration/app-service/transcript-find.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/transcript/branch-history-builder.js"
import type { TranscriptFindRequest } from "../../../../src/protocol/transcript-protocol-types.js"

const text = (id: string, content: string): AnyBlock => ({ kind: "text", id, content, timestamp: 1 })
const user = (id: string, content: string, pending = false): AnyBlock => ({ kind: "userMessage", id, content, timestamp: 1, pending, injected: false })
const thinking = (id: string, content: string): AnyBlock => ({ kind: "thinking", id, content, status: "completed", timestamp: 1 })
const tool = (id: string, content: string): AnyBlock => ({ kind: "tool", id, name: "bash", presentation: { name: "Bash", detail: "ls" }, status: "completed", content, timestamp: 1 })
const card = (id: string, childContent: string): AnyBlock => ({
  kind: "agentGroup", containerKind: "subagent", id, toolUseId: id, label: "Reviewer", description: "check the plan", status: "completed", timestamp: 1, totalToolCount: 1,
  children: [{ kind: "tool", id: `${id}-child`, name: "bash", presentation: { name: "Bash", detail: "" }, status: "completed", content: childContent, timestamp: 1 }],
})

// The find thread runs `countFindMatches`; the test runs it on its own thread.
const find = (blocks: readonly AnyBlock[], request: Partial<TranscriptFindRequest> & Pick<TranscriptFindRequest, "pattern">) =>
  findInTranscript(indexOutputBlocks(blocks), { regex: false, matchCase: false, includeThinking: true, fromBlockIndex: 0, ...request }, async (job) => countFindMatches(job))

describe("findInTranscript", () => {
  it("lists every occurrence in document order with its ordinal in the block, including a tool body a client sees truncated", async () => {
    const result = await find([user("u1", "Find the Needle"), text("a1", "needle and needle"), tool("t1", `${"line\n".repeat(500)}needle`)], { pattern: "needle" })
    expect(result.matches).toEqual([
      { blockId: "userMessage:u1", blockIndex: 0, occurrence: 0 },
      { blockId: "text:a1", blockIndex: 1, occurrence: 0 },
      { blockId: "text:a1", blockIndex: 1, occurrence: 1 },
      { blockId: "tool:t1", blockIndex: 2, occurrence: 0 },
    ])
    expect(result).toMatchObject({ more: false, openFromBlockIndex: 2, blockCount: 3 })
  })

  it("matches case only when asked and reads a regular expression", async () => {
    const blocks = [text("a1", "Needle needle NEEDLE"), text("a2", "error: 42, error: 7")]
    expect((await find(blocks, { pattern: "Needle", matchCase: true })).matches).toHaveLength(1)
    expect((await find(blocks, { pattern: "error: \\d+", regex: true })).matches.map((match) => match.blockId)).toEqual(["text:a2", "text:a2"])
    expect((await find(blocks, { pattern: "error: \\d+" })).matches).toEqual([])
    await expect(find(blocks, { pattern: "(", regex: true })).rejects.toThrow("not a valid regular expression")
  })

  it("skips hidden thinking, queued messages, and the operations of an agent card", async () => {
    const blocks = [thinking("th1", "needle"), card("c1", "needle"), user("u2", "needle", true)]
    expect((await find(blocks, { pattern: "needle", includeThinking: false })).matches).toEqual([])
    expect((await find(blocks, { pattern: "needle" })).matches.map((match) => match.blockId)).toEqual(["thinking:th1"])
    expect((await find(blocks, { pattern: "plan" })).matches.map((match) => match.blockId)).toEqual(["tool:c1"])
  })

  it("stops at the limit and says that more matches exist", async () => {
    const result = await find([text("a1", "x ".repeat(800)), text("a2", "x ".repeat(800))], { pattern: "x" })
    expect(result.matches).toHaveLength(1000)
    expect(result.more).toBe(true)
    expect(result.matches.at(-1)).toEqual({ blockId: "text:a2", blockIndex: 1, occurrence: 199 })
  })

  it("refuses a find while four others still count, and takes finds again once they answer", async () => {
    const held = Promise.withResolvers<readonly number[]>()
    const request = { pattern: "needle", regex: true, matchCase: false, includeThinking: true, fromBlockIndex: 0 }
    const slow = Array.from({ length: 4 }, () => findInTranscript(indexOutputBlocks([text("a1", "needle")]), request, () => held.promise))
    await expect(find([text("a1", "needle")], { pattern: "needle" })).rejects.toThrow("Too many finds are running")
    held.resolve([1])
    await Promise.all(slow)
    expect((await find([text("a1", "needle")], { pattern: "needle" })).matches).toHaveLength(1)
  })

  it("finds from a block on and names the first block that can still change", async () => {
    const running: AnyBlock = { kind: "tool", id: "t2", name: "bash", presentation: { name: "Bash", detail: "make" }, status: "pending", content: "needle", timestamp: 1 }
    const blocks = [user("u1", "needle"), text("a1", "needle"), running, text("a2", "needle"), text("a3", "done")]
    const result = await find(blocks, { pattern: "needle", fromBlockIndex: 1 })
    expect(result.matches.map((match) => match.blockIndex)).toEqual([1, 2, 3])
    expect(result.openFromBlockIndex).toBe(2)
    // With every block settled, only the last block can still grow.
    expect((await find(blocks.filter((block) => block !== running), { pattern: "needle", fromBlockIndex: 3 })).openFromBlockIndex).toBe(3)
  })
})
