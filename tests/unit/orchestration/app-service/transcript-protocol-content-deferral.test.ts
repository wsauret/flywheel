import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import type { MutationDiff } from "../../../../src/infra/mutation-diff.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"

async function openExistingTree(options: Parameters<typeof tryOpenConversationTree>[0]) {
  const tree = await tryOpenConversationTree(options)
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}

describe("bounded output history content deferral", () => {
  it("indexes 25 Code parents without resolving off-page child content on cold or cached reads", async () => {
    const messages: ConversationMessage[] = Array.from({ length: 25 }, (_, index) => ({
      kind: "assistant",
      content: [{ type: "tool_use", id: `code-${index}`, name: "code", input: { code: "return 1" } }],
    }))
    messages.push({ kind: "assistant", content: "tail" })
    await withDerivedChatHistory(messages, async (projection, store) => {
      for (let index = 0; index < 25; index += 1) {
        store.append({
          aggregateId: "session:session-1", sessionId: "session-1", actor: "agent",
          type: "tool.input.completed", version: 1, timestamp: index,
          payload: {
            toolUseId: `child-${index}`, parentToolUseId: `code-${index}`, toolName: "read",
            input: { path: "file" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
            executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
          },
        })
        store.append({
          aggregateId: "session:session-1", sessionId: "session-1", actor: "flywheel",
          type: "tool.result.recorded", version: 2, timestamp: index,
          payload: { toolUseId: `child-${index}`, parentToolUseId: `code-${index}`, outcome: "ok", content: { sha256: `missing-${index}`, bytes: 10, preview: "off-page" } },
        })
      }
      const request = { anchor: { kind: "tail" as const }, maxBlocks: 1, maxBytes: 1000 }
      const cold = await projection.outputWindow("session-1", request)
      const cached = await projection.outputWindow("session-1", request)
      expect(cold.totalBlocks).toBe(51)
      expect(cached).toEqual(cold)
      expect(cold.range.kind === "ok" && cold.range.blocks).toEqual([expect.objectContaining({ kind: "text", content: "tail" })])
      await expect(projection.outputBlockBody("session-1", { blockId: "tool:child-0" })).rejects.toThrow("missing")
    })
  })

  it("ships only a historical subagent shell until its operation rows are expanded", async () => {
    await withDerivedChatHistory([
      { kind: "user", content: "locate the seam" },
      {
        kind: "assistant",
        content: [{
          type: "tool_use",
          id: "subagent-1",
          name: "subagent",
          input: { persona: "reviewer-elegance", description: "Locate session ownership flow" },
        }],
      },
      { kind: "toolResult", toolUseId: "subagent-1", content: [{ type: "text", text: "found it" }] },
    ], async (projection, store) => {
      appendSubagentHistory(store)

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      expect(range.kind).toBe("ok")
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const group = range.blocks.find((block) => block.kind === "agentGroup")
      if (group?.kind !== "agentGroup") throw new Error("expected subagent group")
      expect(group).toMatchObject({
        id: "subagent-1",
        toolUseId: "subagent-1",
        label: "Reviewer Elegance",
        description: "Locate session ownership flow",
        agentType: "reviewer-elegance",
        status: "completed",
        model: "gpt-6-luna medium",
        totalToolCount: 1,
        totalTokens: 37_100,
        duration: 41_900,
        children: [],
      })

      const expanded = await projection.outputGroupChildren("session-1", {
        groupBlockIds: [`tool:${group.id}`],
        maxBytes: 1024 * 1024,
      })
      const [hydrated] = expanded.groups
      if (!hydrated) throw new Error("expected hydrated group")
      expect(hydrated.totalChildren).toBe(1)
      expect(hydrated.children).toEqual([expect.objectContaining({
        kind: "tool",
        id: "child-tool-1",
        name: "search",
        presentation: { name: "Search", detail: '"sessionState"' },
        status: "completed",
      })])
    })
  })

  it("strips collapsed-by-default tool result content and reports the omitted line count", async () => {
    await withDerivedChatHistory([
      { kind: "user", content: "read the file" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "src/app.ts" } }] },
      { kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "large output\n".repeat(200) }] },
    ], async (projection) => {
      const shown = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      expect(shown.kind).toBe("ok")
      if (shown.kind !== "ok") throw new Error("expected hydrated range")
      expect(shown.blocks.map((block) => block.kind)).toEqual(["userMessage", "tool"])
      const visibleTool = shown.blocks.find((block) => block.kind === "tool")
      expect(visibleTool?.kind).toBe("tool")
      if (visibleTool?.kind !== "tool") throw new Error("expected tool block")
      expect(visibleTool.presentation.detail).toBe("src/app.ts")
      expect(visibleTool.content).toBeUndefined()
      expect(visibleTool.contentOmittedLines).toBe(201)
      expect(shown.window.startBlockIndex).toBe(0)
      expect(shown.window.endBlockIndex).toBe(1)
    })
  })

  it("keeps the actual file-write diff without the input body", async () => {
    const mutation: MutationDiff = {
      version: 1,
      files: [{ path: "src/app.ts", change: "added", unifiedDiff: "@@ -0,0 +1 @@\n+export const ok = true\n" }],
      omissions: [],
    };
    await withDerivedChatHistory([
      { kind: "user", content: "write the file" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "write", input: { path: "src/app.ts", content: "export const ok = true\n" } }] },
      { kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "created" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.result.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "call-1", outcome: "ok", details: { mutation } },
      })
      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      expect(range.kind).toBe("ok")
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      expect(tool?.kind).toBe("tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.name).toBe("write")
      expect(tool.mutationEvidence).toMatchObject({ applied: 1, retainedFiles: 1, added: 1 })
      expect(Object.hasOwn(tool, "mutation")).toBe(false)
      expect(tool.content).toBeUndefined()
      expect(tool.proposedDiff).toBeUndefined()
    })
  })

  it("truncates recorded diffs to the preview head and serves the full body via outputBlockBody", async () => {
    // Recorded diffs are createPatch output: file headers plus @@ hunks. The
    // preview limit counts only hunk content lines, matching the client renderer.
    const header = "Index: src/app.ts\n===================================================================\n--- src/app.ts\n+++ src/app.ts\n@@ -1,0 +1,30 @@"
    const hunkLines = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`)
    const diff = [header, ...hunkLines].join("\n")
    await withDerivedChatHistory([
      { kind: "user", content: "replace it" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "replace", input: { files: ["src/app.ts"], old: "a", new: "b" } }] },
      { kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "ok" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1",
        type: "tool.result.recorded",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "session-1",
        payload: { toolUseId: "call-1", outcome: "ok", details: { files: [{ path: "src/app.ts", diff, filetype: "typescript" }] } },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      expect(range.kind).toBe("ok")
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      expect(tool?.kind).toBe("tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.diff).toBe([header, ...hunkLines.slice(0, 20)].join("\n"))
      expect(tool.diffOmission).toEqual({ kind: "aggregate", omittedLines: 10 })
      expect(tool.filetype).toBe("typescript")

      const tree = await openExistingTree({ conversationId: "conv-1", sessionId: "session-1", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const appended = await tree.appendMessages([{ kind: "user", content: "advance the durable tip" }])
      tree.getStorage().dispose()
      if (appended.kind !== "committed") throw new Error(`tree append failed: ${appended.kind}`)

      const body = await projection.outputBlockBody("session-1", { blockId: `tool:${tool.id}` })
      expect(body.diff).toBe(diff)
      expect(body.filetype).toBe("typescript")
    })
  })

  it.each([
    ["memory", "memory-1", "memory", { title: "note" }],
    ["skill", "skill-1", "skill_manage", { action: "save", name: "notes" }],
  ])("keeps a %s evidence root while its closed row has no preview", async (_label, toolUseId, toolName, input) => {
    const mutation = memoryMutation(26)
    await withDerivedChatHistory([
      { kind: "user", content: "change durable learning" },
      { kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] },
      { kind: "toolResult", toolUseId, content: [{ type: "text", text: "saved" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.result.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId, outcome: "ok", details: { mutation } },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.mutationEvidence).toMatchObject({ applied: 1, retainedFiles: 1 })
      expect(tool.diffOmission).toBeUndefined()

      const body = await projection.outputBlockBody("session-1", { blockId: `tool:${tool.id}` })
      expect(body.mutationEvidence).toEqual(tool.mutationEvidence)
      expect(body.diff).toBeUndefined()
    })
  })

  it("keeps multi-file evidence behind one root rather than per-file transcript previews", async () => {
    const mutation = {
      version: 1 as const,
      files: [
        ...memoryMutation(26, "a/SKILL.md").files,
        ...memoryMutation(26, "b/SKILL.md").files,
      ],
      omissions: [],
    }
    await withDerivedChatHistory([
      { kind: "user", content: "edit both files" },
      { kind: "assistant", content: [{ type: "tool_use", id: "edit-many", name: "edit", input: { input: "@@ a/SKILL.md\n@@ b/SKILL.md" } }] },
      { kind: "toolResult", toolUseId: "edit-many", content: [{ type: "text", text: "saved" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.result.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "edit-many", outcome: "ok", details: { mutation } },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.presentation).toEqual({ name: "Edit", detail: "" })
      expect(tool.mutationEvidence).toMatchObject({ applied: 2, retainedFiles: 2, addedLines: 52 })
      expect(Object.hasOwn(tool, "mutation")).toBe(false)
      expect(tool.diffOmission).toBeUndefined()
    })
  })

  it("serves current review notices by identity with only one evidence root", async () => {
    const reviewMutations = [
      { name: "provider-quirks", action: "patched" as const, reach: "project" as const, mutation: memoryMutation(26, "a/SKILL.md") },
      { name: "seam-notes", action: "created" as const, reach: "project" as const, mutation: memoryMutation(26, "b/SKILL.md") },
    ]
    await withDerivedChatHistory([
      { kind: "user", content: "review the session" },
    ], async (projection, store) => {
      const mutationEvidence = await buildMutationDiffEvidence({
        version: 1, files: reviewMutations.flatMap(item => item.mutation.files), omissions: [],
      }, "notice", nodes => asAsyncEventWriter(store).stageSessionContentNodes!("session-1", nodes))
      const tree = await openExistingTree({ conversationId: "conv-1", sessionId: "session-1", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      await tree.appendMessages([{ kind: "system", content: "Updated skill: `provider-quirks`.", mutationEvidence }])
      tree.getStorage().dispose()
      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const notice = range.blocks.find((block) => block.kind === "system")
      if (notice?.kind !== "system") throw new Error("expected system block")

      expect(notice.mutationEvidence).toEqual(mutationEvidence)

      const body = await projection.outputBlockBody("session-1", { blockId: `system:${notice.id}` })
      expect(body.mutationEvidence).toEqual(mutationEvidence)
    })
  })

  it("never marks a source-level omission for hydration", async () => {
    const mutation = { version: 1 as const, files: [], omissions: [{ path: ".flywheel/memory/global.md", reason: "sensitive" as const }] }
    await withDerivedChatHistory([
      { kind: "assistant", content: [{ type: "tool_use", id: "memory-2", name: "memory", input: { title: "secret" } }] },
      { kind: "toolResult", toolUseId: "memory-2", content: [{ type: "text", text: "saved" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.result.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "memory-2", outcome: "ok", details: { mutation } },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.mutationEvidence).toMatchObject({ applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1 })
      expect(tool.diffOmission).toBeUndefined()
    })
  })

  it("replays a legacy private-reach omission without hydrating or exposing bytes", async () => {
    const mutation = { version: 1 as const, files: [], omissions: [{ path: "USER.md", reason: "private_reach" as const }] }
    await withDerivedChatHistory([
      { kind: "assistant", content: [{ type: "tool_use", id: "memory-legacy", name: "memory", input: { title: "legacy" } }] },
      { kind: "toolResult", toolUseId: "memory-legacy", content: [{ type: "text", text: "saved" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.result.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "memory-legacy", outcome: "ok", details: { mutation } },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.mutationEvidence).toMatchObject({ applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1 })
      expect(tool.diffOmission).toBeUndefined()
    })
  })

  it("defers a durable bash tail on the wire and hydrates it by stable identity across reconstruction", async () => {
    await withDerivedChatHistory([
      { kind: "assistant", content: [{ type: "tool_use", id: "bash-tail", name: "bash", input: { command: "produce output" } }] },
      { kind: "toolResult", toolUseId: "bash-tail", content: [{ type: "text", text: "compressed model result" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.execution_output.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "bash-tail", output: "durable execution tail" },
      })

      const range = await projection.outputRange("session-1", { anchor: { kind: "tail" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
      if (range.kind !== "ok") throw new Error("expected hydrated range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected tool block")
      expect(tool.content).toBeUndefined()
      expect(tool.contentOmittedLines).toBe(1)
      expect(await projection.outputBlockBody("session-1", { blockId: `tool:${tool.id}` })).toEqual({
        blockId: `tool:${tool.id}`,
        content: "durable execution tail",
      })

      const recreated = createSessionDetailProjection({
        projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => undefined },
        manager: { read: async () => durableSession() }, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      })
      expect(await recreated.outputBlockBody("session-1", { blockId: "tool:bash-tail" })).toEqual({
        blockId: "tool:bash-tail",
        content: "durable execution tail",
      })
    })
  })

  it("hydrates compressed bash result content for old sessions without an execution-output fact", async () => {
    await withDerivedChatHistory([
      { kind: "assistant", content: [{ type: "tool_use", id: "old-bash", name: "bash", input: { command: "old" } }] },
      { kind: "toolResult", toolUseId: "old-bash", content: [{ type: "text", text: "compressed fallback" }] },
    ], async (projection) => {
      expect(await projection.outputBlockBody("session-1", { blockId: "tool:old-bash" })).toEqual({
        blockId: "tool:old-bash",
        content: "compressed fallback",
      })
    })
  })

  it("omits a malformed execution-output decoration and preserves readable content", async () => {
    await withDerivedChatHistory([
      { kind: "assistant", content: [{ type: "tool_use", id: "bad-bash", name: "bash", input: { command: "bad" } }] },
      { kind: "toolResult", toolUseId: "bad-bash", content: [{ type: "text", text: "compressed" }] },
    ], async (projection, store) => {
      store.append({
        aggregateId: "session:session-1", type: "tool.execution_output.recorded", version: 1,
        timestamp: Date.now(), actor: "flywheel", sessionId: "session-1",
        payload: { toolUseId: "bad-bash", output: 42 },
      })
      expect(await projection.outputBlockBody("session-1", { blockId: "tool:bad-bash" })).toEqual({
        blockId: "tool:bad-bash",
        content: "compressed",
      })
    })
  })
})

/** A memory-style patch whose rendered hunk lines are exactly `hunkLines`, so a
 *  test can name the preview budget it is spending. */
function memoryPatch(hunkLines: number, path = ".flywheel/memory/project.md"): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${hunkLines} +1,${hunkLines} @@`]
  for (let index = 0; index < hunkLines; index += 1) lines.push(`+note ${index}`)
  return lines.join("\n")
}

