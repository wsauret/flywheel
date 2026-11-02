import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { applyOutputDelta, buildBlockIndex, mergeAgentGroupChildren, outputDeltaBytes, type MutableOutputView } from "../../../src/protocol/client/transcript-delta.js"

function child(id: string, status: "pending" | "streaming" | "completed" | "interrupted" = "completed"): FrontendToolEntry {
  return { kind: "tool", id, name: "read", presentation: { name: "Read", detail: `${id}.ts` }, status, timestamp: 1 }
}

function agentGroup(children: FrontendToolEntry[], totalToolCount: number, status: "active" | "completed" | "error" = "active"): FrontendOutputBlock {
  const base = {
    kind: "agentGroup" as const,
    containerKind: "subagent" as const,
    id: "agent-1",
    toolUseId: "tu-agent-1",
    label: "Explorer",
    description: "Searching",
    children,
    totalToolCount,
    timestamp: 1,
  }
  return status === "error"
    ? { ...base, status, failure: { title: "Subagent failed", message: "Request failed", guidance: "Retry." } }
    : { ...base, status }
}

describe("mergeAgentGroupChildren", () => {
  it("lets incoming children win on id match (they carry status updates)", () => {
    const merged = mergeAgentGroupChildren([child("c0"), child("c1", "pending")], [child("c1", "completed"), child("c2")])
    expect(merged.map((item) => item.id)).toEqual(["c0", "c1", "c2"])
    expect(merged[1]?.status).toBe("completed")
  })

  it("returns the incoming tail as-is when nothing is resident", () => {
    expect(mergeAgentGroupChildren([], [child("c0")]).map((item) => item.id)).toEqual(["c0"])
  })
})

