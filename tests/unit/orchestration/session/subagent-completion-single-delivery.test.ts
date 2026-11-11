import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import type { BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work"
import { chatEntry } from "../app-service/_frontend-projection-fixtures"
import { createBackgroundNotificationDelivery } from "../../../../src/orchestration/app-service/session-background-notifications"
import { createBackgroundNotificationDelivery as createRunnerNotificationDelivery } from "../../../../src/orchestration/runner/background-notification-delivery"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPaused, buildSubagentPrompted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { stopSubagentSession } from "../../../../src/orchestration/modules/subagents/execution/direct-child-control"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { readChildCompletionConversation } from "../../../../src/orchestration/session/child-completion-conversation"
import { readReconciledBranch, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue"
import { createSubagentRunInputs } from "../../../../src/orchestration/modules/subagents/execution/run-inputs"
import { createWorkflowMemberInputs } from "../../../../src/orchestration/workflow-host/member-inputs"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"
import { addSubagentChild, localAsyncWriter } from "./_child-session-reconciliation-fixtures"
import { loadToolExecutionTimelineFromEvents } from "../../../../src/orchestration/session/tool-execution-projection"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("subagent completion delivery", () => {
  test("one child completion does not reread its unchanged siblings", async () => {
    const costs: Array<{ requests: number; facts: number }> = []
    for (const siblings of [2, 20]) {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-completion-cost-"))
      directories.push(projectRoot)
      const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
      try {
        const writer = asAsyncEventWriter(store)
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
        const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
        const parentWriter = createSessionFactWriter({ sessionId: parentSessionId, writer })
        for (let i = 0; i < siblings; i += 1) {
          const childSessionId = `child-${i}`
          const toolUseId = `tool-${i}`
          const toolInput = { persona: "explorer", description: "Review" }
          const evidence = contentEvidence(JSON.stringify(toolInput))
          await parentWriter.record({
            type: "tool.input.completed", version: 1, actor: "agent",
            payload: { toolUseId, toolName: "subagent", input: toolInput, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
          })
          await manager.publishSubagent({
            id: childSessionId, conversationId: `conversation-${i}`, description: "Review", executionCwd: projectRoot,
            launchedFrom: { parentSessionId, conversationId: "parent-conversation", toolUseId }, initialRoles: {},
            runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
              childSessionId, childRunId: `run-${i}`, conversationId: `conversation-${i}`,
              parentSessionId, parentConversationId: "parent-conversation", parentToolCallId: toolUseId,
              modelRequestId: "request", persona: { name: "explorer", kind: "persona" },
              capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
              admittedModuleIds: [], skillsRevision: 1, model: "test/model", tools: [], executionCwd: projectRoot,
              budget: { maxTurns: 4, maxTokens: 1_000 }, parentDepth: 0, description: "Review",
            })),
            assignment: "review",
            promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId: `run-${i}`, prompt: "review", task: "review", toolNames: [] })),
          })
        }
        parentWriter.dispose()
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        const tree = await tryOpenConversationTree({ conversationId: "parent-conversation", sessionId: parentSessionId, store: counter.reader, writer })
        if (!tree) throw new Error("missing parent conversation")
        for (let index = 0; index < siblings * 2; index++) await tree.appendMessage({ kind: "user", content: `retained ${index}` })
        const input = { parentSessionId, reader: counter.reader, writer, projectRoot }
        await reconcileChildSessionCompletions(input)
        const validated = await readChildCompletionConversation({ input }, parentSessionId, "parent-conversation")
        counter.take()
        const { entriesById } = await tree.getState()
        const childWriter = createSessionFactWriter({ sessionId: "child-0", writer })
        await childWriter.record(buildSubagentCompleted({ childRunId: "run-0", status: "completed", isError: false, content: "Reviewed.", durationMs: 1 }))
        childWriter.dispose()
        let entryVisits = 0
        const keys = Object.keys
        const traversal = spyOn(Object, "keys").mockImplementation((object) => {
          const result = keys(object)
          if (object === entriesById) entryVisits += result.length
          return result
        })
        try {
          expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(1)
          expect(entryVisits).toBe(0)
        } finally {
          traversal.mockRestore()
          validated?.getStorage().dispose()
          tree.getStorage().dispose()
        }
        const requests = counter.take()
        costs.push({ requests: requests.length, facts: factsRead(requests) })
        expect(store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)[0]?.payload.text).toContain(`remaining_active>${siblings - 1}`)
      } finally {
        store.close()
      }
    }
    expect(costs[1]).toEqual(costs[0])
  })

  test("a parent row this release cannot read leaves only the child it names open", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-unreadable-link-"))
    directories.push(projectRoot)
    const path = resolveEventStoreDbFile(projectRoot)
    const store = createSqliteEventStore(path)
    try {
      const writer = localAsyncWriter(store)
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
      for (let i = 0; i < 3; i += 1) await addSubagentChild(store, writer, projectRoot, parentSessionId, "parent-conversation", i, "completed")
      const links = store.read({ aggregateId: `session:${parentSessionId}`, types: ["session.child.linked"] })
      const db = new Database(path)
      try {
        // A broken disk damaged one link, and a newer build wrote another in
        // a shape this build cannot read.
        db.query("update event set payload = '{bad json' where position = ?").run(links[0]!.position)
        db.query("update event set version = 99 where position = ?").run(links[2]!.position)
      } finally {
        db.close()
      }
      const input = { parentSessionId, reader: asAsyncEventReadSurface(store), writer, projectRoot }
      expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(1)
      const results = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.input.completed", "tool.result.recorded"] }))
      expect(results.filter((tool) => tool.resultEventId !== undefined).map((tool) => tool.toolUseId)).toEqual(["tool-1"])
    } finally {
      store.close()
    }
  })

  test.each(["subagent", "workflow", "stopped-subagent", "stopped-workflow"] as const)("the %s live input and durable drain deliver one completion once", async (parentKind) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-single-delivery-"))
    directories.push(projectRoot)
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    const conversationId = "parent-conversation"
    const toolUseId = "subagent-tool"
    const childSessionId = "child"
    const childRunId = "run"
    const description = "Elegance review"
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
    const parentTree = await tryOpenConversationTree({ conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(store), writer })
    if (!parentTree) throw new Error("missing parent conversation")
    await parentTree.appendMessage({ kind: "user", content: "delegate" })
    await parentTree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: toolInput }] })
    await parentTree.appendMessage({ kind: "toolResult", toolUseId, content: [{ type: "text", text: "Dispatched." }] })
    parentTree.getStorage().dispose()

    await manager.publishSubagent({
      id: childSessionId,
      conversationId: "child-conversation",
      description,
      executionCwd: projectRoot,
      launchedFrom: { parentSessionId, conversationId, toolUseId },
      initialRoles: {},
      runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
        childSessionId,
        childRunId,
        conversationId: "child-conversation",
        parentSessionId,
        parentConversationId: conversationId,
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
      })),
      assignment: "review",
      promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt: "review", task: "review", toolNames: [] })),
    })
    const childWriter = createSessionFactWriter({ sessionId: childSessionId, writer })
    await childWriter.record(parentKind.startsWith("stopped") ? buildSubagentPaused({ childRunId, pausedBy: "person" }) : buildSubagentCompleted({
      childRunId,
      status: "completed",
      isError: false,
      content: "One P3 finding.",
      durationMs: 12,
      totalTokens: 21,
      toolUses: 2,
    }))
    childWriter.dispose()

    // The live step owns a durable hold and its queued copy across an idle
    // Resume commit, before the loop pushes the copy through a save point.
    const treeWriter = createConversationTreeWriterController({ conversationId, sessionId: parentSessionId, projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
    const runInputs = createSubagentRunInputs(() => {})
    const queue = parentKind.endsWith("subagent") ? runInputs.queue : new WorkflowInjectionQueue()
    const liveDelivery = createRunnerNotificationDelivery({ conversation: treeWriter, queue, abort: () => { throw new Error("delivery failed") } })
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: liveDelivery.enqueue,
    })
    const memberInputs = createWorkflowMemberInputs({ sessionId: parentSessionId, conversationId, reader: asAsyncEventReadSurface(store), writer, tree: treeWriter, deactivate: async () => {}, queue, notifications: liveDelivery })
    const unregister = registerLiveSessionControl(asAsyncEventReadSurface(store), {
      sessionId: parentSessionId, state: async () => "running",
      deliver: async () => ({ status: "delivered", startsTurn: false }),
      member: { backgroundTasks: registry, modules: async () => undefined, compact: async () => false, interrupt: () => false, releaseForegroundBash: () => false, transferForegroundForReplacement: async () => {}, terminateBackgroundWork: () => {} },
      ...(parentKind.endsWith("subagent") ? { child: {
        runId: "parent-run", parentSessionId: "root", parentConversationId: "root-conversation", parentToolCallId: "parent-call",
        backgroundTasks: registry, modules: async () => undefined, stop: () => {}, interrupt: async () => true,
        progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }),
      } } : {}),
      notify: parentKind.endsWith("subagent") ? runInputs.notify : memberInputs.notify,
    })
    const childResult: BackgroundWorkResult = { status: "completed", content: "One P3 finding." }
    registry.track({
      done: Promise.resolve(parentKind.startsWith("stopped") ? { status: "interrupted", content: "", interruptedBy: "person" } : childResult),
      meta: { id: childRunId, type: "subagent", description, toolUseId, settlementOwner: "child_session" },
    })
    await Promise.resolve()
    if (parentKind.startsWith("stopped")) expect(registry.awaitedTaskCount()).toBe(1)
    if (parentKind.startsWith("stopped")) expect(await stopSubagentSession({
      eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer,
      projectRoot, childSessionId, parentSessionId, by: "person",
    })).toEqual({ ok: true, status: "stopped" })

    // The subagent tool's path: reconciliation settles the parent tool, holds
    // the durable notification, and hands it to the live registry.
    await reconcileChildSessionCompletions({
      parentSessionId,
      reader: asAsyncEventReadSurface(store),
      writer,
      // An attached-chat lookup cannot find a nested parent's runner. Its
      // live session input is still the delivery owner.
      deliverNotification: async () => false,
    })
    await liveDelivery.settle()
    expect(registry.assertHandoffReady()).not.toBeNull()
    await reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), writer, deliverNotification: async () => false })
    await liveDelivery.settle()
    await treeWriter.commitSystemTurn("Resume")
    expect((await treeWriter.buildContext()).messages.filter((message) =>
      message.kind === "user" && String(message.content).includes("<subagent_notifications>"))).toHaveLength(0)
    expect(store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    treeWriter.beginTurn()
    const queued = queue.drainPending()
    if (queued?.kind !== "message") throw new Error("missing queued completion")
    await treeWriter.recordCanonicalMessage({
      kind: "user",
      content: queued.text,
      backgroundNotificationIds: queued.backgroundNotificationIds,
      replyRequired: true,
    })
    await treeWriter.flushSavePoint()
    expect(registry.assertHandoffReady()).toBeNull()
    expect([registry.activeTaskCount(), registry.awaitedTaskCount()]).toEqual([0, 0])
    expect(queue.drainPending()).toBeNull()
    unregister()
    await treeWriter.dispose()

    // The durable path: a later drain of held notifications and a later
    // reconciliation see the same completion again.
    const delivery = createBackgroundNotificationDelivery({ sessionId: parentSessionId, projectRoot, eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), eventWriter: writer, admitsDelivery: () => true, sweepAfterCommit: () => {} })
    const entry = chatEntry({ conversationId, runner: null })
    await delivery.drainHeld(entry)
    await reconcileChildSessionCompletions({
      parentSessionId,
      reader: asAsyncEventReadSurface(store),
      writer,
      deliverNotification: (notification) => delivery.deliver(entry, notification),
    })
    await delivery.drainHeld(entry)

    const branch = await readReconciledBranch({ conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(store), writer, projectRoot })
    const notifications = (branch ?? []).filter((item) =>
      item.kind === "message"
      && item.message.kind === "user"
      && typeof item.message.content === "string"
      && item.message.content.includes("<subagent_notifications>"))
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.id).toBe(queued.backgroundNotificationIds?.[0])
    expect(store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    store.close()
  })
})
