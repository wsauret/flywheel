import { describe, expect, it } from "bun:test"
import type { MessageEntry, ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { BranchHistoryBuilder } from "../../../../src/orchestration/session/conversation/transcript/branch-history-builder"
import { branchBlocks } from "../../../helpers/branch-blocks"
import { buildMutationDiff } from "../../../../src/infra/substrate/file-mutations/mutation-diff"
import { buildMutationDiffEntries } from "../../../../src/infra/substrate/file-mutations/mutation-diff-evidence"
import { buildMutationEvidence, readMutationEvidenceFiles } from "../../../../src/infra/substrate/file-mutations/mutation-evidence"
import { sessionContentFixture } from "../../../helpers/session-content"
import { readSessionContentRange } from "../../../../src/infra/substrate/session-content"

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
    const history = builder.snapshot()

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
      { id: "i1", parentId: "b1", timestamp: T0, kind: "session_info" },
      { id: "leaf1", parentId: "i1", timestamp: T0, kind: "leaf", targetId: "i1" },
    ]
    const builder = new BranchHistoryBuilder({ executionCwd: CWD })
    expect(builder.snapshot()).toEqual({ blocks: [], consistencyToken: "chat-tree:v1:root", tipEntryId: null })

    for (const [index, entry] of entries.entries()) {
      builder.add(entry)
      const batch = new BranchHistoryBuilder({ executionCwd: CWD })
      for (const prior of entries.slice(0, index + 1)) batch.add(prior)
      expect(builder.snapshot()).toEqual(batch.snapshot())
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

    const blocks = branchBlocks(entries, { executionCwd: CWD })
    const block = blocks[0]
    if (block?.kind !== "system") throw new Error("expected system block")
    expect(blocks).toHaveLength(1)
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

    expect(builder.snapshot().blocks).toEqual(branchBlocks(entries, { executionCwd: CWD }))
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

    expect(builder.snapshot().blocks).toEqual(branchBlocks(entries, {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_meta", meta]]),
      toolSummaries: new Map([["toolu_agent", run]]),
    }))
    expect(before.blocks[0]).toMatchObject({ kind: "tool", content: "compressed" })
    expect(before.blocks[1]).toMatchObject({ kind: "agentGroup", totalToolCount: 0 })
  })

  it("does not coalesce assistant turns across user boundaries", () => {
    const blocks = branchBlocks([
      message("u1", null, { kind: "user", content: "first prompt" }),
      message("a1", "u1", { kind: "assistant", content: "first answer" }),
      message("u2", "a1", { kind: "user", content: "second prompt" }),
      message("a2", "u2", { kind: "assistant", content: "second answer" }),
    ], { executionCwd: CWD })

    expect(blocks.map((block) => block.kind)).toEqual(["userMessage", "text", "userMessage", "text"])
    expect(blocks.filter((block) => block.kind === "text").map((block) => block.content)).toEqual(["first answer", "second answer"])
  })

  it("throws on malformed Flywheel-owned tree entries", () => {
    expect(() => branchBlocks([
      JSON.parse(`{"id":"bad","parentId":null,"timestamp":"${T0}","kind":"message","message":{"kind":"assistant","content":[{"type":"bogus"}]}}`),
    ], { executionCwd: CWD })).toThrow(/Malformed persisted content part type/)

    expect(() => branchBlocks([
      JSON.parse(`{"id":"bad","parentId":null,"timestamp":"${T0}","kind":"unknown"}`),
    ], { executionCwd: CWD })).toThrow(/Malformed session tree entry kind/)

    expect(() => branchBlocks([
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

    const first = branchBlocks(entries, { executionCwd: CWD })
    const second = branchBlocks(entries, { executionCwd: CWD })

    expect(second).toEqual(first)
    expect(first.map((block) => "id" in block ? block.id : undefined)).toEqual(["u1", "a1", "u2", "a2"])
  })

  it("projects current and historical process-management calls as no blocks", () => {
    for (const name of ["process", "background"]) {
      const entries = [
        message(`${name}-use`, null, { kind: "assistant", content: [{ type: "tool_use", id: `${name}-1`, name, input: { action: "list" } }] }),
        message(`${name}-result`, `${name}-use`, { kind: "toolResult", toolUseId: `${name}-1`, content: [{ type: "text", text: "none" }] }),
      ]
      expect(branchBlocks(entries, { executionCwd: CWD })).toEqual([])
    }
  })

  it("projects a blocked always-hidden background call as no block or notice", () => {
    const entries = [
      message("blocked-a1", null, {
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
    const full = branchBlocks(entries, { executionCwd: CWD })

    expect(full.some((block) => "id" in block && block.id === "background_blocked")).toBe(false)
    expect(full.some((block) => block.kind === "userMessage" && block.content === "Background task is not ready")).toBe(false)
  })

  it("projects a tool_use with leading text as two blocks", () => {
    const entries = [
      message("a1", null, {
        kind: "assistant",
        content: [{ type: "tool_use", id: "toolu_ask", name: "ask_user", input: { context: "Pick one before I continue.", question: "Which?", options: [{ label: "A" }] } }],
      }),
      message("r1", "a1", { kind: "toolResult", toolUseId: "toolu_ask", content: [{ type: "text", text: "User cancelled the question." }] }),
    ]
    const full = branchBlocks(entries, { executionCwd: CWD })

    expect(full.map((block) => "id" in block ? block.id : undefined)).toEqual(["a1:0:lead", "toolu_ask"])
  })
})
