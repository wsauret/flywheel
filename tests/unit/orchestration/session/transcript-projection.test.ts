import { createSessionToolSummaryReader } from "../../../../src/orchestration/modules.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { describe, expect, it, spyOn } from "bun:test"
import { Hash } from "node:crypto"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { blocks, openExistingTree, transcriptFixture, transcriptStores } from "./_transcript-projection-fixtures"
import { openReadonlyEventReader } from "../../../../src/infra/sqlite-event-store"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection"
import { createAgentInputCursorReader } from "../../../../src/orchestration/session/agent-input-projection"
import { buildBranchHistoryFromEntries } from "../../../../src/orchestration/session/conversation/branch-history-builder"
import { createToolResultDisplayMetaCursorReader } from "../../../../src/orchestration/session/conversation/tool-result-meta"
import { createWorkflowToolCore } from "../../../../src/orchestration/agent-runtime/tools/workflow-tool"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery"
import { readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence"
import { readSessionContentRange } from "../../../../src/infra/session-content"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { startTestWorkflowMember, succeedTestWorkflowMember } from "./_session-manager-fixtures"

let baseDir: string
let store: EventStore

const { createChat, immediateWriter, publishWorkflowBinding, appendSessionFact, appendCompletedSubagent } =
  transcriptFixture(() => store, () => baseDir)

transcriptStores((nextStore, directory) => {
  store = nextStore
  baseDir = directory
})

describe("SessionTranscriptProjection", () => {
  it("reads committed history through a read-only connection without a tree writer", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ sessionId, conversationId, store })
    await tree.appendMessage({ kind: "assistant", content: "Read-only history" })
    tree.getStorage().dispose()
    const reader = openReadonlyEventReader(resolveEventStoreDbFile(baseDir))
    const projection = new SessionTranscriptProjection({ sessionId, conversationId, store: asAsyncEventReadSurface(reader), executionCwd: baseDir })
    try {
      const before = store.read().length
      expect(await blocks(await projection.read())).toMatchObject([{ kind: "text", content: "Read-only history" }])
      expect(store.read()).toHaveLength(before)
    } finally {
      await projection.dispose()
      reader.close()
    }
  })

  it("returns unchanged one-block reads without traversing or hashing history metadata", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    await tree.appendMessage({ kind: "assistant", content: Array.from({ length: 128 }, (_, index) => ({
      type: "tool_use" as const, id: `read-${index}`, name: "read", input: { path: `file-${index}` },
    })) })
    const meta = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), sessionId)
    const runs = createSessionToolSummaryReader(asAsyncEventReadSurface(store), sessionId)
    const auxiliary = {
      agentInput: await createAgentInputCursorReader(asAsyncEventReadSurface(store), sessionId).replay(),
      toolMeta: await meta.replay(),
      toolSummaries: await runs.replay(),
    }
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir, auxiliarySource: "external" })
    const first = await projection.read(auxiliary)
    expect(first?.blockCount).toBe(128)
    const selected = await first?.readBlock(64)
    const probes = {
      toolIds: spyOn(projection["toolUseIds"], Symbol.iterator),
      baseBlocks: spyOn(projection["baseBlocks"], Symbol.iterator),
      slots: spyOn(projection["slots"], "map"),
      branch: spyOn(projection["branch"], "map"),
      hash: spyOn(Hash.prototype, "update"),
      hydrate: spyOn(auxiliary.toolMeta, "readMeta"),
    }
    try {
      for (let index = 0; index < 4; index += 1) {
        const unchanged = await projection.read(auxiliary)
        expect(unchanged).toBe(first)
        expect(await unchanged?.readBlock(64)).toBe(selected)
      }
      expect(Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, probe.mock.calls.length])))
        .toEqual({ toolIds: 0, baseBlocks: 0, slots: 0, branch: 0, hash: 0, hydrate: 0 })
    } finally {
      for (const probe of Object.values(probes)) probe.mockRestore()
      await projection.dispose()
      tree.getStorage().dispose()
    }
  })

  it("keeps an unmaterialized request slot at its captured conversation revision", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: { path: "file" } }] })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const before = await projection.read()
    await tree.appendMessage({ kind: "toolResult", toolUseId: "read", content: [{ type: "text", text: "done" }] })
    const after = await projection.read()
    expect(await before?.readBlock(0)).toMatchObject({ status: "interrupted" })
    expect(await after?.readBlock(0)).toMatchObject({ status: "completed", content: "done" })
    await projection.dispose()
    tree.getStorage().dispose()
  })

  it("replays once, append-folds new branch entries, and preserves blocks on an unchanged read", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessage({ kind: "user", content: "hello" })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })

    const first = await projection.read()
    await writer.appendMessage({ kind: "assistant", content: "world" })
    const appended = await projection.read()
    const unchanged = await projection.read()

    expect((await blocks(first)).map((block) => block.kind)).toEqual(["userMessage"])
    expect((await blocks(appended)).map((block) => block.kind)).toEqual(["userMessage", "text"])
    expect(appended?.consistencyToken).not.toBe(first?.consistencyToken)
    expect(unchanged).toBe(appended)
    await projection.dispose()
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("keeps degraded blocks in incremental reads and fresh opens", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessage({ kind: "user", content: "readable" })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const preview = await projection.read()
    store.append({
      aggregateId: `conversation:${conversationId}`,
      sessionId,
      type: "chat.entries.appended",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      payload: {
        conversationId,
        entries: [{
          kind: "message",
          id: "orphan-result",
          parentId: "missing-parent",
          createdAt: new Date().toISOString(),
          message: { kind: "toolResult", toolUseId: "missing-tool", content: [{ type: "text", text: "RAW_SENTINEL" }] },
        }],
      },
    })

    const opened = await projection.read()
    const reread = await projection.read()
    const fresh = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const reopened = await fresh.read()

    expect(await blocks(preview)).toEqual([expect.objectContaining({ kind: "userMessage", content: "readable" })])
    expect(await blocks(opened)).toEqual(await blocks(reopened))
    expect(reread).toBe(opened)
    expect((await blocks(opened)).at(-1)).toMatchObject({ kind: "degraded", notice: "Part of this transcript could not be displayed." })
    expect(JSON.stringify(await blocks(opened))).not.toContain("RAW_SENTINEL")
    await fresh.dispose()
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("reprojects a persisted review notice with the skill mutations it recorded", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    const mutation = buildMutationDiff([
      { path: "SKILL.md", before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } },
    ])
    const reviewMutations = [
      { name: "provider-quirks", action: "patched", reach: "project" as const, mutation },
      { name: "provider-quirks", action: "support_file", reach: "project" as const, mutation },
    ]
    const parentId = await writer.appendMessage({ kind: "user", content: "hello" })
    writer.getStorage().dispose()
    const historical = store.append({
      aggregateId: `conversation:${conversationId}`, sessionId,
      type: "chat.entries.appended", version: 6, actor: "flywheel", timestamp: Date.now(),
      payload: { conversationId, entries: [{
        kind: "message", id: "historical-review", parentId, timestamp: new Date().toISOString(),
        message: { kind: "system", content: "Updated skill: `provider-quirks`.", reviewMutations },
      }] },
    })

    // A fresh projection over the durable facts only: nothing in memory
    // survives from the write side.
    const raw = asAsyncEventReadSurface(store)
    const recovered = createMutationEvidenceRecovery(raw, asAsyncEventWriter(store)).reader
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: recovered, executionCwd: baseDir })
    const history = await projection.read()
    const notice = (await blocks(history)).at(-1)
    if (notice?.kind !== "system") throw new Error("expected system block")
    expect(notice.message).toBe("Updated skill: `provider-quirks`.")
    const read = (hash: string) => raw.readSessionContentNode!(sessionId, hash)
    const page = await readMutationEvidenceFiles(notice.mutationEvidence!, 0, 10, read)
    if (page.kind !== "available") throw new Error("expected notice files")
    expect(page.nextOffset).toBeNull()
    expect(page.files).toHaveLength(2)
    for (const [index, file] of page.files.entries()) {
      if (file.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch")
      expect({ path: file.file.path, name: file.file.name, action: file.file.action, reach: file.file.reach }).toEqual({
        path: "SKILL.md", name: "provider-quirks", action: reviewMutations[index]!.action, reach: "project",
      })
      const range = await readSessionContentRange(file.file.patch.reference, 0, 4096, read)
      if (range.kind !== "available") throw new Error("expected patch bytes")
      expect(range.nextOffset).toBeNull()
      expect(Buffer.from(range.base64, "base64").toString()).toBe(mutation.files[0]!.unifiedDiff)
    }
    expect(store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] }).find(fact => fact.id === historical.id)).toEqual(historical)
    await projection.dispose()
  })

  it("re-folds a moved branch to the same result as a fresh batch fold", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    const root = await writer.appendMessage({ kind: "user", content: "root" })
    await writer.appendMessage({ kind: "assistant", content: "old branch" })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    await projection.read()

    await writer.moveTo(root)
    await writer.appendMessage({ kind: "assistant", content: "new branch" })
    const actual = await projection.read()
    const expected = buildBranchHistoryFromEntries(await writer.getBranch(), { executionCwd: baseDir })

    expect(await blocks(actual)).toEqual([...expected.blocks])
    expect(actual?.tipEntryId).toBe(expected.tipEntryId)
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("renders an ask_user context field as a text block before the tool row", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessages([
      {
        kind: "assistant",
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "ask_user",
          input: { question: "Continue?", options: ["Yes"], context: "Background the user needs." },
        }],
      },
      { kind: "toolResult", toolUseId: "ask-1", content: [{ type: "text", text: "User answered:\n- Continue?: Yes" }] },
    ])
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const history = await projection.read()

    expect((await blocks(history)).map((block) => block.kind)).toEqual(["text", "tool"])
    expect(await history?.readBlock(0)).toMatchObject({ kind: "text", content: "Background the user needs." })
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("re-settles an existing subagent block when its run facts arrive late", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessages([
      {
        kind: "assistant",
        content: [{ type: "tool_use", id: "tool-agent", name: "subagent", input: { persona: "explorer", description: "Locate it" } }],
      },
      { kind: "toolResult", toolUseId: "tool-agent", content: [{ type: "text", text: '{"summary":"Located the cause. The tests pass."}' }] },
    ])
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const before = await projection.read()
    appendCompletedSubagent(sessionId, "tool-agent")
    const after = await projection.read()
    const group = await after?.readBlock(0)

    expect(await before?.readBlock(0)).toMatchObject({ kind: "agentGroup", totalToolCount: 0, summary: "Located the cause" })
    expect(group).toMatchObject({ kind: "agentGroup", totalToolCount: 2, totalTokens: 30 })
    expect(group?.kind === "agentGroup" ? group.summary : "missing card").toBeUndefined()
    expect(after?.consistencyToken).not.toBe(before?.consistencyToken)
    expect(await projection.read()).toBe(after)
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("re-settles a deferred workflow row when its terminal result fact arrives", async () => {
    const { sessionId, conversationId } = await createChat()
    const childId = await publishWorkflowBinding(sessionId, conversationId, "workflow-1")
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessages([
      { kind: "assistant", content: [{ type: "tool_use", id: "workflow-1", name: "workflow", input: { workflow_definition_id: "implement", description: "Do it" } }] },
      { kind: "toolResult", toolUseId: "workflow-1", content: [{ type: "text", text: "Workflow started." }] },
    ])
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const before = await projection.read()
    appendSessionFact(sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "workflow-1",
        toolName: "workflow",
        input: {},
        inputBytes: 2,
        inputSha256: "input",
        inputPreview: "{}",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: true,
      },
    })
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "workflow-1", outcome: "error", details: { displayContent: "Workflow failed exactly." } },
    })
    const after = await projection.read()

    expect(await before?.readBlock(0)).toMatchObject({ kind: "agentGroup", status: "pending", linkUri: `flywheel://workflow/${childId}` })
    expect(await after?.readBlock(0)).toMatchObject({
      kind: "agentGroup",
      status: "error",
      linkUri: `flywheel://workflow/${childId}`,
      failure: expect.objectContaining({ message: "Workflow failed exactly" }),
    })
    expect(after?.consistencyToken).not.toBe(before?.consistencyToken)
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("rebuilds a refused workflow launch card from history with the refusal the live card showed", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await openExistingTree({ conversationId, sessionId, store })
    const refused = await createWorkflowToolCore({
      startWorkflow: async () => ({ error: "Confirmation q-7 was already used, and one approval launches one workflow.", recovery: "Ask again." }),
      onRenderEvent: () => {},
      mode: "ask",
      askUserAvailable: true,
      sessionDir: "/session",
      resolveLaunchTarget: async () => ({ error: "unused in this test" }),
      executionCwd: "/project",
      authority: fullAuthority(),
    }).execute({ source: { kind: "path", path: "scratch/workflows/debug.workflow.yaml" }, description: "Do it", confirmation_id: "q-7" }, { toolUseId: "workflow-1", conversationId })
    await writer.appendMessages([
      { kind: "assistant", content: [{ type: "tool_use", id: "workflow-1", name: "workflow", input: { workflow_definition_id: "debug", description: "Do it" } }] },
      { kind: "toolResult", toolUseId: "workflow-1", content: [{ type: "text", text: refused.content }], isError: true },
    ])
    appendSessionFact(sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "workflow-1",
        toolName: "workflow",
        input: {},
        inputBytes: 2,
        inputSha256: "input",
        inputPreview: "{}",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: true,
      },
    })
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "workflow-1", outcome: refused.outcome, details: refused.details },
    })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })

    expect(await (await projection.read())?.readBlock(0)).toMatchObject({
      kind: "agentGroup",
      status: "error",
      failure: { title: "Workflow not started", message: "Confirmation q-7 was already used, and one approval launches one workflow." },
    })
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it.each(["launch", "adoption"] as const)("anchors runtime-origin %s cards to the visible branch and refreshes settlement", async (origin) => {
    const { sessionId, conversationId } = await createChat()
    const childId = await publishWorkflowBinding(sessionId, conversationId, "runtime-workflow", origin === "adoption", origin === "launch" ? "Implement sessions" : "Workflow")
    const writer = await openExistingTree({ conversationId, sessionId, store })
    await writer.appendMessage({ kind: "user", content: "Start here", origin: "human" }, "runtime-root")
    const answer = await writer.appendMessage({ kind: "assistant", content: "Ready." }, "runtime-answer")
    await writer.appendMessage({
      kind: "user",
      content: "Launched the implementation workflow: Implement the approved sessions design.",
      origin: "human",
    }, "runtime-launch-anchor")
    appendSessionFact(sessionId, {
      type: "tool.runtime_invocation.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-workflow",
        initiator: origin === "adoption" ? "migration" : "person",
        parentConversationId: conversationId,
        parentEntryId: "runtime-launch-anchor",
        operation: origin === "adoption" ? { kind: "adoption", workflowSessionId: childId } : {
          kind: "launch",
          input: {
            workflowDefinitionId: "implementation",
            summary: "Implement sessions",
            description: "Implement the approved sessions design.",
          },
        },
      },
    })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const pending = await projection.read()
    const pendingCards = (await blocks(pending)).filter((block) => block.kind === "agentGroup")

    expect(pendingCards).toEqual([expect.objectContaining({
      kind: "agentGroup",
      id: "runtime-workflow",
      toolUseId: "runtime-workflow",
      containerKind: "workflow",
      label: origin === "launch" ? "Implement sessions" : "Workflow",
      linkUri: `flywheel://workflow/${childId}`,
      status: "pending",
      totalToolCount: 0,
    })])
    expect(pendingCards[0]).not.toHaveProperty("model")
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    const memberId = await startTestWorkflowMember(manager, store, childId)
    appendSessionFact(memberId, {
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: {
        toolUseId: "workflow-read", toolName: "read", input: { path: "source.ts" },
        inputBytes: 20, inputSha256: "read-input", inputPreview: '{"path":"source.ts"}',
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      },
    })
    expect((await blocks(await projection.read())).find((block) => block.kind === "agentGroup")).toMatchObject({ totalToolCount: 1 })
    const member = await manager.read(memberId)
    if (member?.kind !== "workflow-agent") throw new Error("Expected member session")
    const memberTree = await openExistingTree({ sessionId: memberId, conversationId: member.conversationId, store })
    await memberTree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "workflow-read", name: "read", input: { path: "source.ts" } }] })
    const memberProjection = new SessionTranscriptProjection({ sessionId: memberId, conversationId: member.conversationId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const memberHistory = await memberProjection.read()
    expect((await blocks(memberHistory)).find((block) => block.kind === "tool")).toMatchObject({ name: "read", id: "workflow-read" })
    await memberProjection.dispose()
    memberTree.getStorage().dispose()

    // Reconciliation records the call's result once the run is terminal.
    await succeedTestWorkflowMember(manager, store, childId)
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-workflow",
        outcome: "ok",
      },
    })
    const settled = await projection.read()
    expect((await blocks(settled)).filter((block) => block.kind === "agentGroup")).toEqual([
      expect.objectContaining({ id: "runtime-workflow", status: "completed", linkUri: `flywheel://workflow/${childId}` }),
    ])
    expect(settled?.consistencyToken).not.toBe(pending?.consistencyToken)

    const reopened = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    expect((await blocks(await reopened.read())).filter((block) => block.kind === "agentGroup")).toEqual([
      expect.objectContaining({ id: "runtime-workflow", status: "completed", linkUri: `flywheel://workflow/${childId}` }),
    ])

    await writer.moveTo(answer)
    await writer.appendMessage({ kind: "user", content: "Use another branch", origin: "human" }, "runtime-other-branch")
    expect((await blocks(await projection.read())).filter((block) => block.kind === "agentGroup")).toEqual([])

    await reopened.dispose()
    await projection.dispose()
    writer.getStorage().dispose()
  })

  it("reads a tool row again after a failed source read", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: { path: "file" } }] })
    appendSessionFact(sessionId, { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "read", output: "output" } })
    const surface = asAsyncEventReadSurface(store)
    let failures = 1
    const failOnce = <T>(read: () => Promise<T>): Promise<T> => failures-- > 0 ? Promise.reject(new Error("state read refused")) : read()
    const reader = {
      ...surface,
      readSlice: (...args: Parameters<typeof surface.readSlice>) => args[0].positions ? failOnce(() => surface.readSlice(...args)) : surface.readSlice(...args),
      readPage: (...args: Parameters<typeof surface.readPage>) => args[0].positions ? failOnce(() => surface.readPage(...args)) : surface.readPage(...args),
    }
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: reader, executionCwd: baseDir })
    const fresh = new SessionTranscriptProjection({ conversationId, sessionId, store: surface, executionCwd: baseDir })
    try {
      const history = await projection.read()
      expect(Promise.resolve(history?.readBlock(0))).rejects.toThrow("state read refused")
      expect(await history?.readBlock(0)).toEqual(await (await fresh.read())?.readBlock(0))
    } finally {
      await projection.dispose()
      await fresh.dispose()
      tree.getStorage().dispose()
    }
  })

  it("starts a read only after the previous read commits, in arrival order", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const first = await tree.appendMessage({ kind: "user", content: "hello" })
    for (const id of ["dispatch", "retry"]) {
      const input = { kind: "dispatch", session_id: `child-${id}`, persona: "explorer", description: "Read" }
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: id, toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id, name: "subagent", input }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "accepted" }] })
      appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId: `child-${id}`, lastUpdated: new Date().toISOString() } })
      appendSessionFact(`child-${id}`, { type: "child_run.created", version: 2, actor: "flywheel", payload: {
        childSessionId: `child-${id}`, childRunId: id, conversationId: `conversation-${id}`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: id,
        persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: id },
        admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read",
      } })
    }
    const surface = asAsyncEventReadSurface(store)
    // Holds the first state read made after a read wrote the newer tree state
    // into the projection, while that read still folds it. The tree replay
    // shares one pending catch-up, so only a hold after the tree replay shows
    // whether a second read waits for the first read to commit.
    let foldedState: unknown
    let stateReads = 0
    const held = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const beforeRead = async () => {
      stateReads += 1
      if (foldedState !== undefined && projection["state"] !== foldedState) {
        foldedState = undefined
        reached.resolve()
        await held.promise
      }
    }
    const reader = {
      ...surface,
      capturePosition: async () => { await beforeRead(); return surface.capturePosition() },
      readPage: async (...args: Parameters<typeof surface.readPage>) => {
        await beforeRead()
        return surface.readPage(...args)
      },
      readSlice: async (...args: Parameters<typeof surface.readSlice>) => {
        await beforeRead()
        return surface.readSlice(...args)
      },
    }
    const auxiliaryReaders = {
      agentInput: createAgentInputCursorReader(reader, sessionId),
      toolMeta: createToolResultDisplayMetaCursorReader(reader, sessionId),
      toolSummaries: createSessionToolSummaryReader(reader, sessionId),
    }
    const auxiliary = async () => ({
      agentInput: await auxiliaryReaders.agentInput.replay(),
      toolMeta: await auxiliaryReaders.toolMeta.replay(),
      toolSummaries: await auxiliaryReaders.toolSummaries.replay(),
    })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: reader, executionCwd: baseDir, auxiliarySource: "external", historyScope: "session" })
    const fresh = new SessionTranscriptProjection({ conversationId, sessionId, store: surface, executionCwd: baseDir, auxiliarySource: "external", historyScope: "session" })
    try {
      await projection.read(await auxiliary())
      await tree.appendMessage({ kind: "assistant", content: "final answer" })
      const appended = await auxiliary()
      foldedState = projection["state"]
      const overtaken = projection.read(appended)
      await reached.promise
      await tree.moveTo(first)
      // Rewind changes only the tree. The shared tool cursor is held by the
      // first read, and the unchanged auxiliary snapshot remains current.
      const newer = appended
      const readsBefore = stateReads
      const latest = projection.read(newer)
      // Lets the newer read run as far as it can before the held read resumes.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(stateReads).toBe(readsBefore)
      held.resolve()
      await Promise.all([overtaken, latest])

      const expected = await fresh.read(newer)
      expect((await projection.read(newer))?.blockCount).toBe(expected?.blockCount)
      expect((await projection.read(newer))?.tipEntryId).toBe(first)
    } finally {
      held.resolve()
      await projection.dispose()
      await fresh.dispose()
      tree.getStorage().dispose()
    }
  })

  it("returns null when the conversation tree is missing", async () => {
    const projection = new SessionTranscriptProjection({ conversationId: "missing", sessionId: "missing", store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    expect(await projection.read()).toBeNull()
    await projection.dispose()
  })

  it("keeps dangling tool history read-only across repeated transcript reads", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store, writer: immediateWriter() })
    await tree.appendMessages([
      { kind: "user", content: "run" },
      { kind: "assistant", content: [{ type: "tool_use", id: "dangling", name: "bash", input: { command: "echo" } }] },
    ])
    removeOwnerPid(sessionId, baseDir)
    const factCount = store.read({ aggregateId: `conversation:${conversationId}` }).length
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })

    const first = await projection.read()
    const second = await projection.read()

    expect((await blocks(first)).at(-1)).toMatchObject({ kind: "tool", status: "interrupted" })
    expect(second).toBe(first)
    expect(store.read({ aggregateId: `conversation:${conversationId}` })).toHaveLength(factCount)
    expect((await tree.getBranch()).some((entry) => entry.kind === "message" && entry.message.kind === "toolResult")).toBe(false)
    await projection.dispose()
    tree.getStorage().dispose()
  })

  it("preserves a durable pending ask_user gap during transcript reads", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store, writer: immediateWriter() })
    await tree.appendMessages([
      { kind: "user", content: "ask" },
      { kind: "assistant", content: [
        { type: "tool_use", id: "search-1", name: "search", input: {} },
        { type: "tool_use", id: "ask-1", name: "ask_user", input: {} },
      ] },
    ])
    appendSessionFact(sessionId, {
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      payload: {
        interactionId: "ask-1",
        conversationId,
        toolUseId: "ask-1",
        request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
      },
    })
    const factCount = store.read({ aggregateId: `conversation:${conversationId}` }).length
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })

    const history = await projection.read()

    expect((await blocks(history)).filter((block) => block.kind === "tool")).toHaveLength(1)
    expect((await blocks(history)).filter((block) => block.kind === "question")).toHaveLength(1)
    expect(store.read({ aggregateId: `conversation:${conversationId}` })).toHaveLength(factCount)
    expect((await tree.getBranch()).some((entry) => entry.kind === "message" && entry.message.kind === "toolResult")).toBe(false)
    await projection.dispose()
    tree.getStorage().dispose()
  })
})

