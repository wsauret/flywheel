import { describe, expect, it } from "bun:test"

import { runToCompletion } from "../../../../src/infra/task-scheduling.js"
import { buildCommittedForkMessagesWork } from "../../../../src/orchestration/session/conversation/conversation-tree-context.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"

let timestamp = 0

function nextTimestamp(): string {
  timestamp += 1
  return new Date(2026, 4, 21, 0, 0, 0, timestamp).toISOString()
}

function message(parentId: string | null, id: string, role: "user" | "assistant", content: string): ConversationEntry {
  return { kind: "message", id, parentId, timestamp: nextTimestamp(), message: { kind: role, content } }
}

function toolCall(parentId: string, id: string, ...toolUseIds: string[]): ConversationEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: nextTimestamp(),
    message: {
      kind: "assistant",
      content: toolUseIds.map((toolUseId) => ({ type: "tool_use" as const, id: toolUseId, name: "test", input: {} })),
    },
  }
}

function toolResult(parentId: string, id: string, toolUseId: string): ConversationEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: nextTimestamp(),
    message: { kind: "toolResult", toolUseId, content: [{ type: "text", text: `${toolUseId} result` }] },
  }
}

function compaction(parentId: string, id: string, sourceLeafId: string): ConversationEntry {
  return {
    kind: "compaction",
    id,
    parentId,
    timestamp: nextTimestamp(),
    summary: "compressed earlier turns",
    retainedMessages: [{ kind: "user", content: "retained turn" }],
    sourceLeafId,
    tokensBefore: 999,
    tokensAfter: 9,
  }
}

function buildCommittedForkMessages(branch: readonly ConversationEntry[]) {
  return runToCompletion(buildCommittedForkMessagesWork(branch))
}

describe("buildCommittedForkMessages", () => {
  it("retains complete earlier exchanges and removes only the open suffix exchange", () => {
    const branch = [
      message(null, "10000001", "user", "first turn"),
      toolCall("10000001", "10000002", "complete"),
      toolResult("10000002", "10000003", "complete"),
      message("10000003", "10000004", "user", "fork turn"),
      toolCall("10000004", "10000005", "fork", "sibling"),
      toolResult("10000005", "10000006", "sibling"),
    ]

    expect(buildCommittedForkMessages(branch)).toEqual([
      { kind: "user", content: "first turn" },
      { kind: "assistant", content: [{ type: "tool_use", id: "complete", name: "test", input: {} }] },
      { kind: "toolResult", toolUseId: "complete", content: [{ type: "text", text: "complete result" }] },
      { kind: "user", content: "fork turn" },
    ])
  })

  it("preserves a fully settled tail", () => {
    const branch = [
      message(null, "20000001", "user", "fork turn"),
      toolCall("20000001", "20000002", "fork", "sibling"),
      toolResult("20000002", "20000003", "sibling"),
      toolResult("20000003", "20000004", "fork"),
    ]

    expect(buildCommittedForkMessages(branch)).toHaveLength(4)
  })

  it("preserves compaction reconstruction while removing a later open exchange", () => {
    const old = message(null, "30000001", "user", "old dropped")
    const source = message("30000001", "30000002", "assistant", "old answer")
    const suffix = message("30000002", "30000003", "user", "source suffix")
    const compacted = compaction("30000003", "30000004", "30000002")
    const after = message("30000004", "30000005", "user", "after compaction")
    const open = toolCall("30000005", "30000006", "fork")

    expect(buildCommittedForkMessages([old, source, suffix, compacted, after, open])).toEqual([
      { kind: "user", content: "retained turn" },
      { kind: "compactionSummary", content: "compressed earlier turns" },
      { kind: "user", content: "source suffix" },
      { kind: "user", content: "after compaction" },
    ])
  })

  it("rejects malformed retained history and malformed open suffixes", () => {
    expect(() => buildCommittedForkMessages([
      message(null, "40000001", "user", "turn"),
      message("40000001", "40000002", "assistant", "first answer"),
      message("40000002", "40000003", "assistant", "second answer"),
    ])).toThrow("adjacent assistant messages")
    expect(() => buildCommittedForkMessages([
      message(null, "50000001", "user", "turn"),
      toolCall("50000001", "50000002", "duplicate", "duplicate"),
    ])).toThrow("duplicate tool_use ids")
    expect(() => buildCommittedForkMessages([
      message(null, "60000001", "user", "turn"),
      toolCall("60000001", "60000002", "fork"),
      toolResult("60000002", "60000003", "unexpected"),
    ])).toThrow("ids do not match")
  })
})
