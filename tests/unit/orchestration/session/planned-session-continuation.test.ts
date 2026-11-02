import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { buildDurableSubagentCreated, buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { registerTestChildRun } from "../../../helpers/live-child-run"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff"
import type { WorkflowView } from "../../../../src/workflows/view/types"
import { workflowControlInitializedEvent } from "../../workflows/vm/_workflow-control-fixtures"
import { readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import {
  authorizePlannedSessionContinuation,
  continuationTargetId,
  createContinuationLanes,
  plannedContinuationWork,
  awaitPlannedChildResumes,
  PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND,
  plannedContinuationsFor,
  preparePlannedSessionContinuationConsumption,
  readPlannedSessionContinuationAsync,
  retirePlannedSessionContinuation,
} from "../../../../src/orchestration/session/planned-session-continuation"

let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function openStore() {
  root = mkdtempSync(join(tmpdir(), "planned-session-continuation-"))
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  return { store, writer: asAsyncEventWriter(store) }
}

function parentCreated() {
  const now = new Date().toISOString()
  return prepareSessionFactAppend("parent", buildSessionCreatedFact({
    kind: "workflow-agent", command: "workflow-agent", conversationId: "parent-conversation", workflowMembership: { kind: "attempt", workflowId: "flow", attemptId: "attempt" }, launchedFrom: { parentSessionId: "chat", toolUseId: "launch" }, label: "parent",
    lifecycleState: "active", lastUpdated: now, createdAt: now,
  }))
}

function linked(childSessionId: string) {
  return prepareSessionFactAppend("parent", buildSessionChildLinkedFact(childSessionId, new Date().toISOString()))
}

function childCreated(executionCwd: string, childSessionId = "child") {
  return prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
    childSessionId,
    childRunId: "run",
    conversationId: `${childSessionId}-conversation`,
    parentSessionId: "parent",
    parentConversationId: "parent-conversation",
    parentToolCallId: "parent-tool",
    persona: { name: "explorer", kind: "persona" },
    capabilityGrant: {
      operation: "subagent",
      required: [],
      capabilities: [],
      moduleIds: [],
      requireWorkflowConfirmation: false,
      workflowsMode: "off",
      identity: "test",
    },
    admittedModuleIds: [],
    skillsRevision: 1,
    model: "test/model",
    tools: ["read"],
    executionCwd,
    budget: { maxTurns: 10, maxTokens: 0 },
    parentDepth: 0,
    description: "child",
  }))
}

/** A child of the parent's conversation that a replacement cut and a
 *  successor owes its continuation, so a re-entered step can wait on it. */
async function cutChild(store: ReturnType<typeof openStore>["store"], writer: AsyncEventWriter, childSessionId: string) {
  await writer.append(childCreated(root, childSessionId))
  const tree = await createConversationTree({ conversationId: `${childSessionId}-conversation`, sessionId: childSessionId, store: asAsyncEventReadSurface(store), writer })
  await tree.appendMessage({ kind: "user", content: "Investigate.", origin: "human" })
  const cut = interruptedTurnEnd("replacement")
  await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, "cut"))
  tree.getStorage().dispose()
  await writer.append(prepareSessionFactAppend(childSessionId, buildSubagentPaused({ childRunId: "run", pausedBy: "runtime" })))
  await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { sessionId: childSessionId, kind: "subagent" }, handoffId: "h1", runId: "run" } })
}

function resumed(store: ReturnType<typeof openStore>["store"], childSessionId: string) {
  return registerTestChildRun(asAsyncEventReadSurface(store), {
    sessionId: childSessionId, runId: "run", parentSessionId: "parent", parentConversationId: "parent-conversation", parentToolCallId: "parent-tool",
    stop: () => {}, interrupt: async () => {},
  })
}

function settles(wait: Promise<void>) {
  return Promise.race([wait.then(() => "went on"), Bun.sleep(20).then(() => "waiting")])
}

