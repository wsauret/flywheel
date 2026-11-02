import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { asAsyncEventReadSurface, type AsyncEventWriter, type AsyncGuardedEventWriter, type FactQuery, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { createSessionToolExecutionStore, repairInterruptedToolExecutions } from "../../../../src/orchestration/session/tool-execution-store"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { recordChildWorkflowStartFailure, recordChildWorkflowStop } from "../../../../src/orchestration/session/child-workflow-result.js"
import { readToolExecution } from "../../../../src/orchestration/session/tool-execution-projection"
import { readChildCall, readChildStop, workflowSessionActions, workflowToolCall } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { workflowRunReader, workflowRunOwner } from "../../../../src/orchestration/module-catalog"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { WorkflowSessionFactSchema } from "../../../../src/workflows/vm/session-facts"
import { replaceWorkflowState, terminalWorkflowFacts } from "./_child-session-reconciliation-fixtures"
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { createBackgroundNotificationDelivery } from "../../../../src/orchestration/runner/background-notification-delivery"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue"

let tmpDir: string
let stores: LocalSqliteEventStore[]
let trees: ConversationTreeWriterController[]

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "child-workflow-stop-"))
  stores = []
  trees = []
})

afterEach(async () => {
  for (const tree of trees) await tree.dispose()
  for (const store of stores) store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function openStore() {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  stores.push(store)
  const writer: AsyncGuardedEventWriter = {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
    putInFlight: async (sessionId, kind, key, payload) => store.putInFlight(sessionId, kind, key, payload),
  }
  return { store, writer }
}

const TOOL_USE_ID = "workflow-tool"
const LAUNCH = { parentSessionId: "parent", toolUseId: TOOL_USE_ID }

/** A chat whose model launched a workflow that the runtime's teardown left
 *  paused: the shape a Stop leaves behind before it records the stop. */
async function setup(description = "Implement the reviewed change") {
  const { store, writer } = openStore()
  const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
  await manager.createChat({ id: "parent", conversationId: "conversation", name: "Parent" })
  const input = { workflow_definition_id: "workflow", summary: "Reviewed change", description }
  const evidence = contentEvidence(JSON.stringify(input))
  const factWriter = createSessionFactWriter({ sessionId: "parent", writer })
  await factWriter.record({
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId: TOOL_USE_ID, toolName: "workflow", input,
      inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
    },
  })
  factWriter.dispose()
  const decode = Schema.decodeUnknownSync(WorkflowSessionFactSchema)
  await manager.publishWorkflow({
    id: "child", description, workflowDefinitionId: "workflow", initialRoles: {},
    launchedFrom: { parentSessionId: "parent", conversationId: "conversation", workflowDefinitionId: "workflow", toolUseId: TOOL_USE_ID, description },
    facts: terminalWorkflowFacts(description, "paused").map((fact) => decode(fact)),
  })
  return { store, writer }
}

function stop(store: LocalSqliteEventStore, writer: AsyncEventWriter, stoppedBy: "person" | "agent") {
  return recordChildWorkflowStop({ reader: asAsyncEventReadSurface(store), writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow", stoppedBy })
}

function parentNotifications(store: LocalSqliteEventStore, writer: AsyncEventWriter) {
  const reader = asAsyncEventReadSurface(store)
  const tree = createConversationTreeWriterController({ sessionId: "parent", conversationId: "conversation", projectRoot: tmpDir, store: reader, projectionReader: reader, writer })
  trees.push(tree)
  tree.beginTurn()
  const queue = new WorkflowInjectionQueue()
  const delivery = createBackgroundNotificationDelivery({ conversation: tree, queue, abort() { throw new Error("notification hold failed") } })
  return {
    queue,
    deliverNotification: async (notification: { text: string; key?: string }) => {
      void delivery.enqueue(notification.text, notification.key).catch(() => {})
      await delivery.settle()
      return true
    },
    async commit() {
      const notice = queue.drainPending()
      if (notice?.kind !== "message") throw new Error("missing workflow completion")
      expect(queue.drainPending()).toBeNull()
      await tree.recordCanonicalMessage({ kind: "user", origin: "system", content: notice.text, backgroundNotificationIds: notice.backgroundNotificationIds })
      await tree.flushSavePoint()
      return notice.text
    },
  }
}

describe("a workflow Stop", () => {
  test("records the parent's tool call as stopped, the one durable fact every reader of the child reads, also after a restart", async () => {
    const { store, writer } = await setup()
    expect(await readChildStop(asAsyncEventReadSurface(store), LAUNCH)).toBeUndefined()

    expect(await stop(store, writer, "person")).toBe(true)

    const [result] = store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })
    expect(result?.payload).toMatchObject({ toolUseId: TOOL_USE_ID, outcome: "stopped" })
    expect(await readChildStop(asAsyncEventReadSurface(store), LAUNCH)).toBe("person")
    // A Stop never rewrites how a call ended.
    expect(await stop(store, writer, "agent")).toBe(false)

    // Cold read: a fresh store over the same file, as after a restart.
    const reopened = openStore()
    expect(await readChildStop(asAsyncEventReadSurface(reopened.store), LAUNCH)).toBe("person")
    const call = await readChildCall(asAsyncEventReadSurface(reopened.store), LAUNCH)
    expect(workflowSessionActions("inactive", "paused", { toolCall: workflowToolCall(TOOL_USE_ID, call) })).toEqual(["session.delete"])
  })

  test("ends a call that crash recovery guessed interrupted, because the guess is no result: the row offers Stop, and the Stop becomes the call's result", async () => {
    const { store, writer } = await setup()
    const reader = asAsyncEventReadSurface(store)
    const tools = createSessionToolExecutionStore({ sessionId: "parent", projectionReader: reader })
    const facts = createSessionFactWriter({ sessionId: "parent", writer })
    await repairInterruptedToolExecutions(tools, facts)
    tools.dispose()
    facts.dispose()
    const outcomes = () => store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }).map(({ payload }) => payload.outcome)
    expect(outcomes()).toEqual(["interrupted"])

    const call = await readChildCall(reader, LAUNCH)
    expect(call).toEqual({})
    expect(workflowSessionActions("active", "running", { toolCall: workflowToolCall(TOOL_USE_ID, call) })).toContain("background.terminate")

    expect(await stop(store, writer, "person")).toBe(true)
    expect(outcomes()).toEqual(["interrupted", "stopped"])
    expect(await readChildStop(reader, LAUNCH)).toBe("person")
  })

  test("by the requesting agent reads as canceled", async () => {
    const { store, writer } = await setup()
    await stop(store, writer, "agent")
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })[0]?.payload).toMatchObject({ outcome: "cancelled" })
    expect(await readChildStop(asAsyncEventReadSurface(store), LAUNCH)).toBe("agent")
  })

  test("reads only the launching tool call from the parent", async () => {
    const { store, writer } = await setup()
    await stop(store, writer, "person")
    const queries: FactQuery[] = []
    const reader = {
      ...store,
      read: (query: FactQuery = {}) => {
        queries.push(query)
        return store.read(query)
      },
    }

    expect(await readChildStop(asAsyncEventReadSurface(reader), LAUNCH)).toBe("person")
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({
      aggregateId: "session:parent",
      toolUseIds: [TOOL_USE_ID],
    })
  })

  test("reconciliation delivers the stop's notification, with the last handoff as a record, to the waiting parent once and holds no call open for it", async () => {
    const { store, writer } = await setup()
    // A step handed off before the Stop: the parent learns what finished,
    // framed as a record, and the person's Stop instruction still ends it.
    const content = { summary: "Plan reviewed" }
    const evidence = contentEvidence(JSON.stringify(content))
    store.append({
      aggregateId: "workflow:child", sessionId: "child", timestamp: Date.now(), type: "handoff.written", version: 1, actor: "worker",
      payload: { stepId: "review", stepName: "Review", definitionId: "review", workflowDefinitionId: "workflow", content, bytes: evidence.bytes, sha256: evidence.sha256, preview: evidence.preview },
    })
    await stop(store, writer, "person")
    await replaceWorkflowState(store, "child", "Implement the reviewed change", "completed")
    const notifications = parentNotifications(store, writer)
    const reconcile = () => reconcileChildSessionCompletions({
      parentSessionId: "parent", reader: asAsyncEventReadSurface(store), writer,
      deliverNotification: notifications.deliverNotification,
    })

    const first = await reconcile()
    expect(first.durableTerminalChildSessionIds).toEqual([])
    expect(first.linkedNonterminalWorkflowToolUseIds ?? []).toEqual([])
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    expect((await reconcile()).durableTerminalChildSessionIds).toEqual([])
    const delivered = await notifications.commit()
    expect(delivered).toContain("The user stopped it before it finished; it will not resume.")
    expect(delivered).toContain('The last handoff before the Stop, a record of finished work and not a request to continue, is from step "Review":\n{\n  "summary": "Plan reviewed"\n}')
    expect(delivered).toEndWith("Do not redo the stopped work. Tell the user it stopped and wait for their direction.")
    expect((await reconcile()).durableTerminalChildSessionIds).toContain("child")
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    expect(notifications.queue.drainPending()).toBeNull()
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })[0]?.payload).toMatchObject({ outcome: "stopped" })
    expect(workflowSessionActions("inactive", "completed", { toolCall: workflowToolCall(TOOL_USE_ID, { stoppedBy: "person" }) })).toEqual(["session.delete"])
  })

  test("a deletion of the child delivers a recorded Stop's notification before it removes the child, when the Stop's own reconciliation has not run", async () => {
    const { store, writer } = await setup()
    expect(await stop(store, writer, "person")).toBe(true)
    const aborted: string[] = []
    const run = await workflowRunReader(asAsyncEventReadSurface(store)).read("child")
    if (!run) throw new Error("the workflow is missing")

    await workflowRunOwner().settleDeletion({
      projectRoot: tmpDir, workflowId: "child", run,
      reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer,
      abort: async (sessionId) => { aborted.push(sessionId) },
    })

    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map(({ key }) => key)).toEqual(["workflow-completion:child"])
    expect(aborted).toEqual(["child"])
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }).map(({ payload }) => payload.outcome)).toEqual(["stopped"])
  })

  test.each(["person", "agent"] as const)("cannot replace a completed parent result with a later %s Stop", async (stoppedBy) => {
    const { store, writer } = await setup()
    await replaceWorkflowState(store, "child", "Implement the reviewed change", "completed")
    await reconcileChildSessionCompletions({
      parentSessionId: "parent", reader: asAsyncEventReadSurface(store), writer,
    })

    expect(await stop(store, writer, stoppedBy)).toBe(false)
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })[0]?.payload).toMatchObject({ outcome: "ok" })
  })
})