describe("applyOutputDelta agent-group upsert merge", () => {
  it("merges a bounded tail into the resident group instead of replacing its children", () => {
    const resident = agentGroup([child("c0"), child("c1", "pending")], 2)
    const view: MutableOutputView = { blocks: [resident], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)

    const incoming = agentGroup([child("c1", "completed"), child("c2")], 3)
    const ok = applyOutputDelta(view, { blocks: [{ kind: "upsert", index: 0, blockId: "tool:agent-1", block: incoming }] }, blockIndex)

    expect(ok).toBe(true)
    const merged = view.blocks[0]
    if (merged?.kind !== "agentGroup") throw new Error("expected agent group")
    expect(merged.children.map((item) => item.id)).toEqual(["c0", "c1", "c2"])
    expect(merged.children[1]?.status).toBe("completed")
    expect(merged.totalToolCount).toBe(3)
  })

  it("splices a mid-list insert and re-homes displaced identities", () => {
    // The interrupting user-message shape: a block lands mid-list and every
    // later block shifts up one slot. The wire ships ONE insert; the splice
    // re-homes the displaced identities in the index map.
    const shifted: MutableOutputView["blocks"][number] = { kind: "userMessage", id: "m1", content: "steer", timestamp: 1, pending: true, injected: false }
    const inserted: MutableOutputView["blocks"][number] = { kind: "text", id: "t2", content: "tool output", timestamp: 2 }
    const view: MutableOutputView = { blocks: [shifted], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const ok = applyOutputDelta(view, { blocks: [
      { kind: "insert", index: 0, blockId: "text:t2", block: inserted },
    ] }, blockIndex)
    expect(ok).toBe(true)
    expect(view.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["t2", "m1"])
    // The index map must keep the re-homed identity: a later append-content
    // addressed to it must still resolve.
    expect(blockIndex.get("userMessage:m1")).toBe(1)
    expect(blockIndex.get("text:t2")).toBe(0)
  })

  it("degrades a redelivered insert to an in-place refresh", () => {
    // Recovery-seam replay: the seed already contains the inserted block, so
    // the replayed insert must not splice a duplicate. Identity, not index,
    // is the idempotency key.
    const resident: MutableOutputView["blocks"][number] = { kind: "text", id: "t2", content: "tool output", timestamp: 2 }
    const tail: MutableOutputView["blocks"][number] = { kind: "userMessage", id: "m1", content: "steer", timestamp: 1, pending: true, injected: false }
    const view: MutableOutputView = { blocks: [resident, tail], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const ok = applyOutputDelta(view, { blocks: [
      { kind: "insert", index: 0, blockId: "text:t2", block: resident },
    ] }, blockIndex)
    expect(ok).toBe(true)
    expect(view.blocks).toHaveLength(2)
    expect(blockIndex.get("text:t2")).toBe(0)
    expect(blockIndex.get("userMessage:m1")).toBe(1)
  })

  it("fails an insert whose coordinate falls outside the resident window", () => {
    // Inserts land in the live tail region, which a seeded window contains; a
    // below-window or past-end coordinate is a coordinate-space disagreement.
    const view: MutableOutputView = { blocks: [{ kind: "text", id: "t1", content: "x", timestamp: 1 }], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const inserted: MutableOutputView["blocks"][number] = { kind: "text", id: "t2", content: "y", timestamp: 2 }
    expect(applyOutputDelta(view, { blocks: [{ kind: "insert", index: 5, blockId: "text:t2", block: inserted }] }, blockIndex, 10)).toBe(false)
    expect(applyOutputDelta(view, { blocks: [{ kind: "insert", index: 13, blockId: "text:t2", block: inserted }] }, blockIndex, 10)).toBe(false)
  })

  it("fails a bare upsert that overwrites a different resident identity (coordinate drift)", () => {
    // A rebased shell publishes upserts whose absolute indexes land inside a
    // stale resident window. Identity-destroying writes only arrive as
    // inserts or truncate repaves, so the delta must fail and route to
    // bounded recovery instead of silently corrupting the window.
    const view: MutableOutputView = { blocks: [{ kind: "text", id: "t1", content: "x", timestamp: 1 }], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const drifted = applyOutputDelta(view, { blocks: [
      { kind: "upsert", index: 0, blockId: "text:t2", block: { kind: "text", id: "t2", content: "y", timestamp: 2 } },
    ] }, blockIndex)
    expect(drifted).toBe(false)
  })

  it("applies the question that replaces a streaming ask_user row as an in-place upsert", () => {
    // The runtime swaps the provisional tool row for the question at the same
    // index with a bare upsert. Both key to tool:<toolUseId>, so the resident
    // row refreshes instead of tripping the coordinate-drift verdict (which
    // blanked the transcript behind every question).
    const provisional: FrontendToolEntry = { kind: "tool", id: "ask-1", name: "ask_user", presentation: { name: "Ask User", detail: "" }, status: "streaming", timestamp: 1 }
    const view: MutableOutputView = { blocks: [{ kind: "text", id: "t1", content: "x", timestamp: 1 }, provisional], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const question: FrontendOutputBlock = { kind: "question", toolUseId: "ask-1", questions: [], timestamp: 2 }
    expect(applyOutputDelta(view, { blocks: [{ kind: "upsert", index: 1, blockId: "tool:ask-1", block: question }] }, blockIndex)).toBe(true)
    expect(view.blocks[1]).toEqual(question)
    expect(blockIndex.get("tool:ask-1")).toBe(1)
    expect(blockIndex.size).toBe(2)
  })

  it("allows identity rewrites under a structural truncate", () => {
    const view: MutableOutputView = { blocks: [{ kind: "text", id: "t1", content: "x", timestamp: 1 }], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)
    const ok = applyOutputDelta(view, { truncateTo: 0, blocks: [
      { kind: "upsert", index: 0, blockId: "text:t2", block: { kind: "text", id: "t2", content: "y", timestamp: 2 } },
    ] }, blockIndex)
    expect(ok).toBe(true)
    expect(view.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["t2"])
  })
})

describe("applyOutputDelta block edits", () => {
  const streamingBash = (detail: string): FrontendToolEntry => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status: "streaming", timestamp: 1 })

  it("an edit gives the block that an upsert of the edited copy would give", () => {
    const edited: MutableOutputView = { blocks: [streamingBash("cat <<EOF")], streamingToolText: {} }
    const upserted: MutableOutputView = { blocks: [streamingBash("cat <<EOF")], streamingToolText: {} }
    const replaced: string[] = []
    expect(applyOutputDelta(edited, { blocks: [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 9, text: "\nhello" }] }] }, buildBlockIndex(edited.blocks), 0, (localIndex, _prior, _next, appended) => { replaced.push(`${localIndex}:${appended}`) })).toBe(true)
    expect(applyOutputDelta(upserted, { blocks: [{ kind: "upsert", index: 0, blockId: "tool:call-1", block: streamingBash("cat <<EOF\nhello") }] }, buildBlockIndex(upserted.blocks))).toBe(true)
    expect(edited.blocks).toEqual(upserted.blocks)
    expect(replaced).toEqual(["0:"])
  })

  it("an edit against another base is rejected as a divergence", () => {
    const view: MutableOutputView = { blocks: [streamingBash("ls")], streamingToolText: {} }
    let reason: string | undefined
    expect(applyOutputDelta(view, { blocks: [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 9, text: "x" }] }] }, buildBlockIndex(view.blocks), 0, undefined, (failure) => { reason = failure.reason })).toBe(false)
    expect(reason).toBe("edit-rejected")
  })

  it("an edit before the resident window is skipped, and one to a block the window lacks is rejected", () => {
    const view: MutableOutputView = { blocks: [streamingBash("ls")], streamingToolText: {} }
    const edit = (index: number) => ({ blocks: [{ kind: "edit" as const, index, blockId: "tool:older", edits: [{ kind: "assign" as const, path: ["status"], value: "completed" }] }] })
    expect(applyOutputDelta(view, edit(3), buildBlockIndex(view.blocks), 10)).toBe(true)
    expect(view.blocks).toEqual([streamingBash("ls")])
    let reason: string | undefined
    expect(applyOutputDelta(view, edit(10), buildBlockIndex(view.blocks), 10, undefined, (failure) => { reason = failure.reason })).toBe(false)
    expect(reason).toBe("edit-missing-block")
  })

  it("an edit after a read that ran ahead past an unpublished insert applies by block id", () => {
    const inserted: FrontendOutputBlock = { kind: "text", id: "t-ahead", content: "read ahead", timestamp: 1 }
    const view: MutableOutputView = { blocks: [inserted, streamingBash("ls")], streamingToolText: {} }
    expect(applyOutputDelta(view, { blocks: [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 2, text: " -la" }] }] }, buildBlockIndex(view.blocks))).toBe(true)
    expect(view.blocks).toEqual([inserted, streamingBash("ls -la")])
  })

  it("an edit whose result has an invalid shape is rejected", () => {
    const view: MutableOutputView = { blocks: [streamingBash("ls")], streamingToolText: {} }
    let reason: string | undefined
    expect(applyOutputDelta(view, { blocks: [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "assign", path: ["status"], value: "exploded" }] }] }, buildBlockIndex(view.blocks), 0, undefined, (failure) => { reason = failure.reason })).toBe(false)
    expect(reason).toBe("edit-invalid-shape")
    expect(view.blocks).toEqual([streamingBash("ls")])
  })

  it("accounts for an edit by the bytes it carries", () => {
    expect(outputDeltaBytes({ blocks: [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 0, text: "é😀" }] }] })).toBe(new TextEncoder().encode("é😀").byteLength)
  })
})

