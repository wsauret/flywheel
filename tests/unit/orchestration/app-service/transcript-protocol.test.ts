import { afterEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreReadSurface, type EventStore } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { HydratedOutputBlockBodySchema, HydratedOutputGroupChildrenBatchSchema, HydratedOutputGroupChildrenSchema, HydratedOutputRangeSchema, OutputGroupChildrenRequestSchema, OutputRangeRequestSchema } from "../../../../src/protocol/transcript-protocol-schemas.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import type { ChatSessionEntry } from "../../../../src/orchestration/session-store/types.js"
import type { WorkflowView, AttemptRow } from "../../../../src/workflows/view/types.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"

async function openExistingTree(options: Parameters<typeof tryOpenConversationTree>[0]) {
  const tree = await tryOpenConversationTree(options)
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}
import { hydrateDerivedOutputRange, hydrateDerivedOutputBlockBody } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import type { HydratedOutputGroupChildren, HydratedOutputGroupChildrenBatch } from "../../../../src/protocol/transcript-protocol-types.js"
import { workflowControlInitializedEvent } from "../../workflows/vm/_workflow-control-fixtures.js"
import { historicalSessionCreatedFacts } from "../../../fixtures/tolerant-reprojection-fixtures.js"

function textBlock(index: number, content = `content-${index}`): AnyBlock {
  return { kind: "text", id: `text-${index}`, content, timestamp: index }
}

function chatEntry(overrides: Partial<ChatSessionEntry> = {}): ChatSessionEntry {
  return {
    ...entryRuntimeDefaults(() => [], 10),
    kind: "chat",
    runner: null,
    conversationId: "conv-1",
    description: "Chat title",
    outputBlocks: () => [textBlock(0, "hello")],
    outputSequenceStart: 0,
    streamingToolText: {},
    tokens: 12,
    cost: 0.25,
    contextPercent: 40,
    streamingOutputChars: 5,
    contextPromptTokens: 7,
    startedAt: 10,
    streamPhase: "thinking",
    runnerState: "absent",
    streamingStartedAt: null,
    accumulatedActiveMs: 3,
    connectionState: "connected",
    compactionStartedAt: null,
    activeSubagents: new Set<string>(),
    ...overrides,
  }
}