describe("planned session continuation", () => {
  test("a targeted cut preserves successor dispatch and only overrides its runtime-cut conversation", async () => {
    const { store, writer } = openStore()
    const reader = asAsyncEventReadSurface(store)
    const attempts = ["a", "b"].map((id) => ({ id, definitionId: id, briefId: id, workflowDefinitionId: "test", name: id, status: "running" as const, writes: [], resumeRevertCount: 0, lastConversationId: id }))
    const queue: WorkflowView = { attempts, tree: plainAgentTree(attempts), cursor: 0, status: "running", mutationLog: [] }
    await writer.append(workflowControlInitializedEvent("flow", 0))
    await writer.appendBatch(queueFactsForState(null, queue).map((fact) => ({ aggregateId: "workflow:flow", timestamp: 0, sessionId: "flow", ...fact })))
    for (const conversationId of ["a", "b"]) {
      const tree = await createConversationTree({ conversationId, sessionId: "flow", store: reader, writer })
      await tree.appendMessage({ kind: "user", content: "Work.", origin: "human" })
      const cut = interruptedTurnEnd("replacement")
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, conversationId))
      tree.getStorage().dispose()
    }
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { workflowId: "flow", kind: "workflow" }, handoffId: "h1" } })
    const lanes = createContinuationLanes()
    const gate = Promise.withResolvers<void>()
    const first = lanes.run("flow", () => gate.promise)
    const dispatched: boolean[] = []
    const resume = lanes.resume("flow", async (mayDispatch) => { dispatched.push(mayDispatch()) })
    const cut = (id: string) => lanes.interrupt({
      reader, projectionReader: reader, writer, manager: { read: async () => null }, sessionId: "flow", by: "person",
      address: { addressedTo: [{ _tag: "agent", nodeId: id, definitionId: id }], label: id },
      runs: () => false, interrupt: () => false,
    })
    const interrupted = cut("a")
    gate.resolve()
    await first
    await resume
    expect(await interrupted).toBe(true)
    expect(dispatched).toEqual([true])
    expect((await readChatTurnEnd(reader, "a"))?.end).toEqual({ reason: "paused", pausedBy: "person" })
    expect((await readChatTurnEnd(reader, "b"))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
    expect(await readPlannedSessionContinuationAsync(reader, "flow")).not.toBeNull()
    const evidence = { reader, projectionReader: reader, manager: { read: async () => null } }
    expect((await plannedContinuationWork(evidence, "flow"))?.conversationId).toBe("b")
    expect(await cut("b")).toBe(true)
    expect(await plannedContinuationWork(evidence, "flow")).toBeUndefined()
    store.close()
  })

  test("one row per interrupted session of any kind, keyed by the session, listed by its handoff, and retired exactly once", async () => {
    const { store, writer } = openStore()
    const reader = asAsyncEventReadSurface(store)
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId: "chat", kind: "chat" }, handoffId: "h1" } })
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { workflowId: "flow", kind: "workflow" }, handoffId: "h1" } })
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId: "child", kind: "subagent" }, handoffId: "h1", runId: "run" } })
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId: "older", kind: "chat" }, handoffId: "h0" } })

    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "chat")).toEqual({ version: 3, target: { sessionId: "chat", kind: "chat" }, handoffId: "h1" })
    expect(store.readInFlight("chat", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND).map((row) => row.key)).toEqual(["chat"])
    expect((await plannedContinuationsFor(reader, "h1")).map((row) => continuationTargetId(row.target)).sort()).toEqual(["chat", "child", "flow"])

    expect(await retirePlannedSessionContinuation({ reader, writer, sessionId: "chat" })).toBe(true)
    expect(await retirePlannedSessionContinuation({ reader, writer, sessionId: "chat" })).toBe(false)
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "chat")).toBeNull()
    store.close()
  })

  test("a version 1 row converts to an unattended child authorization a person's Resume consumes once", async () => {
    const { store, writer } = openStore()
    await writer.append(childCreated(root))
    // The shape every ordinary shutdown wrote before replacements wrote rows of their own.
    store.putInFlight("child", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, "run", {
      version: 1,
      sessionId: "child",
      runId: "run",
      parentSessionId: "parent",
      parentConversationId: "parent-conversation",
      parentToolCallId: "parent-tool",
      authorizationId: "legacy-authorization",
      continuation: 1,
    })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "child")).toEqual({ version: 3, target: { sessionId: "child", kind: "subagent" }, runId: "run" })
    // No handoff names it, so no successor resumes it on its own.
    expect(await plannedContinuationsFor(asAsyncEventReadSurface(store), "any-handoff")).toEqual([])

    await writer.append(prepareSessionFactAppend("child", buildSubagentPaused({ childRunId: "run", pausedBy: "runtime" })))
    const projectionReader = asAsyncEventReadSurface(store)
    const consumption = await preparePlannedSessionContinuationConsumption({ reader: projectionReader, sessionId: "child", runId: "run" })
    expect(consumption).not.toBeNull()
    await writer.append(consumption!)
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "child")).toBeNull()
    expect(await preparePlannedSessionContinuationConsumption({ reader: projectionReader, sessionId: "child", runId: "run" })).toBeNull()

    // A replacement's authorization of the same child replaces a version 1 row rather than sitting beside it.
    store.putInFlight("child", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, "run", { version: 1, sessionId: "child", runId: "run", parentSessionId: "parent", parentConversationId: "parent-conversation", parentToolCallId: "parent-tool", authorizationId: "again", continuation: 2 })
    await authorizePlannedSessionContinuation({ reader: projectionReader, writer, continuation: { target: { sessionId: "child", kind: "subagent" }, handoffId: "h2", runId: "run" } })
    expect(store.readInFlight("child", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND).map((row) => row.key)).toEqual(["child"])
    store.close()
  })

  test("a step re-entered after a replacement waits for the child under it that a successor owes its continuation, and only for that child", async () => {
    const { store, writer } = openStore()
    await writer.append(parentCreated())
    await writer.append(linked("child"))
    await writer.append(childCreated(root))
    const direct = asAsyncEventReadSurface(store)
    let pageReads = 0
    const projectionReader = {
      ...direct,
      async readPage(...args: Parameters<typeof direct.readPage>) {
        pageReads += 1
        return direct.readPage(...args)
      },
    }
    const step = { reader: asAsyncEventReadSurface(store), projectionReader, projectRoot: root, parentSessionId: "parent", parentConversationId: "parent-conversation" }

    // A running child is not waited for.
    expect(await Promise.race([awaitPlannedChildResumes(step).then(() => "went on"), Bun.sleep(20).then(() => "waiting")])).toBe("went on")

    // The pause records the child's turn end in its own conversation first.
    const childTree = await createConversationTree({ conversationId: "child-conversation", sessionId: "child", store: asAsyncEventReadSurface(store), writer })
    await childTree.appendMessage({ kind: "user", content: "Investigate.", origin: "human" })
    const cut = interruptedTurnEnd("replacement")
    await childTree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, "cut"))
    await writer.append(prepareSessionFactAppend("child", buildSubagentPaused({ childRunId: "run", pausedBy: "runtime" })))
    // With no row of a handoff, such as after a refused resume retired it,
    // no successor resumes the child, so no step waits for it.
    expect(await Promise.race([awaitPlannedChildResumes(step).then(() => "went on"), Bun.sleep(20).then(() => "waiting")])).toBe("went on")
    await authorizePlannedSessionContinuation({ reader: projectionReader, writer, continuation: { target: { sessionId: "child", kind: "subagent" }, handoffId: "h1", runId: "run" } })
    let wentOn = false
    const waiting = awaitPlannedChildResumes(step).then(() => { wentOn = true })
    // Another attempt's conversation does not wait on it.
    expect(await Promise.race([awaitPlannedChildResumes({ ...step, parentConversationId: "other" }).then(() => "went on"), Bun.sleep(20).then(() => "waiting")])).toBe("went on")
    expect(wentOn).toBe(false)
    const release = registerTestChildRun(step.reader, {
      sessionId: "child", runId: "run", parentSessionId: "parent", parentConversationId: "parent-conversation", parentToolCallId: "parent-tool",
      stop: () => {}, interrupt: async () => {},
    })
    await waiting
    expect(wentOn).toBe(true)
    expect(pageReads).toBeGreaterThan(0)
    release()

    // A person's interrupt recorded over the cut leaves the child
    // interrupted, so no step waits for it.
    const person = interruptedTurnEnd("person")
    await childTree.appendMessage({ kind: "user", content: interruptedTurnMessage(person.pausedBy, false), origin: "system" }, turnEndEntryId(person, "person"))
    childTree.getStorage().dispose()
    expect(await Promise.race([awaitPlannedChildResumes(step).then(() => "went on"), Bun.sleep(20).then(() => "waiting")])).toBe("went on")
    store.close()
  })

  test("a step does not wait on a child its conversation unlinked", async () => {
    const { store, writer } = openStore()
    await writer.append(parentCreated())
    await writer.append(linked("child"))
    await writer.append(linked("gone"))
    await writer.append(prepareSessionFactAppend("parent", buildSessionChildUnlinkedFact("gone", new Date().toISOString())))
    await cutChild(store, writer, "child")
    await cutChild(store, writer, "gone")
    const reader = asAsyncEventReadSurface(store)
    const release = resumed(store, "child")
    expect(await settles(awaitPlannedChildResumes({ reader, projectionReader: reader, parentSessionId: "parent", parentConversationId: "parent-conversation" }))).toBe("went on")
    release()
    store.close()
  })

  test("a step whose parent aggregate holds a corrupt row waits on the children the recovery fold still reads", async () => {
    const { store, writer } = openStore()
    await writer.append(parentCreated())
    await writer.append(linked("child"))
    await writer.append(linked("stray"))
    const db = new Database(resolveEventStoreDbFile(root))
    db.run("update event set payload = '{{{not-json' where session_id = 'parent' and type = 'session.child.linked' and payload like '%stray%'")
    db.close()
    await cutChild(store, writer, "child")
    const reader = asAsyncEventReadSurface(store)
    let wentOn = false
    const waiting = awaitPlannedChildResumes({ reader, projectionReader: reader, parentSessionId: "parent", parentConversationId: "parent-conversation" }).then(() => { wentOn = true })
    await Bun.sleep(20)
    expect(wentOn).toBe(false)
    const release = resumed(store, "child")
    await waiting
    expect(wentOn).toBe(true)
    release()
    store.close()
  })

  test("a row's retained operations may continue a session of any kind, and an operation of an unknown shape leaves the row unreadable and in place", async () => {
    const { store, writer } = openStore()
    const reader = asAsyncEventReadSurface(store)
    const operation = { kind: "module.operation", key: "op-1", ownerSessionId: "chat", target: { sessionId: "other-chat", kind: "chat" }, bindingId: "binding-1" } as const
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { sessionId: "chat", kind: "chat" }, handoffId: "h1", operations: [operation] } })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "chat")).toEqual({ version: 3, target: { sessionId: "chat", kind: "chat" }, handoffId: "h1", operations: [operation] })

    for (const unknown of [{ ...operation, targetKind: "agent" }, { ...operation, resumeAt: 1 }, { ...operation, key: "" }]) {
      store.putInFlight("chat", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, "chat", { version: 2, sessionId: "chat", kind: "chat", handoffId: "h1", operations: [unknown] })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "chat")).toBeNull()
      expect(await retirePlannedSessionContinuation({ reader, writer, sessionId: "chat" })).toBe(false)
      expect(store.readInFlight("chat", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)).toHaveLength(1)
    }
    store.close()
  })

  test("a row of an unknown version is refused, reported, and left in place", async () => {
    const { store, writer } = openStore()
    const reader = asAsyncEventReadSurface(store)
    store.putInFlight("chat", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, "chat", { version: 3, sessionId: "chat", kind: "chat", handoffId: "h1", resumeAt: 1 })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(store), "chat")).toBeNull()
    expect(await plannedContinuationsFor(reader, "h1")).toEqual([])
    expect(await retirePlannedSessionContinuation({ reader, writer, sessionId: "chat" })).toBe(false)
    expect(store.readInFlight("chat", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)).toHaveLength(1)
    store.close()
  })
})