describe("foldAgentGroupBlock straggler settlement", () => {
  it("settles resident children older than the wire tail when the group completes", () => {
    // c0 settled while already outside the 8-child tail: its settle patch
    // never shipped. The terminal upsert must resolve it client-side.
    const resident = agentGroup([child("c0", "pending"), child("c1", "pending")], 2)
    const view: MutableOutputView = { blocks: [resident], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)

    const incoming = agentGroup([child("c1", "completed"), child("c2")], 3, "completed")
    expect(applyOutputDelta(view, { blocks: [{ kind: "upsert", index: 0, blockId: "tool:agent-1", block: incoming }] }, blockIndex)).toBe(true)

    const merged = view.blocks[0]
    if (merged?.kind !== "agentGroup") throw new Error("expected agent group")
    expect(merged.children.map((item) => item.status)).toEqual(["completed", "completed", "completed"])
  })

  it("leaves in-flight children pending while the group is still active", () => {
    const resident = agentGroup([child("c0", "pending")], 1)
    const view: MutableOutputView = { blocks: [resident], streamingToolText: {} }
    const blockIndex = buildBlockIndex(view.blocks)

    const incoming = agentGroup([child("c1", "pending")], 2)
    expect(applyOutputDelta(view, { blocks: [{ kind: "upsert", index: 0, blockId: "tool:agent-1", block: incoming }] }, blockIndex)).toBe(true)

    const merged = view.blocks[0]
    if (merged?.kind !== "agentGroup") throw new Error("expected agent group")
    expect(merged.children.map((item) => item.status)).toEqual(["pending", "pending"])
  })
})