describe("a workflow that cannot start", () => {
  test("settles the parent's call as failed once, never as a Stop, keeps the child, and delivers its notification once", async () => {
    const { store, writer } = await setup()
    const startFailure = () => recordChildWorkflowStartFailure({
      reader: asAsyncEventReadSurface(store), writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow",
    })

    expect(await startFailure()).toBe(true)
    expect(await startFailure()).toBe(false)

    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }).map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ toolUseId: TOOL_USE_ID, outcome: "error" }),
    ])
    expect(await readChildStop(asAsyncEventReadSurface(store), LAUNCH)).toBeUndefined()
    const notifications = parentNotifications(store, writer)
    const reconcile = () => reconcileChildSessionCompletions({
      parentSessionId: "parent", reader: asAsyncEventReadSurface(store), writer,
      deliverNotification: notifications.deliverNotification,
    })

    // The call is settled, but its notification stays owed until commit.
    const first = await reconcile()
    expect(first.durableTerminalChildSessionIds).toEqual([])
    expect(first.linkedNonterminalWorkflowToolUseIds ?? []).toEqual([])
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    expect((await reconcile()).durableTerminalChildSessionIds).toEqual([])
    expect(await notifications.commit()).toContain("Workflow failed to start: ")
    expect((await reconcile()).durableTerminalChildSessionIds).toContain("child")
    expect(notifications.queue.drainPending()).toBeNull()

    // A Resume ran the child again under its parent, and the parent stopped
    // that run: the Stop is a new outcome and owes its own notice, once.
    expect(await recordChildWorkflowStop({
      reader: asAsyncEventReadSurface(store), writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow", stoppedBy: "agent", correctPriorResult: true,
    })).toBe(true)
    await reconcile()
    await reconcile()
    expect(await notifications.commit()).toContain("Workflow stopped: ")
    expect((await reconcile()).durableTerminalChildSessionIds).toContain("child")
    expect(store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    expect(notifications.queue.drainPending()).toBeNull()
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
    expect(await workflowRunReader(asAsyncEventReadSurface(store)).read("child")).toMatchObject({ launchedFrom: { parentSessionId: "parent", toolUseId: TOOL_USE_ID } })
    expect(await manager.read("child")).toBeNull()
    expect((await manager.read("parent"))?.childSessionIds).toBeUndefined()
  })

  test("leaves its row no Stop once the call holds the failure, also while it runs again after a Resume, and a Stop records nothing", async () => {
    const { store, writer } = await setup()
    const actionsWhileRunning = async () => workflowSessionActions("active", "running", {
      toolCall: workflowToolCall(TOOL_USE_ID, await readChildCall(asAsyncEventReadSurface(store), LAUNCH)),
    })
    expect(await actionsWhileRunning()).toContain("background.terminate")

    await recordChildWorkflowStartFailure({
      reader: asAsyncEventReadSurface(store), writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow",
    })

    // The call no longer waits, so a Stop has nothing to settle: the row
    // offers Interrupt and deletion, and a Stop sent anyway changes nothing.
    expect(await actionsWhileRunning()).toEqual(["workflow.interrupt", "session.delete"])
    expect(await stop(store, writer, "person")).toBe(false)
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }).map(({ payload }) => payload.outcome)).toEqual(["error"])
  })
})