function memoryMutation(hunkLines: number, path = ".flywheel/memory/project.md") {
  return { version: 1 as const, files: [{ path, change: "modified" as const, unifiedDiff: memoryPatch(hunkLines, path) }], omissions: [] }
}

function appendSubagentHistory(store: ReturnType<typeof createSqliteEventStore>): void {
  const aggregateId = "session:session-1"
  store.append({
    aggregateId,
    type: "child_run.created",
    version: 1,
    timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    actor: "flywheel",
    sessionId: "session-1",
    payload: {
      childRunId: "child-1",
      kind: "subagent",
      toolUseId: "subagent-1",
      agentType: "reviewer-elegance",
      description: "Locate session ownership flow",
      model: "gpt-6-luna",
      effort: "medium",
      maxTurns: 20,
      tools: ["search"],
    },
  })
  store.append({
    aggregateId,
    type: "subagent.completed",
    version: 1,
    timestamp: Date.parse("2026-01-01T00:00:42.900Z"),
    actor: "flywheel",
    sessionId: "session-1",
    payload: {
      childRunId: "child-1",
      status: "completed",
      isError: false,
      durationMs: 41_900,
      totalTokens: 37_100,
      toolUses: 1,
      resultBytes: 8,
      resultSha256: "a".repeat(64),
      resultPreview: "found it",
    },
  })
  store.append({
    aggregateId,
    type: "tool.input.completed",
    version: 1,
    timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
    actor: "agent",
    sessionId: "session-1",
    payload: {
      toolUseId: "child-tool-1",
      toolName: "search",
      input: { pattern: "sessionState" },
      inputBytes: 24,
      inputSha256: "b".repeat(64),
      inputPreview: '{"pattern":"sessionState"}',
      executionMode: "foreground",
      traceKind: "tool",
      childHasOwnViewport: false,
      parentToolUseId: "subagent-1",
    },
  })
  store.append({
    aggregateId,
    type: "tool.result.recorded",
    version: 1,
    timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
    actor: "flywheel",
    sessionId: "session-1",
    payload: {
      toolUseId: "child-tool-1",
      outcome: "ok",
      contentBytes: 2,
      contentSha256: "c".repeat(64),
      contentPreview: "ok",
      parentToolUseId: "subagent-1",
    },
  })
}

async function withDerivedChatHistory(
  messages: readonly ConversationMessage[],
  run: (projection: ReturnType<typeof createSessionDetailProjection>, store: ReturnType<typeof createSqliteEventStore>) => Promise<void>,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-history-deferral-"))
  const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
  try {
    const tree = await createConversationTree({ conversationId: "conv-1", sessionId: "session-1", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const appended = await tree.appendMessages(messages)
    tree.getStorage().dispose()
    if (appended.kind !== "committed") throw new Error(`tree append failed: ${appended.kind}`)

    const recovered = createMutationEvidenceRecovery(asAsyncEventReadSurface(store), asAsyncEventWriter(store)).reader
    const projection = createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => undefined },
      manager: { read: async () => durableSession() },
      reader: recovered,
      projectionReader: recovered,
    })
    await run(projection, store)
    await projection.dispose()
  } finally {
    store.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function durableSession() {
  return {
    label: "Session",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState: "inactive" as const,
    name: "Session",
    kind: "chat" as const,
    command: "chat" as const,
    conversationId: "conv-1",
    executionCwd: FIXTURE_EXECUTION_CWD,
  }
}
