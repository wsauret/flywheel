import { describe, expect, it } from "bun:test"
import type { MessageEntry, ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { buildBranchHistoryFromEntries, buildBranchHistoryTailFromEntries, BranchHistoryBuilder } from "../../../../src/orchestration/session/conversation/branch-history-builder"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff"
import { buildMutationDiffEntries } from "../../../../src/infra/mutation-diff-evidence"
import { buildMutationEvidence, readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence"
import { sessionContentFixture } from "../../../helpers/session-content"
import { readSessionContentRange } from "../../../../src/infra/session-content"

const CWD = "/scratch/project"
const T0 = "2026-07-02T10:00:00.000Z"

function message(id: string, parentId: string | null, entryMessage: MessageEntry["message"]): MessageEntry {
  return { id, parentId, timestamp: T0, kind: "message", message: entryMessage }
}

describe("BranchHistoryBuilder", () => {
  it("folds user, assistant, tool, and compaction entries in tree order with stable ids", () => {
    const entries: ConversationEntry[] = [
      message("u1", null, { kind: "user", content: "run it" }),
      message("a1", "u1", {
        kind: "assistant",
        content: [
          { type: "text", text: "Running." },
          { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo ok" } },
        ],
      }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_1", content: [{ type: "text", text: "ok" }] }),
      { id: "c1", parentId: "r1", timestamp: T0, kind: "compaction", summary: "summary", retainedMessages: [], sourceLeafId: "r1", tokensBefore: 100, tokensAfter: 10 },
    ]

    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    for (const entry of entries) builder.add(entry)
    const history = builder.finish()

    expect(history.tipEntryId).toBe("c1")
    expect(history.consistencyToken).toBe("chat-tree:v1:c1")
    expect(history.blocks.map((block) => block.kind)).toEqual(["userMessage", "text", "tool", "system"])
    expect(history.blocks.map((block) => "id" in block ? block.id : undefined)).toEqual(["u1", "a1:0", "toolu_1", "c1"])
    const tool = history.blocks[2]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.status).toBe("completed")
  })

  it("matches the batch fold after every supported entry kind is added incrementally", () => {
    const entries: ConversationEntry[] = [
      message("u1", null, { kind: "user", content: "inspect" }),
      message("a1", "u1", { kind: "assistant", content: [
        { type: "reasoning", id: "rs_all", encrypted_content: "ciphertext" },
        { type: "text", text: "Working." },
        { type: "thinking", thinking: "chain" },
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "tool_use", id: "toolu_all", name: "bash", input: { command: "echo ok" } },
      ] }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_all", content: [{ type: "text", text: "ok" }] }),
      message("s1", "r1", { kind: "system", content: "system" }),
      message("cs1", "s1", { kind: "compactionSummary", content: "summary" }),
      { id: "c1", parentId: "cs1", timestamp: T0, kind: "compaction", summary: "summary", retainedMessages: [], sourceLeafId: "cs1", tokensBefore: 100, tokensAfter: 10 },
      { id: "b1", parentId: "c1", timestamp: T0, kind: "branch_summary", fromId: "u1", summary: "branch" },
      { id: "l1", parentId: "b1", timestamp: T0, kind: "label", targetId: "b1", label: "saved" },
      { id: "i1", parentId: "l1", timestamp: T0, kind: "session_info", name: "session" },
      { id: "leaf1", parentId: "i1", timestamp: T0, kind: "leaf", targetId: "i1" },
    ]
    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    expect(builder.snapshot()).toEqual({ blocks: [], consistencyToken: "chat-tree:v1:root", tipEntryId: null })

    for (const entry of entries) {
      builder.add(entry)
      const prefix = entries.slice(0, entries.indexOf(entry) + 1)
      expect(builder.snapshot()).toEqual(buildBranchHistoryFromEntries(prefix, { executionCwd: CWD }))
    }
  })

  it("keeps a review notice one system block that carries its skill mutations", async () => {
    const { stage, read } = sessionContentFixture()
    const mutation = buildMutationDiff([
      { path: "SKILL.md", before: { kind: "absent" }, after: { kind: "text", text: "body\n" } },
    ])
    const files = await buildMutationDiffEntries(mutation, "review", stage)
    const mutationEvidence = await buildMutationEvidence(["created", "support_file"].flatMap(action => files.map(entry => entry.kind === "display"
      ? { ...entry, file: { ...entry.file, name: "new-package", action, reach: "project" } } : entry)), stage)
    const entries: ConversationEntry[] = [
      message("s1", null, { kind: "system", content: "Created skill: `new-package`.", mutationEvidence }),
    ]

    const history = buildBranchHistoryFromEntries(entries, { executionCwd: CWD })
    const block = history.blocks[0]
    if (block?.kind !== "system") throw new Error("expected system block")
    expect(history.blocks).toHaveLength(1)
    expect(block.mutationEvidence).toEqual(mutationEvidence)
    const page = await readMutationEvidenceFiles(block.mutationEvidence!, 0, 10, read)
    expect(page).toMatchObject({
      kind: "available", nextOffset: null, files: [
        { kind: "display", file: { path: "SKILL.md", name: "new-package", action: "created", reach: "project" } },
        { kind: "display", file: { path: "SKILL.md", name: "new-package", action: "support_file", reach: "project" } },
      ],
    })
    if (page.kind !== "available") throw new Error("expected notice files")
    for (const file of page.files) {
      if (file.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch")
      const range = await readSessionContentRange(file.file.patch.reference, 0, 4096, read)
      if (range.kind !== "available") throw new Error("expected patch bytes")
      expect(range.nextOffset).toBeNull()
      expect(Buffer.from(range.base64, "base64").toString()).toBe(mutation.files[0]!.unifiedDiff)
    }
    // Grouping is unchanged: the counting mirror still sees exactly one block.
    expect(buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 10)).toEqual({ blocks: history.blocks, blockCount: 1 })
  })

  it("pairs tools across snapshots and keeps prior snapshots immutable", () => {
    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    builder.add(message("a1", null, { kind: "assistant", content: [
      { type: "text", text: "hello " },
      { type: "tool_use", id: "toolu_snap", name: "bash", input: { command: "echo ok" } },
    ] }))
    const beforeResult = builder.snapshot()
    builder.add(message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_snap", content: [{ type: "text", text: "ok" }] }))
    const afterResult = builder.snapshot()

    expect(beforeResult.blocks[1]).toMatchObject({ kind: "tool", status: "interrupted" })
    expect(afterResult.blocks[1]).toMatchObject({ kind: "tool", status: "completed" })
    builder.add(message("a2", "r1", { kind: "assistant", content: "world" }))
    expect(afterResult.blocks).toHaveLength(2)
  })

  it("keeps duplicate tool ids deterministic across incremental adds", () => {
    const entries = [
      message("a1", null, { kind: "assistant", content: [{ type: "tool_use", id: "toolu_dup", name: "bash", input: { command: "one" } }] }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_dup", content: [{ type: "text", text: "one" }] }),
      message("a2", "r1", { kind: "assistant", content: [{ type: "tool_use", id: "toolu_dup", name: "bash", input: { command: "two" } }] }),
      message("r2", "a2", { kind: "toolResult", toolUseId: "toolu_dup", content: [{ type: "text", text: "two" }] }),
    ]
    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    for (const entry of entries) builder.add(entry)

    expect(builder.snapshot()).toEqual(buildBranchHistoryFromEntries(entries, { executionCwd: CWD }))
    expect(builder.snapshot().blocks.map((block) => "id" in block ? block.id : undefined)).toEqual(["toolu_dup", "toolu_dup#2"])
  })

  it("re-settles only known tools when result meta and subagent runs arrive late", () => {
    const bashUse = message("a1", null, { kind: "assistant", content: [{ type: "tool_use", id: "toolu_meta", name: "bash", input: { command: "echo ok" } }] })
    const bashResult = message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_meta", content: [{ type: "text", text: "compressed" }] })
    const subagentUse = message("a2", "r1", { kind: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name: "subagent", input: { persona: "explorer", description: "Locate it" } }] })
    const subagentResult = message("r2", "a2", { kind: "toolResult", toolUseId: "toolu_agent", content: [{ type: "text", text: "done" }] })
    const entries = [bashUse, bashResult, subagentUse, subagentResult]
    const meta = { executionOutput: "durable output", diff: "-a\n+b", filetype: "text" }
    const run = {
      toolUseId: "toolu_agent", status: "completed" as const, ownsSettlement: true,
      model: "gpt-test medium", duration: 40, totalTokens: 50, totalToolCount: 3,
    }
    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    for (const entry of entries) builder.add(entry)
    const before = builder.snapshot()

    builder.updateToolResultMeta("missing", { diff: "unused" })
    builder.updateToolSummary({ ...run, toolUseId: "missing" })
    expect(builder.snapshot()).toEqual(before)
    builder.updateToolResultMeta("toolu_meta", meta)
    builder.updateToolSummary(run)

    expect(builder.snapshot()).toEqual(buildBranchHistoryFromEntries(entries, {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_meta", meta]]),
      toolSummaries: new Map([["toolu_agent", run]]),
    }))
    expect(before.blocks[0]).toMatchObject({ kind: "tool", content: "compressed" })
    expect(before.blocks[1]).toMatchObject({ kind: "agentGroup", totalToolCount: 0 })
  })

  it("does not coalesce assistant turns across user boundaries", () => {
    const history = buildBranchHistoryFromEntries([
      message("u1", null, { kind: "user", content: "first prompt" }),
      message("a1", "u1", { kind: "assistant", content: "first answer" }),
      message("u2", "a1", { kind: "user", content: "second prompt" }),
      message("a2", "u2", { kind: "assistant", content: "second answer" }),
    ], { executionCwd: CWD })

    expect(history.blocks.map((block) => block.kind)).toEqual(["userMessage", "text", "userMessage", "text"])
    expect(history.blocks.filter((block) => block.kind === "text").map((block) => block.content)).toEqual(["first answer", "second answer"])
  })

  it("throws on malformed Flywheel-owned tree entries", () => {
    expect(() => buildBranchHistoryFromEntries([
      JSON.parse(`{"id":"bad","parentId":null,"timestamp":"${T0}","kind":"message","message":{"kind":"assistant","content":[{"type":"bogus"}]}}`),
    ], { executionCwd: CWD })).toThrow(/Malformed persisted content part type/)

    expect(() => buildBranchHistoryFromEntries([
      JSON.parse(`{"id":"bad","parentId":null,"timestamp":"${T0}","kind":"unknown"}`),
    ], { executionCwd: CWD })).toThrow(/Malformed session tree entry kind/)

    expect(() => buildBranchHistoryFromEntries([
      message("bad-result", null, { kind: "toolResult", toolUseId: "missing_tool", content: [{ type: "text", text: "orphan" }] }),
    ], { executionCwd: CWD })).toThrow(/Malformed session tree toolResult bad-result: missing\/mismatched toolUseId missing_tool/)
  })

  it("rebuilds cursor state deterministically", () => {
    const entries = [
      message("u1", null, { kind: "user", content: "one" }),
      message("a1", "u1", { kind: "assistant", content: "two" }),
      message("u2", "a1", { kind: "user", content: "three" }),
      message("a2", "u2", { kind: "assistant", content: "four" }),
    ]

    const first = buildBranchHistoryFromEntries(entries, { executionCwd: CWD })
    const second = buildBranchHistoryFromEntries(entries, { executionCwd: CWD })

    expect(second).toEqual(first)
    expect(first.blocks.map((block) => "id" in block ? block.id : undefined)).toEqual(["u1", "a1", "u2", "a2"])
  })

  it("builds a bounded tail equivalent to the full fold", () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
      message(`u${index}`, index === 0 ? null : `u${index - 1}`, { kind: "user", content: `message ${index}` }))
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks

    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(tail.blockCount).toBe(full.length)
    expect(tail.blocks).toEqual(full.slice(-64))
  })

  it("preserves a boundary that falls inside one multi-block entry", () => {
    const content = Array.from({ length: 70 }, (_, index) => ({ type: "image" as const, mediaType: "image/png", data: String(index) }))
    const entries = [message("a1", null, { kind: "assistant", content })]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks

    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(tail.blockCount).toBe(70)
    expect(tail.blocks).toEqual(full.slice(-64))
  })

  it("expands the tail boundary to cover a tool_use referenced by a toolResult inside the tail", () => {
    const leading = Array.from({ length: 10 }, (_, index) =>
      message(`u${index}`, index === 0 ? null : `u${index - 1}`, { kind: "user", content: `leading ${index}` }))
    const trailing = Array.from({ length: 64 }, (_, index) =>
      message(`v${index}`, index === 0 ? "r1" : `v${index - 1}`, { kind: "user", content: `trailing ${index}` }))
    const entries = [
      ...leading,
      message("a1", "u9", {
        kind: "assistant",
        content: [
          { type: "text", text: "dispatching" },
          { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo ok" } },
        ],
      }),
      message("m1", "a1", { kind: "user", content: "interjected" }),
      message("r1", "m1", { kind: "toolResult", toolUseId: "toolu_1", content: [{ type: "text", text: "ok" }] }),
      ...trailing,
    ]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks

    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(tail.blockCount).toBe(full.length)
    expect(tail.blocks).toEqual(full.slice(-64))
  })

  it("counts blocked notices and duplicate tool pairing exactly in bounded tails", () => {
    const blockedEntries = [
      message("a-blocked", null, { kind: "assistant", content: [{ type: "tool_use", id: "toolu_blocked", name: "handoff", input: {} }] }),
      message("r-blocked", "a-blocked", {
        kind: "toolResult", toolUseId: "toolu_blocked", blocked: true, isError: true,
        content: [{ type: "text", text: "Review before completion" }],
      }),
    ]
    const blockedFull = buildBranchHistoryFromEntries(blockedEntries, { executionCwd: CWD }).blocks
    expect(buildBranchHistoryTailFromEntries(blockedEntries, { executionCwd: CWD }, 1)).toEqual({
      blocks: blockedFull.slice(-1),
      blockCount: blockedFull.length,
    })

    const middle = Array.from({ length: 70 }, (_, index) =>
      message(`u-middle-${index}`, index === 0 ? "a-first" : `u-middle-${index - 1}`, { kind: "user", content: `middle ${index}` }))
    const duplicateEntries = [
      message("a-first", null, { kind: "assistant", content: [{ type: "tool_use", id: "toolu_tail_dup", name: "bash", input: { command: "one" } }] }),
      ...middle.slice(0, 10),
      message("r-first", "u-middle-9", { kind: "toolResult", toolUseId: "toolu_tail_dup", content: [{ type: "text", text: "one" }] }),
      ...middle.slice(10),
      message("a-copy", "u-middle-69", { kind: "assistant", content: [{ type: "tool_use", id: "toolu_tail_dup", name: "bash", input: { command: "two" } }] }),
      message("r-copy", "a-copy", { kind: "toolResult", toolUseId: "toolu_tail_dup", content: [{ type: "text", text: "two" }] }),
    ]
    const duplicateFull = buildBranchHistoryFromEntries(duplicateEntries, { executionCwd: CWD }).blocks
    const duplicateTail = buildBranchHistoryTailFromEntries(duplicateEntries, { executionCwd: CWD }, 64)
    expect(duplicateTail.blockCount).toBe(duplicateFull.length)
    expect(duplicateTail.blocks).toEqual(duplicateFull.slice(-64))
  })

  it("counts an always-hidden background call as no block in bounded tails", () => {
    const leading = Array.from({ length: 70 }, (_, index) =>
      message(`u${index}`, index === 0 ? null : `u${index - 1}`, { kind: "user", content: `leading ${index}` }))
    const entries = [
      ...leading,
      message("a1", "u69", {
        kind: "assistant",
        content: [{ type: "tool_use", id: "background_1", name: "background", input: { action: "list" } }],
      }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "background_1", content: [{ type: "text", text: "Active background tasks" }] }),
      message("a2", "r1", { kind: "assistant", content: "done" }),
    ]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks

    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(full.some((block) => "id" in block && block.id === "background_1")).toBe(false)
    expect(tail.blockCount).toBe(full.length)
    expect(tail.blocks).toEqual(full.slice(-64))
  })

  it("counts current and historical process-management calls as no blocks", () => {
    for (const name of ["process", "background"]) {
      const entries = [
        message(`${name}-use`, null, { kind: "assistant", content: [{ type: "tool_use", id: `${name}-1`, name, input: { action: "list" } }] }),
        message(`${name}-result`, `${name}-use`, { kind: "toolResult", toolUseId: `${name}-1`, content: [{ type: "text", text: "none" }] }),
      ]
      expect(buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks).toEqual([])
      expect(buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)).toEqual({ blocks: [], blockCount: 0 })
    }
  })

  it("counts a blocked always-hidden background call as no block or notice", () => {
    const leading = Array.from({ length: 70 }, (_, index) =>
      message(`blocked-u${index}`, index === 0 ? null : `blocked-u${index - 1}`, { kind: "user", content: `leading ${index}` }))
    const entries = [
      ...leading,
      message("blocked-a1", "blocked-u69", {
        kind: "assistant",
        content: [{ type: "tool_use", id: "background_blocked", name: "background", input: { action: "list" } }],
      }),
      message("blocked-r1", "blocked-a1", {
        kind: "toolResult",
        toolUseId: "background_blocked",
        blocked: true,
        isError: true,
        content: [{ type: "text", text: "Background task is not ready" }],
      }),
      message("blocked-a2", "blocked-r1", { kind: "assistant", content: "done" }),
    ]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks
    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(full.some((block) => "id" in block && block.id === "background_blocked")).toBe(false)
    expect(full.some((block) => block.kind === "userMessage" && block.content === "Background task is not ready")).toBe(false)
    expect(tail.blockCount).toBe(full.length)
    expect(tail.blocks).toEqual(full.slice(-64))
  })

  it("counts a tool_use with leading text as two blocks in bounded tails", () => {
    const entries = [
      message("a1", null, {
        kind: "assistant",
        content: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: { context: "Pick one before I continue.", question: "Which?", options: [{ label: "A" }] } }],
      }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_ask", content: [{ type: "text", text: "User cancelled the question." }] }),
    ]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks
    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(full.map((block) => "id" in block ? block.id : undefined)).toEqual(["a1:0:lead", "toolu_ask"])
    expect(tail.blockCount).toBe(full.length)
    expect(tail.blocks).toEqual(full)
  })

  it("returns the full fold when the branch is shorter than the bound", () => {
    const entries = [
      message("u1", null, { kind: "user", content: "hello" }),
      message("a1", "u1", { kind: "assistant", content: "world" }),
    ]
    const full = buildBranchHistoryFromEntries(entries, { executionCwd: CWD }).blocks

    const tail = buildBranchHistoryTailFromEntries(entries, { executionCwd: CWD }, 64)

    expect(tail).toEqual({ blocks: full, blockCount: 2 })
  })
})