describe("a workflow Stop of a call whose description has line breaks", () => {
  const description = "Build the host.\n\nRead first: the spike results."

  async function startFailed() {
    const { store, writer } = await setup(description)
    const reader = asAsyncEventReadSurface(store)
    await recordChildWorkflowStartFailure({ reader, writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow" })
    const prior = await readToolExecution(reader, "parent", TOOL_USE_ID)
    if (!prior?.resultEventId) throw new Error("the start failure recorded no result")
    return { store, writer, reader, priorResultEventId: prior.resultEventId }
  }

  test("corrects the call's earlier result, and the parent's tool history still reads", async () => {
    const { writer, reader } = await startFailed()

    expect(await recordChildWorkflowStop({ reader, writer, parentSessionId: "parent", toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow", stoppedBy: "agent", correctPriorResult: true })).toBe(true)

    expect((await readToolExecution(reader, "parent", TOOL_USE_ID))?.resultOutcome).toBe("cancelled")
  })

  test("reads a correction recorded before 2026-10-25, which stored the description with spaces for its line breaks", async () => {
    const { store, reader, priorResultEventId } = await startFailed()
    const evidence = contentEvidence("Workflow stopped")
    store.append({
      aggregateId: "session:parent", sessionId: "parent", timestamp: Date.now(), type: "workflow.tool_result.corrected", version: 1, actor: "flywheel",
      payload: {
        toolUseId: TOOL_USE_ID, childSessionId: "child", workflowDefinitionId: "workflow",
        description: "Build the host.  Read first: the spike results.",
        priorResultEventId, outcome: "cancelled", bytes: evidence.bytes, sha256: evidence.sha256, preview: evidence.preview,
      },
    })

    expect((await readToolExecution(reader, "parent", TOOL_USE_ID))?.resultOutcome).toBe("cancelled")
  })
})