describe("bounded output history protocol", () => {
  it("serves ordered user images only through lazy body reads, not range codecs", async () => {
    const images = [{ mediaType: "image/png", data: "aGk=" }, { mediaType: "image/jpeg", data: "Ynll" }]
    const block = { kind: "userMessage" as const, id: "u1", content: "[Image #1] [Image #2]", timestamp: 1, pending: false, injected: false, images }
    const history = { ...indexOutputBlocks([block]), consistencyToken: "sequence:v1" }
    const range = await hydrateDerivedOutputRange(history, { anchor: { kind: "tail" }, maxBlocks: 1, maxBytes: 1024 })
    if (range.kind !== "ok") throw new Error("expected image range")
    expect(range.blocks).toEqual([{ kind: "userMessage", id: "u1", content: block.content, timestamp: 1, pending: false, injected: false, imageCount: 2 }])
    expect(Schema.decodeUnknownSync(HydratedOutputRangeSchema)(range, { onExcessProperty: "error" })).toEqual(range)
    expect(() => Schema.decodeUnknownSync(HydratedOutputRangeSchema)({ ...range, blocks: [block] }, { onExcessProperty: "error" })).toThrow()
    const body = await hydrateDerivedOutputBlockBody(history, { blockId: "userMessage:u1" })
    expect(body).toEqual({ blockId: "userMessage:u1", images })
    expect(Schema.decodeUnknownSync(HydratedOutputBlockBodySchema)(body, { onExcessProperty: "error" })).toEqual(body)
    const missing = await hydrateDerivedOutputBlockBody(history, { blockId: "userMessage:retired" })
    expect(missing).toEqual({ blockId: "userMessage:retired", missing: true })
    expect(Schema.decodeUnknownSync(HydratedOutputBlockBodySchema)(missing, { onExcessProperty: "error" })).toEqual(missing)
  })
  it("session_metadata unknown-older-version output-history reports session.created@1 and @2 unavailable", async () => {
    const { store, dir } = temporaryStore("flywheel-historical-output-")
    store.appendBatch(historicalSessionCreatedFacts("legacy-output"))
    const projection = detailProjection({ projectRoot: dir, store })
    for (const version of [1, 2]) {
      const range = await projection.outputRange(`legacy-output-${version}`, { anchor: { kind: "tail" }, maxBlocks: 1, maxBytes: 1024 })
      expect(range.kind, `session.created@${version}`).toBe("unavailable")
    }
    await projection.dispose()
  })

  it("rejects step anchors at the protocol schema boundary", () => {
    expect(() => Schema.decodeUnknownSync(OutputRangeRequestSchema)({
      anchor: { kind: "step", stepId: "step-1" },
      maxBlocks: 1,
      maxRows: 1,
      maxBytes: 1,
    }, { onExcessProperty: "error" })).toThrow()
  })

  it("rejects ambiguous block range anchors at the protocol schema boundary", () => {
    expect(() => Schema.decodeUnknownSync(OutputRangeRequestSchema)({
      anchor: { kind: "block", blockId: "text:text-1" },
      maxBlocks: 1,
      maxRows: 1,
      maxBytes: 1,
    }, { onExcessProperty: "error" })).toThrow()
  })

  it("preserves semantic result actions on hydrated group children", () => {
    const payload: HydratedOutputGroupChildrenBatch = {
      groups: [{
        groupBlockId: "agentGroup:a1",
        totalChildren: 1,
        contentBytes: 1,
        children: [{
          kind: "tool",
          id: "skill-1",
          name: "skill_manage",
          presentation: { name: "Save Skill", detail: "example" },
          status: "completed",
          resultAction: "created",
          timestamp: 1,
        }],
      }],
      contentBytes: 1,
    }

    expect(Schema.decodeUnknownSync(HydratedOutputGroupChildrenBatchSchema)(payload)).toEqual(payload)
  })

  it("preserves mutation artifacts on hydrated group children", async () => {
    const { buildMutationDiffEvidence } = await import("../../../../src/infra/mutation-diff-evidence.js")
    const mutationEvidence = await buildMutationDiffEvidence({
      version: 1, files: [{ path: ".flywheel/memory/project.md", change: "modified", unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new" }], omissions: [],
    }, "memory-1", async () => {})
    const payload: HydratedOutputGroupChildren = {
      groupBlockId: "agentGroup:a1",
      totalChildren: 1,
      contentBytes: 1,
      children: [{
        kind: "tool",
        id: "memory-1",
        name: "memory",
        presentation: { name: "Add Memory", detail: "Prefers tabs" },
        status: "completed",
        mutationEvidence,
        timestamp: 1,
      }],
    }

    expect(Schema.decodeUnknownSync(HydratedOutputGroupChildrenSchema)(payload)).toEqual(payload)
  })

  it("round-trips batched mixed-container children and bounds visible parent ids", () => {
    const child = { kind: "tool" as const, id: "read-1", name: "read", presentation: { name: "Read", detail: "a.ts" }, status: "completed" as const, timestamp: 1 }
    const payload = { groups: [
      { groupBlockId: "agentGroup:subagent-1", totalChildren: 1, contentBytes: 1, children: [child] },
      { groupBlockId: "agentGroup:code-1", totalChildren: 0, contentBytes: 0, children: [] },
    ], contentBytes: 1, nextCursor: { groupBlockId: "agentGroup:subagent-1", childIndex: 1 } }
    expect(Schema.decodeUnknownSync(HydratedOutputGroupChildrenBatchSchema)(payload)).toEqual(payload)
    expect(() => Schema.decodeUnknownSync(OutputGroupChildrenRequestSchema)({ groupBlockIds: [], maxBytes: 1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(OutputGroupChildrenRequestSchema)({ groupBlockIds: Array.from({ length: 101 }, (_, i) => `agentGroup:${i}`), maxBytes: 1 })).toThrow()
  })

  it("rejects removed generation and server-provided height estimates at the protocol schema boundary", () => {
    const window = { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 }
    expect(() => Schema.decodeUnknownSync(HydratedOutputRangeSchema)({
      kind: "ok",
      consistencyToken: null,
      anchor: { kind: "tail" },
      window,
      heightEstimates: [],
      blocks: [],
      streamingToolText: {},
    }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(HydratedOutputRangeSchema)({
      kind: "ok",
      consistencyToken: null,
      generation: null,
      anchor: { kind: "tail" },
      window,
      blocks: [],
      streamingToolText: {},
    }, { onExcessProperty: "error" })).toThrow()
  })

  it("omits Code source with byte metadata and serves the exact invocation body separately", async () => {
    const source = "return 'é  \\n'\n"
    const block: AnyBlock = {
      kind: "tool",
      id: "code-1",
      name: "code",
      presentation: { name: "Code", detail: "" },
      status: "completed",
      invocationBody: { content: source, filetype: "javascript" },
      content: "é  \n",
      timestamp: 1,
    }
    const history = { ...indexOutputBlocks([block]), consistencyToken: "sequence:v1" }
    const range = await hydrateDerivedOutputRange(history, { anchor: { kind: "tail" }, maxBlocks: 1, maxBytes: 32_768 })
    if (range.kind !== "ok" || range.blocks[0]?.kind !== "tool") throw new Error("expected Code tool range")
    expect(range.blocks[0].invocationBody).toBeUndefined()
    expect(range.blocks[0].invocationBodyOmittedBytes).toBe(Buffer.byteLength(source, "utf8"))
    expect(range.blocks[0].contentOmittedLines).toBe(2)
    expect(await hydrateDerivedOutputBlockBody(history, { blockId: "tool:code-1" })).toEqual({
      blockId: "tool:code-1",
      invocationBody: { content: source, filetype: "javascript" },
      content: "é  \n",
    })
  })

  it("rejects a tool-body request whose identity is absent or not a tool block", async () => {
    const tool: AnyBlock = {
      kind: "tool", id: "edit-1", name: "edit", presentation: { name: "Edit", detail: "src/sanitized-example.ts" },
      status: "completed", timestamp: 1,
    }
    const history = { ...indexOutputBlocks([tool, textBlock(1)]), consistencyToken: "sequence:v1" }

    await expect(hydrateDerivedOutputBlockBody(history, { blockId: "tool:missing" })).rejects.toThrow("is missing from derived history")
    await expect(hydrateDerivedOutputBlockBody(history, { blockId: "text:text-1" })).rejects.toThrow("is missing from derived history")
  })

  it("session detail is source-discriminated and transcript-free while outputRange owns transcript reads", async () => {
    const projection = detailProjection({ manager: { read: async () => durableSession() } })

    const durable = (await projection.sessionDetail("durable-chat")).view
    expect(durable?.source).toBe("durable")
    expect(durable && "outputBlocks" in durable).toBe(false)
    expect(durable && "streamingToolText" in durable).toBe(false)

    const liveProjection = detailProjection({
      sessionStore: { get: () => chatEntry({ outputBlocks: () => [textBlock(0, "live")], streamingToolText: { "tool-1": { content: "streaming" } } }) },
      manager: { read: async () => ({ ...durableSession(), conversationId: "conv-live" }) },
    })
    const live = (await liveProjection.sessionDetail("live-chat")).view
    expect(live?.source).toBe("live")
    expect(live?.row.lifecycleState).toBe("inactive")
    expect(live && "outputBlocks" in live).toBe(false)
    expect(live?.source === "live" ? live.streamingToolText : {}).toEqual({ "tool-1": { content: "streaming" } })
  })

  it("reads live image bodies before history can replace their display row", async () => {
    const images = [{ mediaType: "image/png", data: "aGk=" }]
    let blocks: readonly AnyBlock[] = [{
      kind: "userMessage", id: "live-image", timestamp: 1, pending: false, injected: false,
      content: "[Image #1]", images,
    }]
    const entry = chatEntry({ outputBlocks: () => blocks })
    const projection = detailProjection({
      sessionStore: { get: () => entry },
      manager: { read: async () => {
        blocks = []
        return durableSession()
      } },
    })
    try {
      expect(await projection.outputBlockBody("live-chat", { blockId: "userMessage:live-image" })).toEqual({
        blockId: "userMessage:live-image", images,
      })
    } finally { await projection.dispose() }
  })

  it("projects only the requested live block for a body read, however long the live tail", async () => {
    const images = [{ mediaType: "image/png", data: "aGk=" }]
    const projectedPerBody = async (blockCount: number): Promise<number> => {
      const ids = Array.from({ length: blockCount }, (_, index) => `live-image-${index}`)
      const blocks: AnyBlock[] = ids.map((id, index) => ({ kind: "userMessage", id, timestamp: index, pending: false, injected: false, content: "[Image #1]", images }))
      const entry = chatEntry({ outputBlocks: () => blocks })
      const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
      const deps = { projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => entry }, manager: { read: async () => durableSession() }, reader, projectionReader: reader }
      const cache = createTranscriptProjectionCache(deps)
      let projected = 0
      const projection = createSessionDetailProjection({ ...deps, transcriptCache: { ...cache, projectBlock: (sessionId, block) => { projected += 1; return cache.projectBlock(sessionId, block) } } })
      try {
        for (const id of ids) {
          const blockId = `userMessage:${id}`
          expect(await projection.outputBlockBody("live-chat", { blockId })).toEqual({ blockId, images })
        }
        return projected / blockCount
      } finally {
        await projection.dispose()
        await cache.dispose()
      }
    }
    expect(await projectedPerBody(4)).toBe(1)
    expect(await projectedPerBody(64)).toBe(1)
  })

  it("hydrates historical chat ranges from chat tree facts", async () => {
    const { store } = temporaryStore("flywheel-derived-chat-history-")
    const tree = await createConversationTree({ conversationId: "conv-durable", sessionId: "durable-chat", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const appended = await tree.appendMessages([
      { kind: "user", content: [{ type: "text", text: "hello [Image #1]" }, { type: "image", mediaType: "image/png", data: "aGk=" }] },
      { kind: "assistant", content: "hi from the tree" },
    ])
    if (appended.kind !== "committed") throw new Error("expected committed chat tree entries")
    const assistantEntryId = appended.ids[1]
    if (!assistantEntryId) throw new Error("expected assistant entry id")
    tree.getStorage().dispose()
    let conversationReads = 0
    const reader: EventStoreReadSurface = {
      ...store,
      readTolerant: (query = {}) => {
        if (query.aggregateId === "conversation:conv-durable" && query.afterPosition !== undefined) conversationReads += 1
        return store.readTolerant(query)
      },
    }

    const projection = detailProjection({ manager: { read: async () => durableSession() }, store: reader })

    const history = await projection.outputWindow("durable-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(history.totalBlocks).toBe(2)
    expect(history.visibleMessageCount).toBe(2)
    expect(history.range.consistencyToken).toMatch(/^chat-tree:v2:[a-f0-9]{24}$/)
    expect(history.range.consistencyToken).not.toContain("output-history")

    const range = await projection.outputRange("durable-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(range.kind).toBe("ok")
    if (range.kind !== "ok") throw new Error("expected derived chat range")
    if (history.range.kind !== "ok") throw new Error("expected derived chat window")
    expect(range.consistencyToken).toBe(history.range.consistencyToken)
    expect(range.blocks[1]).toMatchObject({ kind: "text", id: assistantEntryId })
    expect(range.blocks.map((block) => block.kind === "userMessage" || block.kind === "text" ? block.content : "")).toEqual(["hello [Image #1]", "hi from the tree"])
    expect(range.blocks[0]).toMatchObject({ kind: "userMessage", imageCount: 1 })
    expect(conversationReads).toBe(1)
    expect(await projection.outputBlockBody("durable-chat", { blockId: `userMessage:${appended.ids[0]}` })).toEqual({
      blockId: `userMessage:${appended.ids[0]}`, images: [{ mediaType: "image/png", data: "aGk=" }],
    })

    const refreshedTree = await openExistingTree({ conversationId: "conv-durable", sessionId: "durable-chat", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const refreshedTip = await refreshedTree.appendMessage({ kind: "user", content: "new durable fact" })
    refreshedTree.getStorage().dispose()
    const refreshed = await projection.outputRange("durable-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    if (refreshed.kind !== "ok") throw new Error("expected refreshed chat range")
    expect(refreshed.consistencyToken).not.toBe(range.consistencyToken)
    expect(refreshed.blocks.at(-1)).toMatchObject({ kind: "userMessage", id: refreshedTip })
    expect(refreshed.blocks.at(-1)).toMatchObject({ kind: "userMessage", content: "new durable fact" })
    expect(conversationReads).toBe(2)
    await projection.dispose()
  })

  it("reads the tool rows of one range page in a few batched state reads, not one for each row", async () => {
    const { store } = temporaryStore("flywheel-derived-chat-page-")
    const toolCount = 300
    const tree = await createConversationTree({ conversationId: "conv-durable", sessionId: "durable-chat", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "assistant", content: Array.from({ length: toolCount }, (_, index) => ({
      type: "tool_use" as const, id: `read-${index}`, name: "read", input: { path: `file-${index}` },
    })) })
    tree.getStorage().dispose()
    for (let index = 0; index < toolCount; index += 1) {
      store.append({ aggregateId: "session:durable-chat", sessionId: "durable-chat", timestamp: index, type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: `read-${index}`, output: `output-${index}` } })
    }
    const surface = asAsyncEventReadSurface(store)
    let sourceReads = 0
    const reader = {
      ...surface,
      readSlice: (...args: Parameters<typeof surface.readSlice>) => {
        if (args[0].positions !== undefined) sourceReads += 1
        return surface.readSlice(...args)
      },
      readPage: (...args: Parameters<typeof surface.readPage>) => {
        if (args[0].positions !== undefined) sourceReads += 1
        return surface.readPage(...args)
      },
    }
    const projection = createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => undefined },
      manager: { read: async () => durableSession() },
      reader,
      projectionReader: reader,
    })

    const range = await projection.outputRange("durable-chat", { anchor: { kind: "tail" }, maxBlocks: toolCount, maxBytes: 4 * 1024 * 1024 })
    if (range.kind !== "ok") throw new Error("expected derived chat range")

    expect(range.blocks).toHaveLength(toolCount)
    expect(range.blocks.at(-1)).toMatchObject({ kind: "tool", id: `read-${toolCount - 1}` })
    // Read-ahead batches of 16, 32, 64, 128, and 60 rows.
    expect(sourceReads).toBe(5)
    await projection.dispose()
  })

  it("refuses a workflow's outputWindow and outputRange, because each agent's view reads that agent's conversation", async () => {
    const { store } = temporaryStore("flywheel-derived-workflow-history-")
    appendWorkflowQueue(store, "durable-workflow", "conv-workflow-step")
    const tree = await createConversationTree({ conversationId: "conv-workflow-step", sessionId: "durable-workflow", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const appended = await tree.appendMessages([
      { kind: "user", content: "worker prompt" },
      { kind: "assistant", content: "workflow output from the tree" },
    ])
    if (appended.kind !== "committed") throw new Error("expected committed workflow tree entries")
    tree.getStorage().dispose()

    const projection = detailProjection({ manager: { read: async () => workflowSession() }, store })
    const request = { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 } as const

    const history = await projection.outputWindow("durable-workflow", request)
    expect(history.totalBlocks).toBe(0)
    expect(history.range).toMatchObject({ kind: "unavailable", unavailable: { title: "A workflow has no transcript" } })
    expect(await projection.outputRange("durable-workflow", request)).toMatchObject({ kind: "unavailable", unavailable: { title: "A workflow has no transcript" } })
  })

  it("active outputRange reads the live in-memory tail", async () => {
    const projection = detailProjection({
      sessionStore: { get: () => chatEntry({ outputBlocks: () => [textBlock(0), textBlock(1), textBlock(2, "live-tail")], visibleMessageCountSuffix: 3 }) },
    })

    const history = await projection.outputWindow("live-chat", { anchor: { kind: "tail" }, maxBlocks: 2, maxBytes: 1024 * 1024 })
    expect(history.range.consistencyToken).toBe("output-empty:v1:runtime:0")
    expect(history.totalBlocks).toBe(3)
    expect(history.visibleMessageCount).toBe(3)
    expect(history.range.window.startBlockIndex).toBe(1)
    expect(history.range.window.endBlockIndex).toBe(2)

    const range = await projection.outputRange("live-chat", { anchor: { kind: "tail" }, maxBlocks: 2, maxBytes: 1024 * 1024 })
    expect(range.kind).toBe("ok")
    if (range.kind !== "ok") throw new Error("expected live range")
    expect(range.consistencyToken).toBe("output-empty:v1:runtime:0")
    expect(range.blocks.map((block) => block.kind === "text" ? block.content : "")).toEqual(["content-1", "live-tail"])
  })

  it("joins a durable prefix to an unflushed runtime tail and resolves its identity anchor", async () => {
    const { store } = temporaryStore("flywheel-output-sequence-")
    const tree = await createConversationTree({ conversationId: "conv-sequence", sessionId: "mixed-chat", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const appended = await tree.appendMessages([
      { kind: "user", content: "durable-prefix" },
      { kind: "assistant", content: "durable-context" },
    ])
    if (appended.kind !== "committed") throw new Error("expected committed sequence entries")
    tree.getStorage().dispose()
    const runtimeBlocks = [textBlock(1, "durable-context"), textBlock(2, "unflushed-tail")]
    const projection = detailProjection({
      sessionStore: {
        get: () => chatEntry({ conversationId: "conv-sequence", outputSequenceStart: 1, visibleMessageCountPrefix: 1, visibleMessageCountSuffix: 2, outputBlocks: () => runtimeBlocks }),
        revision: () => 7,
      },
      manager: { read: async () => ({ ...durableSession(), conversationId: "conv-sequence" }) },
      store,
    })

    const history = await projection.outputWindow("mixed-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(history.totalBlocks).toBe(3)
    expect(history.visibleMessageCount).toBe(3)
    expect(history.range.consistencyToken).toEndWith(":runtime:7")
    const range = await projection.outputRange("mixed-chat", { anchor: { kind: "beforeBlock", blockId: "text:text-2" }, maxBlocks: 3, maxBytes: 1024 * 1024 })
    if (range.kind !== "ok") throw new Error("expected mixed sequence range")
    expect(range.blocks.map((block) => block.kind === "userMessage" || block.kind === "text" ? block.content : "")).toEqual(["durable-prefix", "durable-context", "unflushed-tail"])
  })

  it("refreshes a resident durable prefix across a live save-point seam", async () => {
    const { store } = temporaryStore("flywheel-output-save-point-seam-")
    const tree = await createConversationTree({ conversationId: "conv-save-point", sessionId: "live-save-point", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const initialTip = await tree.appendMessage({ kind: "user", content: "durable-prefix" })
    tree.getStorage().dispose()

    let runtimeBlocks = [textBlock(1, "live-context"), textBlock(2, "unflushed-tail")]
    let runtimeRevision = 11
    const entry = chatEntry({
      conversationId: "conv-save-point",
      outputSequenceStart: 1,
      outputBlocks: () => runtimeBlocks,
    })
    const projection = detailProjection({
      sessionStore: { get: () => entry, revision: () => runtimeRevision },
      manager: { read: async () => ({ ...durableSession(), conversationId: "conv-save-point" }) },
      store,
    })

    const beforeCommit = await projection.outputRange("live-save-point", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    if (beforeCommit.kind !== "ok") throw new Error("expected pre-commit live range")
    expect(beforeCommit.consistencyToken).toMatch(/^chat-tree:v2:[a-f0-9]{24}:runtime:11$/)
    expect(beforeCommit.blocks[0]).toMatchObject({ kind: "userMessage", id: initialTip })
    expect(beforeCommit.blocks.map((block) => block.kind === "userMessage" || block.kind === "text" ? block.content : "")).toEqual([
      "durable-prefix",
      "live-context",
      "unflushed-tail",
    ])

    const refreshedTree = await openExistingTree({ conversationId: "conv-save-point", sessionId: "live-save-point", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const committedTip = await refreshedTree.appendMessage({ kind: "assistant", content: "live-context" })
    refreshedTree.getStorage().dispose()
    entry.outputSequenceStart = 2
    runtimeBlocks = [textBlock(2, "unflushed-tail"), textBlock(3, "next-unflushed-tail")]
    runtimeRevision = 12

    const afterCommit = await projection.outputRange("live-save-point", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    if (afterCommit.kind !== "ok") throw new Error("expected post-commit live range")
    expect(afterCommit.consistencyToken).toMatch(/^chat-tree:v2:[a-f0-9]{24}:runtime:12$/)
    expect(afterCommit.consistencyToken.split(":runtime:")[0]).not.toBe(beforeCommit.consistencyToken.split(":runtime:")[0])
    expect(afterCommit.blocks[1]).toMatchObject({ kind: "text", id: committedTip })
    expect([afterCommit.window.startBlockIndex, afterCommit.window.endBlockIndex]).toEqual([0, 3])
    expect(afterCommit.blocks.map((block) => block.kind === "userMessage" || block.kind === "text" ? block.content : "")).toEqual([
      "durable-prefix",
      "live-context",
      "unflushed-tail",
      "next-unflushed-tail",
    ])
    await projection.dispose()
  })

  it("a freshly created session (live entry, no catalog metadata) serves an empty view, not unavailable", async () => {
    const projection = detailProjection({ sessionStore: { get: () => chatEntry({ outputBlocks: () => [] }) } })

    const history = await projection.outputWindow("fresh-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(history.range.kind).toBe("ok")
    expect(history.totalBlocks).toBe(0)

    const range = await projection.outputRange("fresh-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(range.kind).toBe("ok")
    if (range.kind !== "ok") throw new Error("expected empty live range")
    expect(range.blocks).toEqual([])
  })

  it("a session with neither a live entry nor catalog metadata is unavailable", async () => {
    const projection = detailProjection()

    const history = await projection.outputWindow("gone-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(history.range.kind === "unavailable" ? history.range.unavailable.title : undefined).toBe("Session history unavailable")

    const range = await projection.outputRange("gone-chat", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(range.kind).toBe("unavailable")
  })

  it("active cursor-inclusive outputRange preserves the two-block anchor window even when it exceeds the byte budget", async () => {
    const projection = detailProjection({ sessionStore: { get: () => chatEntry({ outputBlocks: () => [textBlock(0), textBlock(1, "large"), textBlock(2)] }) } })

    const range = await projection.outputRange("live-chat", { anchor: { kind: "beforeBlock", blockId: "text:text-2" }, maxBlocks: 3, maxBytes: 1 })
    expect(range.kind).toBe("ok")
    if (range.kind !== "ok") throw new Error("expected live range")
    expect(range.consistencyToken).toBe("output-empty:v1:runtime:0")
    expect(range.blocks.map((block) => block.kind === "text" ? block.id : "")).toEqual(["text-1", "text-2"])
  })

  it("visible message count is unchanged when content is appended to an existing message", () => {
    const initial = indexOutputBlocks([textBlock(1, "part")])
    const appended = indexOutputBlocks([textBlock(1, "part two")])

    expect(initial.visibleMessageCount).toBe(1)
    expect(appended.visibleMessageCount).toBe(initial.visibleMessageCount)
  })

})

const openStores: { readonly store: EventStore; readonly dir: string }[] = []
afterEach(() => {
  // Each store closes before its directory goes, which Windows requires.
  for (const { store, dir } of openStores.splice(0)) {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A SQLite event store in a temporary directory that the calling case owns
 *  until the case ends, whether it passed or failed. */
function temporaryStore(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const opened = { store: createSqliteEventStore(join(dir, "flywheel.sqlite")), dir }
  openStores.push(opened)
  return opened
}

/** A session detail projection whose reader and projection reader are both
 *  `store`. A part the case leaves out reads as no session. */
function detailProjection(options: Partial<Pick<Parameters<typeof createSessionDetailProjection>[0], "projectRoot" | "sessionStore" | "manager">> & {
  readonly store?: Parameters<typeof asAsyncEventReadSurface>[0]
} = {}) {
  const reader = asAsyncEventReadSurface(options.store ?? inMemoryEventReader([]))
  return createSessionDetailProjection({
    projectRoot: options.projectRoot ?? FIXTURE_EXECUTION_CWD,
    sessionStore: options.sessionStore ?? { get: () => undefined },
    manager: options.manager ?? { read: async () => null },
    reader,
    projectionReader: reader,
  })
}

function durableSession() {
  return {
    label: "Durable",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState: "inactive" as const,
    executionCwd: FIXTURE_EXECUTION_CWD,
    name: "Durable",
    kind: "chat" as const,
    command: "chat" as const,
    conversationId: "conv-durable",
    seedContext: "resume context",
  }
}

function workflowSession() {
  return {
    label: "Workflow request",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState: "inactive" as const,
    executionCwd: FIXTURE_EXECUTION_CWD,
    name: "Workflow request",
    kind: "workflow" as const,
    command: "workflow" as const,
    workflowDefinitionId: "Workflow request",
  }
}

function appendWorkflowQueue(store: EventStore, sessionId: string, conversationId: string): void {
  const queue: WorkflowView = {
    attempts: [workflowStep(conversationId)],
    tree: plainAgentTree([workflowStep(conversationId)]),
    cursor: 1,
    status: "completed",
    mutationLog: [{ timestamp: 0, action: "status-change", actor: "flywheel", reason: "completed", attemptIds: ["step-1"] }],
  }
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "session.created",
    version: 3,
    timestamp: 0,
    actor: "flywheel",
    sessionId,
    payload: workflowSession(),
  })
  store.append(workflowControlInitializedEvent(sessionId, 0))
  for (const fact of queueFactsForState(null, queue)) store.append({
    aggregateId: `workflow:${sessionId}`, timestamp: 0, sessionId, ...fact,
  })
}

function workflowStep(conversationId: string): AttemptRow {
  return {
    id: "step-1",
    definitionId: "implement",
    briefId: "implement",
    workflowDefinitionId: "workflow",
    name: "Implement",
    status: "completed",
    writes: [],
    resumeRevertCount: 0,
    lastConversationId: conversationId,
  }
}
