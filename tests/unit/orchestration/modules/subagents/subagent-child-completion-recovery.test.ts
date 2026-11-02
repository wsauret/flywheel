import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { afterEach, describe, expect, test } from "bun:test"
import { registerTestChildRun } from "../../../../helpers/live-child-run"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contentEvidence } from "../../../../../src/infra/content-evidence.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { composeRetainedOperationHosts } from "../../../../../src/infra/retained-operation-hosts.js"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPaused, buildSubagentPrompted, buildSubagentResumed } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { readSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { readSubagentRunsByToolUseId } from "../../../../../src/orchestration/modules/subagents/history/subagent-history.js"
import { createSubagentSessionAuthority } from "../../../../../src/orchestration/modules/subagents/execution/session-authority.js"
import { bindSessionStops } from "../../../../../src/orchestration/session/module-session-operations.js"
import { executeChildSessionDeletionPlan } from "../../../../../src/orchestration/session/child-session-deletion.js"
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, type HeldBackgroundNotification } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { createSessionManager } from "../../../../../src/orchestration/session/manager.js"
import { loadToolExecutionTimelineFromEvents } from "../../../../../src/orchestration/session/tool-execution-projection.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("subagent child completion recovery", () => {
  test("atomically settles the bound parent tool and admits one durable notification", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-completion-"))
    directories.push(projectRoot)
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const parent = await manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("missing parent chat")

    const toolUseId = "subagent-tool"
    const childSessionId = "child"
    const childRunId = "run"
    const description = "Inspect completion recovery"
    const toolInput = { persona: "explorer", description }
    const inputEvidence = contentEvidence(JSON.stringify(toolInput))
    const parentWriter = createSessionFactWriter({ sessionId: parentSessionId, writer })
    await parentWriter.record({
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId,
        toolName: "subagent",
        input: toolInput,
        inputBytes: inputEvidence.bytes,
        inputSha256: inputEvidence.sha256,
        inputPreview: inputEvidence.preview,
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: true,
        modelRequestId: "request",
      },
    })
    parentWriter.dispose()
    const parentTree = await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(store), writer })
    if (!parentTree) throw new Error("missing parent conversation")
    await parentTree.appendMessage({ kind: "user", content: "delegate" })
    await parentTree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: toolInput }] })
    parentTree.getStorage().dispose()

    const runInput: Parameters<typeof buildDurableSubagentCreated>[0] = {
      childSessionId,
      childRunId,
      conversationId: "child-conversation",
      parentSessionId,
      parentConversationId: parent.conversationId,
      parentToolCallId: toolUseId,
      modelRequestId: "request",
      persona: { name: "explorer", kind: "persona" },
      capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "test/model",
      tools: [],
      executionCwd: projectRoot,
      budget: { maxTurns: 4, maxTokens: 1_000 },
      parentDepth: 0,
      description,
    }
    const runBinding = buildDurableSubagentCreated(runInput)
    await manager.publishSubagent({
      id: childSessionId,
      conversationId: "child-conversation",
      description,
      executionCwd: projectRoot,
      launchedFrom: { parentSessionId, conversationId: parent.conversationId, toolUseId },
      initialRoles: {},
      runBinding: prepareSessionFactAppend(childSessionId, runBinding),
      assignment: "inspect",
      promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt: "inspect", task: "inspect", toolNames: [] })),
    })
    for (const by of ["person", "agent", "runtime"] as const) {
      const id = `paused-${by}`
      const pausedTool = `tool-${id}`
      const facts = createSessionFactWriter({ sessionId: parentSessionId, writer })
      await facts.record({
        type: "tool.input.completed", version: 1, actor: "agent",
        payload: { toolUseId: pausedTool, toolName: "subagent", input: toolInput, inputBytes: inputEvidence.bytes, inputSha256: inputEvidence.sha256, inputPreview: inputEvidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
      })
      facts.dispose()
      await manager.publishSubagent({
        id, conversationId: `${id}-conversation`, description, executionCwd: projectRoot,
        launchedFrom: { parentSessionId, conversationId: parent.conversationId, toolUseId: pausedTool }, initialRoles: {},
        runBinding: prepareSessionFactAppend(id, buildDurableSubagentCreated({ ...runInput, childSessionId: id, childRunId: id, conversationId: `${id}-conversation`, parentToolCallId: pausedTool })),
        assignment: "inspect",
        promptFact: prepareSessionFactAppend(id, buildSubagentPrompted({ childRunId: id, prompt: "inspect", task: "inspect", toolNames: [] })),
      })
      const tree = await tryOpenConversationTree({ conversationId: `${id}-conversation`, sessionId: id, store: asAsyncEventReadSurface(store), writer })
      if (!tree) throw new Error("missing paused child's conversation")
      const end = interruptedTurnEnd(by)
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, id))
      tree.getStorage().dispose()
      const pausedWriter = createSessionFactWriter({ sessionId: id, writer })
      await pausedWriter.record(buildSubagentPaused({ childRunId: id, pausedBy: by === "agent" ? "person" : by }))
      pausedWriter.dispose()
    }
    const childWriter = createSessionFactWriter({ sessionId: childSessionId, writer })
    const result = "The initial child run failed."
    await childWriter.record(buildSubagentCompleted({
      childRunId,
      status: "failed",
      isError: true,
      content: result,
      durationMs: 12,
      totalTokens: 21,
      toolUses: 2,
    }))
    childWriter.dispose()
    const reader = asAsyncEventReadSurface(store)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let paused = false
    let holdReads = 0
    const racingReader: AsyncEventStateReadSurface = {
      ...reader,
      readInFlight: async (...args) => {
        if (!paused && ++holdReads === 2) {
          paused = true
          entered.resolve()
          await release.promise
        }
        return reader.readInFlight(...args)
      },
    }
    const oldReconciliation = reconcileChildSessionCompletions({ parentSessionId, reader: racingReader, writer })
    await entered.promise
    const inactiveLifecycleBeforeRetry = store.read({
      aggregateId: `session:${childSessionId}`,
      types: ["session.lifecycle.changed"],
    }).filter((event) => event.payload.lifecycleState === "inactive").length

    const siblingToolUseId = "subagent-tool-retry"
    const siblingRunId = "run-retry"
    const siblingDescription = "Retry completion recovery"
    const siblingInput = { kind: "retry", session_id: childSessionId }
    const siblingEvidence = contentEvidence(JSON.stringify(siblingInput))
    const siblingParentWriter = createSessionFactWriter({ sessionId: parentSessionId, writer })
    await siblingParentWriter.record({
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: siblingToolUseId,
        toolName: "subagent",
        input: siblingInput,
        inputBytes: siblingEvidence.bytes,
        inputSha256: siblingEvidence.sha256,
        inputPreview: siblingEvidence.preview,
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: true,
        modelRequestId: "request-sibling",
      },
    })
    siblingParentWriter.dispose()
    const siblingBinding = buildDurableSubagentCreated({
      childSessionId,
      childRunId: siblingRunId,
      conversationId: "child-conversation",
      parentSessionId,
      parentConversationId: parent.conversationId,
      parentToolCallId: siblingToolUseId,
      modelRequestId: "request-sibling",
      persona: { name: "explorer", kind: "persona" },
      capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "test/model",
      tools: [],
      executionCwd: projectRoot,
      budget: { maxTurns: 4, maxTokens: 1_000 },
      parentDepth: 0,
      description: siblingDescription,
    })
    const nextSeq = store.aggregateSeq(`session:${childSessionId}`) + 1
    const siblingPublication = await writer.appendBatchGuarded([
      { ...prepareSessionFactAppend(childSessionId, siblingBinding), expectedSeq: nextSeq },
      {
        ...prepareSessionFactAppend(childSessionId, buildSubagentPrompted({
          childRunId: siblingRunId, prompt: "inspect again", task: "inspect again", toolNames: [],
        })),
        expectedSeq: nextSeq + 1,
      },
    ])
    if (siblingPublication.kind !== "stored") throw new Error("sibling publication conflicted")
    await manager.updateLifecycleState(childSessionId, "active")
    release.resolve()
    expect(await oldReconciliation).toMatchObject({ reconciledCount: 1 })
    expect(await manager.read(childSessionId)).toMatchObject({ lifecycleState: "active" })
    expect(store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    const siblingWriter = createSessionFactWriter({ sessionId: childSessionId, writer })
    await siblingWriter.record(buildSubagentCompleted({
      childRunId: siblingRunId,
      status: "completed",
      isError: false,
      content: "The retry completed successfully.",
      durationMs: 8,
      totalTokens: 13,
      toolUses: 1,
    }))
    siblingWriter.dispose()

    expect(await reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: [childSessionId],
    })
    const tools = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${parentSessionId}` }))
    expect(tools.find((tool) => tool.toolUseId === toolUseId)).toMatchObject({ status: "failed", contentPreview: result, resultOutcome: "error" })
    expect(tools.find((tool) => tool.toolUseId === siblingToolUseId)).toMatchObject({
      status: "completed",
      contentPreview: "The retry completed successfully.",
      resultOutcome: "ok",
    })
    const notifications = store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    expect(notifications).toHaveLength(2)
    for (const notification of notifications) expect(JSON.stringify(notification.payload)).toContain("<remaining_active>1</remaining_active>")
    expect(notifications.some(({ key }) => key === `subagent-completions:${siblingRunId}`)).toBe(true)
    // The notice names the child session, which message_session reaches.
    expect(JSON.stringify(notifications.find(({ key }) => key === `subagent-completions:${siblingRunId}`)?.payload)).toContain(`<session_id>${childSessionId}</session_id>`)
    expect(store.read({
      aggregateId: `session:${childSessionId}`,
      types: ["session.lifecycle.changed"],
    }).filter((event) => event.payload.lifecycleState === "inactive")).toHaveLength(inactiveLifecycleBeforeRetry + 1)
    expect(await reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), writer })).toMatchObject({ reconciledCount: 0 })
    expect(store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(2)
    await store.close()
  })
})

describe("subagent completion reconciliation", () => {
  test("skips a child whose run history it cannot read and still settles its sibling", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-unreadable-"))
    directories.push(projectRoot)
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const children = ["unreadable", "sibling"]
    const toolInput = { persona: "explorer", description: "inspect" }
    const inputEvidence = contentEvidence(JSON.stringify(toolInput))
    const parentFacts = createSessionFactWriter({ sessionId: parentSessionId, writer })
    for (const id of children) {
      await parentFacts.record({
        type: "tool.input.completed", version: 1, actor: "agent",
        payload: { toolUseId: `tool-${id}`, toolName: "subagent", input: toolInput, inputBytes: inputEvidence.bytes, inputSha256: inputEvidence.sha256, inputPreview: inputEvidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
      })
    }
    parentFacts.dispose()
    const parentTree = await tryOpenConversationTree({ conversationId: "parent-conversation", sessionId: parentSessionId, store: asAsyncEventReadSurface(store), writer })
    if (!parentTree) throw new Error("missing parent conversation")
    await parentTree.appendMessage({ kind: "user", content: "delegate" })
    await parentTree.appendMessage({ kind: "assistant", content: children.map((id) => ({ type: "tool_use" as const, id: `tool-${id}`, name: "subagent", input: toolInput })) })
    parentTree.getStorage().dispose()
    for (const id of children) {
      const launchedFrom = { parentSessionId, conversationId: "parent-conversation", toolUseId: `tool-${id}` }
      await manager.publishSubagent({
        id, conversationId: `${id}-conversation`, description: "inspect", executionCwd: projectRoot, launchedFrom, initialRoles: {}, assignment: "inspect",
        runBinding: prepareSessionFactAppend(id, buildDurableSubagentCreated({
          childSessionId: id, childRunId: id, conversationId: `${id}-conversation`, parentSessionId, parentConversationId: "parent-conversation", parentToolCallId: `tool-${id}`, modelRequestId: "request",
          persona: { name: "explorer", kind: "persona" },
          capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
          admittedModuleIds: [], skillsRevision: 1, model: "test/model", tools: [], executionCwd: projectRoot, budget: { maxTurns: 4, maxTokens: 1_000 }, parentDepth: 0, description: "inspect",
        })),
        promptFact: prepareSessionFactAppend(id, buildSubagentPrompted({ childRunId: id, prompt: "inspect", task: "inspect", toolNames: [] })),
      })
      const childFacts = createSessionFactWriter({ sessionId: id, writer })
      await childFacts.record(buildSubagentCompleted({ childRunId: id, status: "completed", isError: false, content: `${id} done`, durationMs: 1, totalTokens: 1, toolUses: 0 }))
      childFacts.dispose()
    }
    // A newer build recorded a run of this child in a shape this build cannot read.
    store.append({ aggregateId: "session:unreadable", sessionId: "unreadable", timestamp: Date.now(), type: "child_run.created", version: 99, actor: "flywheel", payload: {} })

    expect(await reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: ["sibling"],
    })
    const tools = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${parentSessionId}` }))
    expect(tools.find((tool) => tool.toolUseId === "tool-sibling")).toMatchObject({ status: "completed", contentPreview: "sibling done" })
    // The unreadable child's call stays open, as it was before the child finished.
    expect(tools.find((tool) => tool.toolUseId === "tool-unreadable")?.status).not.toBe("completed")
    // The parent's transcript skips the unreadable fact and still shows both cards.
    const cards = await readSubagentRunsByToolUseId(asAsyncEventReadSurface(store), parentSessionId)
    expect([...cards.entries()].map(([toolUseId, run]) => [toolUseId, run.status])).toEqual([["tool-unreadable", "completed"], ["tool-sibling", "completed"]])
    await store.close()
  })
})

