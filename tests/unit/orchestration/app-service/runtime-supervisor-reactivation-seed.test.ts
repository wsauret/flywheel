import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { RuntimeEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createRuntimeSupervisor as createRuntimeSupervisorBase } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection.js"
import { readOutputSequence, type OutputSequenceDeps } from "../../../../src/orchestration/app-service/output-sequence.js"
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection.js"
import { createToolExecutionProjection, loadToolExecutionTimelineFromEvents, TOOL_EXECUTION_FACT_TYPES } from "../../../../src/orchestration/session/tool-execution-projection.js"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation.js"
import { addSubagentChild } from "../session/_child-session-reconciliation-fixtures.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

async function openExistingTree(options: Parameters<typeof tryOpenConversationTree>[0]) {
  const tree = await tryOpenConversationTree(options)
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { mockRunner, supervisorBaseDeps, createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

const createRuntimeSupervisor = createRuntimeSupervisorBase

const { chatConversationId, appendConversation, commitUserTurn } = supervisorConversationFixture(() => ctx)

async function appendPendingQuestion(sessionId: string, interrupted = false): Promise<string> {
  const conversationId = await chatConversationId(sessionId)
  await appendConversation(sessionId, [
    { kind: "user", content: "Ask me" },
    { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
    ...(interrupted ? [{ kind: "system" as const, content: "Interrupted by user.", displayOnly: true }] : []),
  ])
  await ctx.store.append({
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "agent_input.requested",
    version: 3,
    actor: "agent",
    timestamp: 1,
    payload: {
      interactionId: "ask-1",
      conversationId,
      toolUseId: "ask-1",
      request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
    },
  })
  return conversationId
}

let ctx: SupervisorTestContext

function transcriptCache(sessionId: string): OutputSequenceDeps["transcriptCache"] {
  return {
    projectBlock: async (_sessionId, block) => block,
    read: async (_sessionId, conversationId, executionCwd) => {
      const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), executionCwd })
      try { return await projection.read() } finally { await projection.dispose() }
    },
    createSessionReader: () => { throw new Error("workflow reader is not used") },
    children: async () => { throw new Error("group reader is not used") },
    projectGroupChildren: (indexed) => indexed,
  }
}

beforeEach(() => {
  ctx = createSupervisorTestContext()
})

afterEach(async () => {
  await disposeSupervisorTestContext(ctx)
})