describe("proposed file body deltas", () => {
  it("accounts for preview-check text as exact UTF-8 bytes", () => {
    const previewCheck = "Review é😀"
    const delta = { blocks: [], streamingToolTextOps: [{ toolUseId: "edit", kind: "set" as const, entry: { previewCheck } }] }
    expect(outputDeltaBytes(delta)).toBe(new TextEncoder().encode("edit").byteLength + new TextEncoder().encode(previewCheck).byteLength)
  })

  it("extends a resident entry by an append edit and keeps untouched entries by identity", () => {
    const other = { content: "other" }
    const view: MutableOutputView = { blocks: [], streamingToolText: { w: { content: "ab", filetype: "ts" }, o: other } }
    const before = view.streamingToolText
    expect(applyOutputDelta(view, { blocks: [], streamingToolTextOps: [{ toolUseId: "w", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 2, text: "cd" }] }] }, new Map())).toBe(true)
    expect(view.streamingToolText).not.toBe(before)
    expect(view.streamingToolText.w).toEqual({ content: "abcd", filetype: "ts" })
    expect(view.streamingToolText.o).toBe(other)
  })

  it("treats a redelivered append as idempotent and leaves the map identity alone", () => {
    const view: MutableOutputView = { blocks: [], streamingToolText: { w: { content: "abcd" } } }
    const before = view.streamingToolText
    expect(applyOutputDelta(view, { blocks: [], streamingToolTextOps: [{ toolUseId: "w", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 2, text: "cd" }] }] }, new Map())).toBe(true)
    expect(view.streamingToolText).toBe(before)
  })

  it("fails an append past the resident end, to an entry the client does not hold, or to a value that is not text", () => {
    const gap: MutableOutputView = { blocks: [], streamingToolText: { w: { content: "ab" } } }
    expect(applyOutputDelta(gap, { blocks: [], streamingToolTextOps: [{ toolUseId: "w", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 5, text: "x" }] }] }, new Map())).toBe(false)
    const absent: MutableOutputView = { blocks: [], streamingToolText: {} }
    expect(applyOutputDelta(absent, { blocks: [], streamingToolTextOps: [{ toolUseId: "w", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 0, text: "x" }] }] }, new Map())).toBe(false)
    const proposal: MutableOutputView = { blocks: [], streamingToolText: { w: { proposedDiff: { files: [], unavailable: "malformed" } } } }
    expect(applyOutputDelta(proposal, { blocks: [], streamingToolTextOps: [{ toolUseId: "w", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 0, text: "x" }] }] }, new Map())).toBe(false)
  })

  it("accounts for appended text as exact UTF-8 bytes", () => {
    const delta = { blocks: [], streamingToolTextOps: [{ toolUseId: "edit", kind: "edit" as const, edits: [{ kind: "append" as const, path: ["content"], offset: 0, text: "é😀" }] }] }
    expect(outputDeltaBytes(delta)).toBe(new TextEncoder().encode("edit").byteLength + new TextEncoder().encode("é😀").byteLength)
  })

})