describe("subagent Stop", () => {
  /** A parent chat whose background call launched one subagent child, with
   *  the child's run recorded as `created`. */
  async function launchedChild() {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-stop-"))
    directories.push(projectRoot)
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const toolUseId = "subagent-tool"
    const childSessionId = "child"
    const childRunId = "run"
    const description = "Inspect the stop"
    const toolInput = { persona: "explorer", description }
    const inputEvidence = contentEvidence(JSON.stringify(toolInput))
    const parentWriter = createSessionFactWriter({ sessionId: parentSessionId, writer })
    await parentWriter.record({
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId, toolName: "subagent", input: toolInput,
        inputBytes: inputEvidence.bytes, inputSha256: inputEvidence.sha256, inputPreview: inputEvidence.preview,
        executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
      },
    })
    parentWriter.dispose()
    const parentTree = await tryOpenConversationTree({ conversationId: "parent-conversation", sessionId: parentSessionId, store: reader, writer })
    if (!parentTree) throw new Error("missing parent conversation")
    await parentTree.appendMessage({ kind: "user", content: "delegate" })
    await parentTree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: toolInput }] })
    parentTree.getStorage().dispose()
    await manager.publishSubagent({
      id: childSessionId,
      conversationId: "child-conversation",
      description,
      executionCwd: projectRoot,
      launchedFrom: { parentSessionId, conversationId: "parent-conversation", toolUseId },
      initialRoles: {},
      runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
        childSessionId, childRunId, conversationId: "child-conversation",
        parentSessionId, parentConversationId: "parent-conversation", parentToolCallId: toolUseId, modelRequestId: "request",
        persona: { name: "explorer", kind: "persona" },
        capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
        admittedModuleIds: [], skillsRevision: 1, model: "test/model", tools: [], executionCwd: projectRoot,
        budget: { maxTurns: 4, maxTokens: 1_000 }, parentDepth: 0, description,
      })),
      assignment: "inspect",
      promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt: "inspect", task: "inspect", toolNames: [] })),
    })
    /** Each notification that reached the parent's attached runner, as the
     *  composition delivers it there. */
    const delivered: Array<{ readonly parentSessionId: string; readonly key: string | undefined }> = []
    const deliverNotification = async (parent: string, notification: HeldBackgroundNotification): Promise<boolean> => {
      delivered.push({ parentSessionId: parent, key: notification.key })
      return true
    }
    /** A person's Stop of the child. `afterRunRead` runs just after the
     *  owner's read of the child's runs returns, so a test can land a
     *  concurrent write between that read and the Stop's own append. */
    const stop = async (afterRunRead?: () => Promise<void>, beforeRunRead?: () => Promise<void>): Promise<void> => {
      let pending = afterRunRead
      let before = beforeRunRead
      const projectionReader: AsyncEventStateReadSurface = {
        ...reader,
        aggregateSeq: async (id) => {
          const seq = await reader.aggregateSeq(id)
          if (id === `session:${childSessionId}` && before) {
            const hook = before
            before = undefined
            await hook()
          }
          return seq
        },
        readPage: async (...args) => {
          const page = await reader.readPage(...args)
          const hook = pending
          if (hook && args[0].types?.includes("subagent.completed")) {
            pending = undefined
            await hook()
          }
          return page
        },
      }
      const settle = await bindSessionStops({ hosts: composeRetainedOperationHosts([]), modules: NO_MODULE_SERVICES, reader, projectionReader, writer, projectRoot, read: manager.read, deliverNotification })(parentSessionId, toolUseId)
      if (!settle) throw new Error("the Stop found no owner for the subagent child")
      await settle()
      if (pending) throw new Error("the Stop never read the child's runs")
    }
    const parentResults = () => store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })
    /** The keys of the notifications the parent holds. */
    const held = () => store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((row) => row.key)
    return { store, reader, writer, manager, projectRoot, parentSessionId, childSessionId, childRunId, toolUseId, stop, parentResults, delivered, deliverNotification, held }
  }

  test("a Stop of an interrupted child ends its run as stopped and gives its parent's waiting call one result", async () => {
    const child = await launchedChild()
    const childWriter = createSessionFactWriter({ sessionId: child.childSessionId, writer: child.writer })
    await childWriter.record(buildSubagentPaused({ childRunId: child.childRunId, pausedBy: "person" }))
    childWriter.dispose()
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")

    await child.stop()

    expect((await readSubagentRuns(child.reader, child.childSessionId)).at(-1)).toMatchObject({ status: "stopped" })
    expect(child.parentResults()).toHaveLength(1)
    const tools = loadToolExecutionTimelineFromEvents(child.store.read({ aggregateId: `session:${child.parentSessionId}` }))
    expect(tools.find((tool) => tool.toolUseId === child.toolUseId)).toMatchObject({ resultOutcome: "stopped" })
    // The parent's attached runner gets the one notification it holds, as a
    // live completion's reaches it, so a parent parked on the child wakes.
    expect(child.held()).toHaveLength(1)
    expect(child.delivered).toEqual(child.held().map((key) => ({ parentSessionId: child.parentSessionId, key })))

    // A second Stop re-drives an accepted but uncommitted notice. Acceptance
    // alone is not a durable acknowledgement from the parent's conversation.
    await child.stop()
    expect(child.parentResults()).toHaveLength(1)
    expect(child.delivered).toHaveLength(2)
    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.completed"] })).toHaveLength(1)
    await child.store.close()
  })

  test("a Stop of a child that an unexpected exit interrupted replaces its parent's interrupted guess with one stopped result", async () => {
    const child = await launchedChild()
    const childWriter = createSessionFactWriter({ sessionId: child.childSessionId, writer: child.writer })
    await childWriter.record({ type: "subagent.interrupted", version: 1, actor: "flywheel", payload: { childRunId: child.childRunId, reason: "runtime_restarted", recoveryId: "recovery" } })
    childWriter.dispose()
    const parentWriter = createSessionFactWriter({ sessionId: child.parentSessionId, writer: child.writer })
    await parentWriter.record({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: child.toolUseId, outcome: "interrupted", contentPreview: "Interrupted: the session restarted before this tool call completed." } })
    parentWriter.dispose()
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")

    await child.stop()

    expect((await readSubagentRuns(child.reader, child.childSessionId)).at(-1)).toMatchObject({ status: "stopped" })
    const tools = loadToolExecutionTimelineFromEvents(child.store.read({ aggregateId: `session:${child.parentSessionId}` }))
    expect(tools.filter((tool) => tool.toolUseId === child.toolUseId)).toEqual([expect.objectContaining({ resultOutcome: "stopped" })])
    expect(child.parentResults().map((fact) => fact.payload)).toEqual([
      expect.objectContaining({ outcome: "interrupted" }),
      expect.objectContaining({ outcome: "stopped" }),
    ])
    expect(child.held()).toHaveLength(1)
    expect(child.delivered).toEqual(child.held().map((key) => ({ parentSessionId: child.parentSessionId, key })))
    await child.store.close()
  })

  test("a Stop that a Resume overtakes records no completion, so the resumed run keeps its own", async () => {
    const child = await launchedChild()
    const childWriter = createSessionFactWriter({ sessionId: child.childSessionId, writer: child.writer })
    await childWriter.record(buildSubagentPaused({ childRunId: child.childRunId, pausedBy: "person" }))
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")

    // The Resume lands after the Stop read the run as paused.
    await child.stop(async () => {
      await childWriter.record(buildSubagentResumed({ childRunId: child.childRunId, authorizationId: "resume", continuation: 1 }))
    })
    childWriter.dispose()

    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.completed"] })).toHaveLength(0)
    expect((await readSubagentRuns(child.reader, child.childSessionId)).at(-1)).toMatchObject({ status: "created" })
    expect(child.parentResults()).toHaveLength(0)
    await child.store.close()
  })

  test("a Stop that a new activation overtakes before its run read does not stop the new live control", async () => {
    const child = await launchedChild()
    await child.writer.append(prepareSessionFactAppend(child.childSessionId, buildSubagentPaused({ childRunId: child.childRunId, pausedBy: "person" })))
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")
    let interrupted = false
    let unregister: (() => void) | undefined
    try {
      await child.stop(undefined, async () => {
        await child.manager.publishActivation(child.childSessionId, [prepareSessionFactAppend(child.childSessionId, buildSubagentResumed({ childRunId: child.childRunId, authorizationId: "resume", continuation: 1 }))])
        unregister = registerTestChildRun(child.reader, {
          sessionId: child.childSessionId, runId: child.childRunId, parentSessionId: child.parentSessionId,
          parentConversationId: "parent-conversation", parentToolCallId: child.toolUseId,
          settled: Promise.resolve(), stop: () => { interrupted = true }, interrupt: async () => {},
        })
      })
      expect(interrupted).toBe(false)
      expect(await child.manager.read(child.childSessionId)).toMatchObject({ lifecycleState: "active" })
      expect(child.parentResults()).toHaveLength(0)
    } finally {
      unregister?.()
      await child.store.close()
    }
  })

  test("a Resume that a Stop overtakes publishes no resumed fact, so the run stays stopped", async () => {
    const child = await launchedChild()
    const childWriter = createSessionFactWriter({ sessionId: child.childSessionId, writer: child.writer })
    await childWriter.record(buildSubagentPaused({ childRunId: child.childRunId, pausedBy: "person" }))
    childWriter.dispose()
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")
    // The Stop lands after the Resume read the run as paused.
    let stopped = false
    const projectionReader: AsyncEventStateReadSurface = {
      ...child.reader,
      readPage: async (...args) => {
        const page = await child.reader.readPage(...args)
        if (!stopped && args[0].types?.includes("subagent.resumed")) {
          stopped = true
          await child.stop()
        }
        return page
      },
    }
    const authority = createSubagentSessionAuthority({
      manager: child.manager,
      eventStore: child.reader,
      projectionReader,
      eventWriter: child.writer,
      projectRoot: child.projectRoot,
      recall: async () => ({ hits: [] }),
    })

    await expect(authority.publishResume({
      expectedSeq: await child.reader.aggregateSeq(`session:${child.childSessionId}`) + 1,
      childSessionId: child.childSessionId,
      childConversationId: "child-conversation",
      parentSessionId: child.parentSessionId,
      parentConversationId: "parent-conversation",
      parentToolUseId: child.toolUseId,
      description: "Inspect the stop",
      executionCwd: child.projectRoot,
      authProfileId: "default",
      initialRoles: {},
      promptFact: prepareSessionFactAppend(child.childSessionId, buildSubagentPrompted({ childRunId: child.childRunId, prompt: "inspect", task: "inspect", toolNames: [] })),
    })).rejects.toThrow()

    expect(stopped).toBe(true)
    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.resumed"] })).toHaveLength(0)
    expect((await readSubagentRuns(child.reader, child.childSessionId)).at(-1)).toMatchObject({ status: "stopped" })
    expect(await child.manager.read(child.childSessionId)).toMatchObject({ lifecycleState: "inactive" })
    expect(child.parentResults()).toHaveLength(1)
    await child.store.close()
  })

  test("a Stop of a running child stops it through its live run, which records its own completion", async () => {
    const child = await launchedChild()
    const stopped: string[] = []
    const unregister = registerTestChildRun(child.reader, {
      sessionId: child.childSessionId, runId: child.childRunId, parentSessionId: child.parentSessionId,
      parentConversationId: "parent-conversation", parentToolCallId: child.toolUseId,
      settled: Promise.resolve(),
      stop: () => { stopped.push(child.childSessionId) },
      interrupt: async () => {},
    })
    try {
      await child.stop()
    } finally {
      unregister()
    }
    expect(stopped).toEqual([child.childSessionId])
    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.completed"] })).toHaveLength(0)
    await child.store.close()
  })

  // A dispatch or a Resume records the run as created before its run
  // registers the control a Stop cuts, so a Stop in between waits for it.
  test("a Stop that lands before a starting run registers its control stops that run once it registers", async () => {
    const child = await launchedChild()
    const stopped: string[] = []
    let unregister: (() => void) | undefined
    await child.stop(async () => {
      setTimeout(() => {
        unregister = registerTestChildRun(child.reader, {
          sessionId: child.childSessionId, runId: child.childRunId, parentSessionId: child.parentSessionId,
          parentConversationId: "parent-conversation", parentToolCallId: child.toolUseId,
          settled: Promise.resolve(),
          stop: () => { stopped.push(child.childSessionId) },
          interrupt: async () => {},
        })
      }, 5)
    })
    unregister?.()
    expect(stopped).toEqual([child.childSessionId])
    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.completed"] })).toHaveLength(0)
    await child.store.close()
  })

  // Deleting a child stops it as a person's Stop does, so a parent call that
  // waits on an interrupted child gets its one result before the unlink.
  test("deleting an interrupted child gives its parent's waiting call one stopped result", async () => {
    const child = await launchedChild()
    const childWriter = createSessionFactWriter({ sessionId: child.childSessionId, writer: child.writer })
    await childWriter.record(buildSubagentPaused({ childRunId: child.childRunId, pausedBy: "person" }))
    childWriter.dispose()
    await child.manager.updateLifecycleState(child.childSessionId, "inactive")

    await executeChildSessionDeletionPlan({
      projectRoot: child.projectRoot, reader: child.reader, projectionReader: child.reader, writer: child.writer,
      read: child.manager.read, finalizeDeletionTarget: child.manager.finalizeDeletionTarget, deliverNotification: child.deliverNotification,
    }, await child.manager.admitDeletion(child.childSessionId))

    expect(await child.manager.read(child.childSessionId)).toBeNull()
    expect(child.store.read({ aggregateId: `session:${child.childSessionId}`, types: ["subagent.completed"] }).map((fact) => fact.payload.status)).toEqual(["stopped"])
    const tools = loadToolExecutionTimelineFromEvents(child.store.read({ aggregateId: `session:${child.parentSessionId}` }))
    expect(tools.filter((tool) => tool.toolUseId === child.toolUseId)).toEqual([expect.objectContaining({ resultOutcome: "stopped" })])
    expect(child.held()).toHaveLength(1)
    expect(child.delivered).toEqual(child.held().map((key) => ({ parentSessionId: child.parentSessionId, key })))
    await child.store.close()
  })
})
