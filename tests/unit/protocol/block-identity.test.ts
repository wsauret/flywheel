import { describe, expect, it } from "bun:test"
import type { AnyBlock } from "@infra/output-blocks"
import { blockIdentity, rawToolUseId } from "../../../src/protocol/block-identity.js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"

// blockIdentity is the single key the unified transcript list, the render <Index>,
// the expansion set, the durable chunk address, and the page cursor all share. The
// invariants that matter: every kind resolves to a stable string, the live
// (FrontendOutputBlock) and durable (AnyBlock) shapes resolve IDENTICALLY for the
// same block, and the id never depends on array position.

const samples: ReadonlyArray<{ block: AnyBlock; expected: string }> = [
  { block: { kind: "text", id: "t1", content: "hi", timestamp: 1 }, expected: "text:t1" },
  { block: { kind: "thinking", id: "k1", content: "...", status: "completed", timestamp: 1 }, expected: "thinking:k1" },
  { block: { kind: "tool", id: "tool-abc", name: "bash", presentation: { name: "Bash", detail: "ls" }, timestamp: 1, status: "completed" }, expected: "tool:tool-abc" },
  { block: { kind: "agentGroup", containerKind: "subagent", id: "agent-1", label: "L", description: "D", status: "completed", children: [], timestamp: 1, toolUseId: "tool-agent-1", totalToolCount: 0 }, expected: "tool:agent-1" },
  { block: { kind: "system", id: "s1", message: "m", timestamp: 1 }, expected: "system:s1" },
  { block: { kind: "divider", id: "sb1", label: "step", timestamp: 1 }, expected: "divider:sb1" },
  { block: { kind: "userMessage", id: "u1", content: "hello", timestamp: 1, pending: false, injected: false }, expected: "userMessage:u1" },
  { block: { kind: "question", toolUseId: "q1", questions: [], timestamp: 1 }, expected: "tool:q1" },
]

describe("blockIdentity", () => {
  it("resolves every block kind to its stable id key", () => {
    for (const { block, expected } of samples) expect(blockIdentity(block)).toBe(expected)
  })

  it("computes the same id for the live (FrontendOutputBlock) and durable (AnyBlock) shapes", () => {
    // The two layers must agree, or a resumed durable block and its live counterpart
    // would key to different slots in the unified list.
    const durable: AnyBlock = { kind: "userMessage", id: "u9", content: "x", timestamp: 1, pending: false, injected: false }
    const live: FrontendOutputBlock = { kind: "userMessage", id: "u9", content: "x", timestamp: 1, pending: false, injected: false }
    expect(blockIdentity(live)).toBe(blockIdentity(durable))
    expect(blockIdentity(live)).toBe("userMessage:u9")
  })

  it("keys a question by its ask_user call, so the provisional tool row and the question are one identity", () => {
    // The runtime replaces the streaming ask_user row with the question in
    // place. Clients accept that upsert only because the identity is stable.
    const provisional: AnyBlock = { kind: "tool", id: "ask-1", name: "ask_user", presentation: { name: "Ask User", detail: "" }, timestamp: 1, status: "streaming" }
    const question: AnyBlock = { kind: "question", toolUseId: "ask-1", questions: [], timestamp: 2 }
    expect(blockIdentity(question)).toBe(blockIdentity(provisional))
  })

})

describe("rawToolUseId", () => {
  it("names the tool use of a duplicate occurrence and of a subagent card's row, by id or identity", () => {
    expect(rawToolUseId("toolu_dup")).toBe("toolu_dup")
    expect(rawToolUseId("toolu_dup#2")).toBe("toolu_dup")
    expect(rawToolUseId("call_child#call_card")).toBe("call_child")
    expect(rawToolUseId("tool:call_child#call_card")).toBe(blockIdentity({ kind: "tool", id: "call_child" }))
  })
})