describe("RuntimeSupervisor re-activation seeds prior history into the shell", () => {
  test("activateSession opens the shell with the reconstructed prior blocks as DISPLAY blocks", async () => {
    const sessionId = "reactivate-seed"
    await ctx.manager.createChat({ name: "Reopened Chat", initialState: "inactive", id: sessionId })
    await ctx.manager.updateLabel(sessionId, { label: "Reopened Chat", shortLabel: "Reopen" }, "generated")
    const answer = Array.from({ length: 40 }, (_, i) => String(i + 1)).join("\n")
    await appendConversation(sessionId, [
      { kind: "user", content: "Output the numbers 1 to 40" },
      { kind: "assistant", content: answer },
    ])

    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)

    const entry = ctx.sessionStore.get(sessionId)
    expect(entry?.kind).toBe("chat")
    expect(entry?.shortDescription).toBe("Reopen")
    // A short history fits inside the bounded display input, while the logical
    // sequence starts at the first durable block.
    const blocks = entry?.outputBlocks() ?? []
    expect(blocks.map((block) => block.kind === "userMessage" || block.kind === "text" ? block.content : "")).toEqual(["Output the numbers 1 to 40", answer])
    expect(entry?.outputSequenceStart).toBe(0)
    expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
    // seedContext (the model-resume path) is independent of the display blocks.
    expect(entry?.kind === "chat" ? entry.outputBlocks().length : 0).toBe(2)

    await supervisor.disposeAll()
  })

  test("reactivation joins nested execute rows on the durable sequence baseline", async () => {
    const sessionId = "reactivate-nested-execute"
    await ctx.manager.createChat({ name: "Nested Execute", initialState: "inactive", id: sessionId })
    const messages: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "code-before-tail", name: "code", input: { source: "before tail" } }] },
      ...Array.from({ length: 70 }, (_, index): ConversationMessage => ({ kind: "user", content: `line ${index}` })),
      { kind: "assistant", content: [{ type: "tool_use", id: "code-in-tail", name: "code", input: { source: "in tail" } }] },
    ]
    await appendConversation(sessionId, messages)
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(ctx.store) })
    for (const [parentId, childId] of [["code-before-tail", "read-before-tail"], ["code-in-tail", "read-in-tail"]] as const) {
      for (const event of [
        createRuntimeEvent("tool.input.completed", {
          model_request_id: `request-${childId}`,
          tool_use: { id: childId, name: "read", provider_call_id: `call-${childId}`, provider_tool_name: "read", executable_tool_name: "read", input: { path: `${childId}.ts` }, execution: { mode: "foreground", trace_kind: "tool" } },
          parent_tool_use_id: parentId,
        }),
        createRuntimeEvent("tool.result.recorded", {
          model_request_id: `request-${childId}`,
          tool_use_id: childId,
          content: [{ type: "text", text: childId }],
          outcome: "ok",
          is_error: false,
          parent_tool_use_id: parentId,
        }),
      ]) {
        for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) await writer.record(fact)
      }
    }
    writer.dispose()

    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    const entry = ctx.sessionStore.get(sessionId)
    const seed = entry?.outputBlocks() ?? []
    const codeIndex = seed.findIndex((block) => block.kind === "tool" && block.id === "code-in-tail")
    expect(seed[codeIndex + 1]).toMatchObject({ id: "read-in-tail", runCategoryOverride: "execute" })

    const durable = await readOutputSequence(sessionId, await ctx.manager.read(sessionId), {
      sessionStore: { get: () => undefined },
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      projectRoot: ctx.baseDir,
      transcriptCache: transcriptCache(sessionId),
    })
    expect(entry?.outputSequenceStart).toBe((durable?.blockCount ?? 0) - seed.length)
    expect(durable?.indexOf("tool:read-before-tail")).toBeGreaterThanOrEqual(0)

    await supervisor.disposeAll()
  })

  test("reactivation joins durable and runtime visible message counts without double counting", async () => {
    const sessionId = "reactivate-visible-count"
    await ctx.manager.createChat({ name: "Visible Count", initialState: "inactive", id: sessionId })
    await appendConversation(sessionId, Array.from(
      { length: 70 },
      (_, index): ConversationMessage => ({ kind: "user", content: `line ${index}` }),
    ))
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(ctx.sessionStore.get(sessionId)?.visibleMessageCountPrefix).toBe(6)
    expect(ctx.sessionStore.get(sessionId)?.visibleMessageCountSuffix).toBe(64)
    expect(ctx.sessionStore.appendPreRunnerOutput(sessionId, {
      kind: "text",
      id: "runtime-text",
      content: "runtime",
      timestamp: 100,
    })).toBe(true)

    const output = await readOutputSequence(sessionId, await ctx.manager.read(sessionId), {
      sessionStore: ctx.sessionStore,
      reader: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      projectRoot: ctx.baseDir,
      transcriptCache: transcriptCache(sessionId),
    })

    expect(output?.visibleMessageCount).toBe(71)
    await supervisor.disposeAll()
  })

  test("activation folds its conversation tree once", async () => {
    const sessionId = "reactivate-single-tree-fold"
    await ctx.manager.createChat({ name: "Single Fold", initialState: "inactive", id: sessionId, initialRoles: {} })
    await commitUserTurn(sessionId)
    const conversationId = await chatConversationId(sessionId)
    if (!conversationId) throw new Error("missing conversationId")
    let treeFolds = 0
    const reader: RuntimeEventStore = {
      ...ctx.store,
      readTolerant: (query = {}) => {
        if (query.aggregateId === `conversation:${conversationId}` && query.afterPosition !== undefined) treeFolds += 1
        return ctx.store.readTolerant(query)
      },
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      store: asAsyncEventReadSurface(reader),
      projectionReader: asAsyncEventReadSurface(reader),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    // The registered tolerant projection folds the conversation tree once and
    // serves both recovery and display from that state.
    expect(treeFolds).toBe(1)
    await supervisor.disposeAll()
  })

  test("activation folds its tool history once while other sessions churn the tool-execution family", async () => {
    const sessionId = "reactivate-single-tool-fold"
    await ctx.manager.createChat({ name: "Single Tool Fold", initialState: "inactive", id: sessionId, initialRoles: {} })
    await commitUserTurn(sessionId)
    const conversationId = await chatConversationId(sessionId)
    if (!conversationId) throw new Error("missing conversationId")
    await addSubagentChild(ctx.store, ctx.store, ctx.baseDir, sessionId, conversationId, 0, "completed")
    let toolFolds = 0
    const reader: RuntimeEventStore = {
      ...ctx.store,
      read: (query = {}) => {
        if (query.aggregateId === `session:${sessionId}` && query.types?.includes("tool.result.acknowledged") && query.afterPosition === 0) toolFolds += 1
        return ctx.store.read(query)
      },
    }
    const projectionReader = asAsyncEventReadSurface(reader)
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, {
        reconcileChildSessionCompletions: async (parentSessionId, options) => {
          const swept = await reconcileChildSessionCompletions({ parentSessionId, reader: projectionReader, projectionReader, writer: asAsyncEventWriter(ctx.store), ...options })
          // Other sessions open their tool stores while this chat activates.
          for (let i = 0; i < 9; i += 1) createToolExecutionProjection(projectionReader, `churn-${i}`)
          return swept
        },
      }),
      store: projectionReader,
      projectionReader,
      sessionViewLoader: { load: (id) => loadSessionView(id, projectionReader, projectionReader) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(toolFolds).toBe(1)
    await supervisor.disposeAll()
  })

  test("activating a resident chat costs the same requests for 3 and 30 children and reads none of them", async () => {
    // The sweep settles the swept sessions when its reader can, so the counted reader offers it.
    const counter = countStateRequests({ ...asAsyncEventReadSurface(ctx.store), settleBefore: async () => {} })
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, {
        reconcileChildSessionCompletions: (parentSessionId, options) =>
          reconcileChildSessionCompletions({ parentSessionId, reader: counter.reader, projectionReader: counter.reader, writer: asAsyncEventWriter(ctx.store), ...options }),
      }),
      store: counter.reader,
      projectionReader: counter.reader,
      sessionViewLoader: { load: (id) => loadSessionView(id, counter.reader, counter.reader) },
    })
    const reactivation = async (children: number, firstChild: number) => {
      const sessionId = `resident-parent-${children}`
      await ctx.manager.createChat({ name: "Resident Parent", initialState: "inactive", id: sessionId, initialRoles: {} })
      await commitUserTurn(sessionId)
      const conversationId = await chatConversationId(sessionId)
      if (!conversationId) throw new Error("missing conversationId")
      for (let index = firstChild; index < firstChild + children; index += 1) await addSubagentChild(ctx.store, ctx.store, ctx.baseDir, sessionId, conversationId, index, "completed")
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(ctx.sessionStore.get(sessionId)?.runner?.sessionId).toBe(sessionId)
      counter.take()
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      return counter.take()
    }
    const few = await reactivation(3, 0)
    const many = await reactivation(30, 100)
    expect(many.length).toBe(few.length)
    expect(factsRead(many)).toBe(factsRead(few))
    for (const requests of [few, many]) {
      expect(requests.some((request) => request.method === "settleBefore")).toBe(false)
      expect(requests.some((request) => request.aggregateId?.startsWith("session:child-"))).toBe(false)
    }
    await supervisor.disposeAll()
  })

  test.each(["answer", "dismiss"] as const)("%s settles a durable question after ownerless history recovery", async (action) => {
    const sessionId = `reactivate-pending-question-${action}`
    await ctx.manager.createChat({ name: "Waiting Chat", initialState: "inactive", id: sessionId })
    const conversationId = await appendPendingQuestion(sessionId)
    removeOwnerPid(sessionId, ctx.baseDir)
    const history = new SessionTranscriptProjection({
      conversationId,
      sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      executionCwd: ctx.baseDir,
    })
    await history.read()
    await history.dispose()
    let resumes = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        resumeCommitted: () => { resumes += 1; return true },
      }) }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(ctx.sessionStore.get(sessionId)?.runner?.sessionId).toBe(sessionId)
    const settled = action === "answer"
      ? await supervisor.answerQuestion(sessionId, "ask-1", { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } })
      : await supervisor.cancelQuestion(sessionId, "ask-1")

    expect(settled).toEqual({ ok: true })
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), sessionId)).get("ask-1")?.kind).toBe(action === "answer" ? "answered" : "cancelled")
    expect(resumes).toBe(1)
    const tree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    const leaf = (await tree.getBranch()).at(-1)
    await tree.getStorage().dispose()
    expect(leaf?.kind === "message" && leaf.message.kind === "toolResult" ? leaf.message.toolUseId : null).toBe("ask-1")
    expect(leaf?.kind === "message" && leaf.message.kind === "toolResult" ? leaf.message.interrupted : undefined).not.toBe(true)

    await supervisor.disposeAll()
  })

  test.each(["answer", "dismiss"] as const)("%s keeps an interrupted durable question settled without reopening its tool exchange", async (action) => {
    const sessionId = `reactivate-interrupted-question-${action}`
    await ctx.manager.createChat({ name: "Interrupted Chat", initialState: "inactive", id: sessionId })
    const conversationId = await appendPendingQuestion(sessionId, true)
    removeOwnerPid(sessionId, ctx.baseDir)
    let resumes = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        resumeCommitted: () => { resumes += 1; return true },
      }) }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(ctx.sessionStore.get(sessionId)?.runner?.sessionId).toBe(sessionId)
    const settled = action === "answer"
      ? supervisor.answerQuestion(sessionId, "ask-1", { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } })
      : supervisor.cancelQuestion(sessionId, "ask-1")

    expect(await settled).toEqual({ ok: true })
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), sessionId)).get("ask-1")?.kind).toBe(action === "answer" ? "answered" : "cancelled")
    expect(resumes).toBe(0)
    const tree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    const branch = await tree.getBranch()
    await tree.getStorage().dispose()
    expect(branch.at(-1)).toMatchObject({
      kind: "message",
      message: { kind: "system", content: "Interrupted by user." },
      displayOnly: true,
    })
    expect(branch.some((entry) => entry.kind === "message" && entry.message.kind === "toolResult" && entry.message.toolUseId === "ask-1")).toBe(false)

    await supervisor.disposeAll()
  })

  test("activation over a settled durable question stays stationary until the user speaks", async () => {
    const sessionId = "reactivate-settled-question"
    await ctx.manager.createChat({ name: "Settled Chat", initialState: "inactive", id: sessionId })
    const conversationId = await chatConversationId(sessionId)
    if (!conversationId) throw new Error("missing conversationId")
    await appendConversation(sessionId, [
      { kind: "user", content: "Ask me" },
      { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
    ])
    await ctx.store.append({
      aggregateId: `session:${sessionId}`,
      sessionId,
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      timestamp: 1,
      payload: {
        interactionId: "ask-1",
        conversationId,
        toolUseId: "ask-1",
        request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
      },
    })
    // The answer committed durably, but the process exited before the tool
    // result reached the tree: the exact state that used to auto-resume.
    await ctx.store.append({
      aggregateId: `session:${sessionId}`,
      sessionId,
      type: "agent_input.answered",
      version: 3,
      actor: "user",
      timestamp: 2,
      payload: { interactionId: "ask-1", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } },
    })
    removeOwnerPid(sessionId, ctx.baseDir)
    let resumes = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        resumeCommitted: () => { resumes += 1; return true },
      }) }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)

    // Activation repaired the tree (the answer became a committed tool result)
    // but started no model turn.
    expect(resumes).toBe(0)
    expect(ctx.sessionStore.get(sessionId)?.runner?.sessionId).toBe(sessionId)
    const tree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    const leaf = (await tree.getBranch()).at(-1)
    await tree.getStorage().dispose()
    expect(leaf?.kind === "message" && leaf.message.kind === "toolResult" ? leaf.message.toolUseId : null).toBe("ask-1")

    await supervisor.disposeAll()
  })

  test("cold activation interrupts orphaned subagents and tells the model a new dispatch is required", async () => {
    const sessionId = "reactivate-orphaned-subagent"
    await ctx.manager.createChat({ name: "Crashed Chat", initialState: "inactive", id: sessionId })
    const modelRequestId = "request-before-crash"
    const toolUseId = "subagent-before-crash"
    const childRunId = "child-before-crash"
    await appendConversation(sessionId, [
      { kind: "user", content: "Run the reviewer" },
      {
        kind: "assistant",
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "subagent",
          input: { persona: "reviewer-elegance", description: "Locate runtime UI command seam" },
        }],
      },
    ])
    const aggregateId = `session:${sessionId}`
    await ctx.store.append({
      aggregateId,
      type: "prompt.assembled",
      version: 2,
      timestamp: 8,
      actor: "flywheel",
      sessionId,
      payload: {
        requestId: modelRequestId,
        conversationId: "provider-runtime-conversation",
        turn: 1,
        promptKind: "chat",
        systemPromptHash: "system-before-crash",
        systemPrompt: "test system prompt",
        toolSurfaceHash: "tools-before-crash",
        promptSha256: "a".repeat(64),
        messageCount: 2,
        estimatedContextTokens: 100,
        contextWindow: 100_000,
        treePointer: { conversationId: "provider-runtime-conversation", leafEntryId: "leaf-before-crash" },
      },
    })
    await ctx.store.append({
      aggregateId,
      type: "model.requested",
      version: 1,
      timestamp: 9,
      actor: "flywheel",
      sessionId,
      payload: {
        requestId: modelRequestId,
        conversationId: "provider-runtime-conversation",
        turn: 1,
        model: "test-model",
        accessProvider: "test",
        modelFamily: "test",
      },
    })
    await ctx.store.append({
      aggregateId,
      type: "tool.input.completed",
      version: 1,
      timestamp: 10,
      actor: "agent",
      sessionId,
      payload: {
        toolUseId,
        toolName: "subagent",
        input: { persona: "reviewer-elegance", description: "Locate runtime UI command seam" },
        inputBytes: 1,
        inputSha256: "input-sha",
        inputPreview: "reviewer",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: false,
        modelRequestId,
      },
    })
    await ctx.store.append({
      aggregateId,
      type: "child_run.created",
      version: 1,
      timestamp: 11,
      actor: "flywheel",
      sessionId,
      payload: {
        childRunId,
        kind: "subagent",
        toolUseId,
        modelRequestId,
        agentType: "reviewer-elegance",
        description: "Locate runtime UI command seam",
        model: "test-model",
        maxTurns: 4,
        tools: ["read", "search"],
      },
    })
    await ctx.store.append({
      aggregateId,
      type: "subagent.prompted",
      version: 3,
      timestamp: 12,
      actor: "flywheel",
      sessionId,
      payload: {
        childRunId,
        prompt: "Find the seam",
        task: "You are a reviewer",
        toolNames: ["read", "search"],
      },
    })

    // A new process would observe the old owner as dead. Remove this test
    // process's lock to reproduce that cold-start boundary.
    removeOwnerPid(sessionId, ctx.baseDir)

    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)
    expect(await supervisor.activateSession(sessionId)).toBe(true)

    const runs = loadSubagentRunsFromEvents(ctx.store.read({ aggregateId, types: SUBAGENT_RUN_FACT_TYPES }))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      childRunId,
      status: "interrupted",
      interruptionReason: "runtime_restarted",
    })
    expect(ctx.store.read({ aggregateId, types: ["subagent.interrupted"] })).toHaveLength(1)
    const recoveryId = runs[0]?.recoveryId
    if (!recoveryId) throw new Error("interrupted run has no recoveryId")

    const tools = loadToolExecutionTimelineFromEvents(ctx.store.read({ aggregateId, types: TOOL_EXECUTION_FACT_TYPES }))
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ toolUseId, status: "interrupted" })

    const conversationId = await chatConversationId(sessionId)
    if (!conversationId) throw new Error(`no conversationId for ${sessionId}`)
    const tree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    const recovery = (await tree.getBranch()).at(-1)
    tree.getStorage().dispose()
    expect(recovery?.kind).toBe("message")
    if (recovery?.kind !== "message" || recovery.message.kind !== "user") throw new Error("missing recovery turn")
    expect(recovery.id).toBe(`subagent-recovery:${recoveryId}`)
    expect(recovery.message.origin).toBe("system")
    expect(recovery.message.content).toContain("<runtime_recovery>")
    expect(recovery.message.content).not.toContain("<recovery_id>")
    expect(recovery.message.content).toContain("Locate runtime UI command seam")
    expect(recovery.message.content).toContain("None of these subagents is running")
    expect(recovery.message.content).toContain("launch a new subagent")
    expect(recovery.message.content).toContain("Do not call process with { action: \"wait\" }")

    const blocks = ctx.sessionStore.get(sessionId)?.outputBlocks() ?? []
    const group = blocks.find((block) => block.kind === "agentGroup")
    expect(group?.kind).toBe("agentGroup")
    if (group?.kind === "agentGroup") expect(group.status).toBe("interrupted")
    expect(blocks.some((block) => block.kind === "userMessage" && block.content.includes("runtime_recovery"))).toBe(false)

    await supervisor.disposeAll()
  })

  test("concurrent activations serialize through the actor mailbox: one shell open", async () => {
    const sessionId = "reactivate-race"
    await ctx.manager.createChat({ name: "Raced Chat", initialState: "inactive", id: sessionId })
    await commitUserTurn(sessionId)

    let shellOpens = 0
    const countingStore: SessionStore = {
      ...ctx.sessionStore,
      openSessionRuntime: (opts) => {
        shellOpens += 1
        return ctx.sessionStore.openSessionRuntime(opts)
      },
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, countingStore),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    // Both racing entry points (picker open + a cold send's auto-activation)
    // used to call openSessionRuntime, the second resetting the entry's runner.
    const [first, second] = await Promise.all([
      supervisor.activateSession(sessionId),
      supervisor.activateSession(sessionId),
    ])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(shellOpens).toBe(1)

    await supervisor.disposeAll()
  })

  test("a turn the index never captured is synthesized from the tree into the seed", async () => {
    const sessionId = "reactivate-killed-in-debounce"
    await ctx.manager.createChat({ name: "Killed Chat", initialState: "inactive", id: sessionId })
    // Cold send committed the user turn durably, then the process died inside
    // the flush debounce: the tree has the conversation, the index has nothing.
    await commitUserTurn(sessionId)

    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)

    const entry = ctx.sessionStore.get(sessionId)
    const blocks = entry?.outputBlocks() ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("userMessage")
    if (blocks[0]?.kind === "userMessage") expect(blocks[0].content).toBe("hello")
    // The synthesized tail comes from durable tree history; its display input
    // begins at the first block in the logical sequence.
    expect(entry?.outputSequenceStart).toBe(0)

    await supervisor.disposeAll()
  })

  test("a long history retains only the bounded tail with its absolute sequence boundary", async () => {
    const sessionId = "reactivate-seed-tail"
    await ctx.manager.createChat({ name: "Long Chat", initialState: "inactive", id: sessionId })
    const history = Array.from({ length: 100 }, (_, i) => ({ kind: "user" as const, content: `line ${i}` }))
    await appendConversation(sessionId, history)

    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })

    expect(await supervisor.activateSession(sessionId)).toBe(true)

    const entry = ctx.sessionStore.get(sessionId)
    // Activation is O(tail): the shell retains the last 64 blocks for display
    // continuity, while the sequence boundary remains in absolute coordinates
    // so durable history owns the prefix before it.
    const blocks = entry?.outputBlocks() ?? []
    expect(blocks.map((block) => block.kind === "userMessage" ? block.content : "")).toEqual(history.slice(36).map((message) => message.content))
    expect(entry?.outputSequenceStart).toBe(36)

    await supervisor.disposeAll()
  })

})
