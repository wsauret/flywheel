import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { Log } from "../../../../src/infra/log"
import { openProjectState, recoverOwedSessions, recoverProject } from "../../../helpers/project-recovery"
import {
  decodeRetainedChildSessionDeletion,
  executeChildSessionDeletionPlan,
} from "../../../../src/orchestration/session/child-session-deletion"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { advanceTestWorkflow, cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { testDirectories } from "../../../helpers/directories"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { readToolExecution } from "../../../../src/orchestration/session/tool-execution-projection"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog"
import { deliverWorkflowInput } from "../../../../src/orchestration/session/session-input-delivery"

afterEach(cleanupTmpRoot)

describe("recursive child session deletion", () => {
  test("admits automatic deletion only when the chat and its owned sessions are old and inactive", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const manager = createSessionManager(deps)
    const now = Date.now()
    await manager.createChat({ id: "parent", initialState: "inactive" })
    await publishTestSubagent(manager, projectRoot, "child", "parent")
    await manager.updateLifecycleState("child", "inactive")
    const cutoff = now + 86_400_000
    expect((await manager.admitDeletion("child", cutoff)).targets).toEqual([])
    expect((await manager.admitDeletion("parent", now - 86_400_000)).targets).toEqual([])
    await manager.updateLifecycleState("child", "active")
    expect((await manager.admitDeletion("parent", cutoff)).targets).toEqual([])
    await manager.updateLifecycleState("child", "inactive")
    const child = await manager.read("child")
    if (!child) throw new Error("missing child")
    const plan = await manager.admitDeletion("parent", Date.parse(child.lastUpdated))
    expect(plan.targets.map((target) => target.kind)).toEqual(["child", "root"])
    await expect(manager.updateLifecycleState("parent", "active")).rejects.toThrow("deletion")
    store.close()
  })
  test("does not admit automatic deletion of a running workflow before its first member starts", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const manager = createSessionManager(deps)
    await manager.createChat({ id: "parent", conversationId: "parent-conversation", initialState: "inactive" })
    await publishTestWorkflow(manager, { id: "workflow", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "workflow-call" } })
    await advanceTestWorkflow(manager, store, "workflow", { type: "START" })
    expect((await manager.read("parent"))?.childSessionIds ?? []).toEqual([])
    expect((await manager.admitDeletion("parent", Date.now() + 86_400_000)).targets).toEqual([])
    expect(store.readInFlight("parent", "session.subagent_recursive_deletion")).toEqual([])
    await advanceTestWorkflow(manager, store, "workflow", { type: "PAUSE", reason: "person" })
    expect((await manager.admitDeletion("parent", Date.now() + 86_400_000)).targets.map((target) => target.kind)).toEqual(["workflow", "root"])
    store.close()
  })
  test("deletes a zero-member workflow without deleting its chat or sibling workflow", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const manager = createSessionManager(deps)
    await manager.createChat({ id: "parent", conversationId: "conversation", name: "parent", initialState: "inactive" })
    for (const id of ["first", "second"]) await publishTestWorkflow(manager, {
      id, launchedFrom: { parentSessionId: "parent", conversationId: "conversation", toolUseId: id },
    })
    await manager.createChat({ id: "peer", conversationId: "peer-conversation", name: "Peer", initialState: "inactive" })
    await deliverWorkflowInput({
      projectionReader: deps.projectionReader, eventWriter: asAsyncEventWriter(store), manager,
    }, "first", { text: "Retained peer input", producer: { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "message", hop: 1 } })
    expect(store.readInFlight("first", "chat.queued_user_input")).toHaveLength(1)
    const plan = await manager.admitDeletion("first")
    expect(plan.targets).toEqual([{ kind: "workflow", rootSessionId: "first", workflowId: "first", parentSessionId: "parent" }])
    await executeChildSessionDeletionPlan({
      projectRoot, reader: deps.projectionReader, projectionReader: deps.projectionReader,
      writer: asAsyncEventWriter(store), read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget,
    }, plan)
    expect(await workflowRunReader(deps.projectionReader).read("first")).toBeNull()
    expect(await workflowRunReader(deps.projectionReader).read("second")).not.toBeNull()
    expect(await manager.read("parent")).not.toBeNull()
    expect(store.read({ aggregateId: "session:first" })).toEqual([])
    expect(store.readInFlight("first", "chat.queued_user_input")).toHaveLength(0)
    expect(store.readInFlight("peer", "chat.queued_background_notification")).toHaveLength(1)
    store.close()
  })
  test("strictly decodes retained v1 deletion cells", () => {
    expect(decodeRetainedChildSessionDeletion({
      version: 1,
      rootSessionId: "root",
      edges: [{ parentSessionId: "root", childSessionId: "child" }],
    }, "root")).toEqual({
      version: 1,
      rootSessionId: "root",
      edges: [{ parentSessionId: "root", childSessionId: "child" }],
    })
    expect(() => decodeRetainedChildSessionDeletion({
      version: 1,
      rootSessionId: "root",
      edges: [
        { parentSessionId: "root", childSessionId: "child" },
        { parentSessionId: "root", childSessionId: "child" },
      ],
    }, "root")).toThrow("unknown recursive deletion edge")
  })

  test("deletes mixed live descendants from leaves to root and preserves independent chats", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    const root = await manager.createChat({ id: "root", conversationId: "root-conversation", name: "root", initialState: "inactive" })

    await publishTestSubagent(manager, projectRoot, "child", root)
    await publishTestSubagent(manager, projectRoot, "grandchild", "child")
    await publishTestSubagent(manager, projectRoot, "great-grandchild", "grandchild")
    await publishTestWorkflow(manager, {
      id: "workflow",
      launchedFrom: { parentSessionId: root, conversationId: "root-conversation", toolUseId: "workflow-tool" },
    })
    const member = await startTestWorkflowMember(manager, store, "workflow")
    await publishTestSubagent(manager, projectRoot, "workflow-child", member)
    await manager.createChat({ id: "independent", name: "independent", initialState: "inactive" })
    const deleted: string[] = []
    const unsubscribe = manager.subscribe((change) => {
      if (change.kind === "deleted") deleted.push(change.sessionId)
    })

    await executeChildSessionDeletionPlan({
      projectRoot,
      reader: deps.projectionReader,
      projectionReader: deps.projectionReader,
      writer,
      read: manager.read,
      finalizeDeletionTarget: manager.finalizeDeletionTarget,
    }, await manager.admitDeletion(root))

    for (const id of [root, "child", "grandchild", "great-grandchild", member, "workflow-child"]) expect(await manager.read(id)).toBeNull()
    expect(await workflowRunReader(deps.projectionReader).read("workflow")).toBeNull()
    expect(await manager.read("independent")).not.toBeNull()
    expect(store.read({ types: ["session.child.linked"] }).map((fact) => fact.payload.childSessionId)).toEqual(
      expect.arrayContaining(["child", "grandchild", "great-grandchild", member]),
    )
    expect(deleted).toEqual(["workflow-child", member, "great-grandchild", "grandchild", "child", root])
    expect(store.readInFlight(root, "session.subagent_recursive_deletion")).toEqual([])
    unsubscribe()
    store.close()
  })

  test("refuses an unauthorized target or stale live binding without retiring progress", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    const root = await manager.createChat({ id: "root", conversationId: "root-conversation", name: "root", initialState: "inactive" })
    await publishTestSubagent(manager, projectRoot, "child", root)
    const plan = await manager.admitDeletion(root)

    await expect(manager.finalizeDeletionTarget({
      kind: "root",
      rootSessionId: root,
      sessionId: "not-root",
    })).rejects.toThrow("not an admitted deletion target")

    await manager.unlinkChild(root, "child")
    const childTarget = plan.targets[0]
    if (!childTarget || childTarget.kind !== "child") throw new Error("expected child deletion target")
    await expect(manager.finalizeDeletionTarget(childTarget)).rejects.toThrow("no longer has its admitted live child binding")
    expect(await manager.read(root)).not.toBeNull()
    expect(await manager.read("child")).not.toBeNull()
    expect(store.readInFlight(root, "session.subagent_recursive_deletion")).toHaveLength(1)
    store.close()
  })

  test("awaits workflow root settlement before its tombstone", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "parent" })
    const input = { workflow_definition_id: "fixture-workflow", summary: "Root", description: "Root" }
    const evidence = contentEvidence(JSON.stringify(input))
    const facts = createSessionFactWriter({ sessionId: "parent", writer })
    await facts.record({
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: {
        toolUseId: "launch", toolName: "workflow", input,
        inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
        executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
      },
    })
    facts.dispose()
    const id = await publishTestWorkflow(manager, { id: "workflow-root", name: "Root", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" } })
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const execution = executeChildSessionDeletionPlan({
      projectRoot, reader: deps.projectionReader, projectionReader: deps.projectionReader, writer,
      read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget,
      abort: async (sessionId) => {
        expect(sessionId).toBe(id)
        entered.resolve()
        await released.promise
      },
    }, await manager.admitDeletion(id))
    try {
      await entered.promise
      expect((await readToolExecution(deps.projectionReader, "parent", "launch"))?.resultOutcome).toBe("stopped")
      expect(await workflowRunReader(deps.projectionReader).read(id)).not.toBeNull()
      expect(store.read({ aggregateId: `session:${id}`, types: ["session.deleted"] })).toEqual([])
    } finally { released.resolve() }
    await execution
    expect(await manager.read(id)).toBeNull()
    expect((await manager.read("parent"))?.childSessionIds ?? []).not.toContain(id)
    store.close()
  })

  test("deletes an adopted workflow only with its current parent and preserves old retained scope", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    await manager.createChat({ id: "old", conversationId: "old-conversation", name: "old", initialState: "inactive" })
    await manager.createChat({ id: "adopter", conversationId: "adopter-conversation", name: "adopter", initialState: "inactive" })
    await publishTestWorkflow(manager, { id: "adopted", launchedFrom: { parentSessionId: "old", conversationId: "old-conversation", toolUseId: "old-tool" } })
    await manager.adoptWorkflow({ workflowId: "adopted", launchedFrom: { parentSessionId: "adopter", conversationId: "adopter-conversation", toolUseId: "new-tool" } })
    store.putInFlight("old", "session.subagent_recursive_deletion", "old", { version: 1, rootSessionId: "old", edges: [] })
    const ports = { projectRoot, reader: deps.projectionReader, projectionReader: deps.projectionReader, writer, read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget }
    await recoverProject({ directories: testDirectories(projectRoot), reader: deps.projectionReader, writer }, "closed-generation")
    expect(await manager.read("old")).toBeNull()
    expect(await workflowRunReader(deps.projectionReader).read("adopted")).not.toBeNull()
    const plan = await manager.admitDeletion("adopter")
    expect(plan.targets.map((target) => target.kind === "workflow" ? target.workflowId : target.sessionId)).toEqual(["adopted", "adopter"])
    await executeChildSessionDeletionPlan(ports, plan)
    expect(await workflowRunReader(deps.projectionReader).read("adopted")).toBeNull()
    store.close()
  })

  test("refuses a stale child target after the root operation is retired", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const manager = createSessionManager(deps)
    const root = await manager.createChat({ id: "root", name: "root", initialState: "inactive" })
    const plan = await manager.admitDeletion(root)
    const rootTarget = plan.targets[0]
    if (!rootTarget || rootTarget.kind !== "root") throw new Error("expected root deletion target")
    await manager.finalizeDeletionTarget(rootTarget)

    await expect(manager.finalizeDeletionTarget({
      kind: "child",
      rootSessionId: root,
      parentSessionId: root,
      sessionId: "stale-child",
    })).rejects.toThrow("missing its child deletion operation")
    await expect(manager.finalizeDeletionTarget(rootTarget)).resolves.toEqual([])
    store.close()
  })

  test("recovers a deletion root retained only by its in-flight operation", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)

    if (!writer.putInFlight) throw new Error("test writer does not support in-flight state")
    await writer.putInFlight("deleted-root", "session.subagent_recursive_deletion", "deleted-root", {
      version: 1,
      rootSessionId: "deleted-root",
      edges: [],
    })

    await recoverProject({ directories: testDirectories(projectRoot), reader: deps.projectionReader, writer }, "closed-generation")
    expect(store.readInFlight("deleted-root", "session.subagent_recursive_deletion")).toEqual([])
    expect(store.read({ aggregateId: "session:deleted-root", types: ["session.deleted"] })).toHaveLength(1)
    store.close()
  })

  test("preserves a fork of the deleted chat and its conversation", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    const root = await manager.createChat({ id: "root", conversationId: "root-conversation", name: "root", initialState: "inactive" })
    const tree = await ConversationTreeStorage.open({ conversationId: "root-conversation", sessionId: root, store: deps.projectionReader, writer })
    await tree.appendEntries([
      { kind: "message", id: "question", parentId: null, timestamp: new Date().toISOString(), message: { kind: "user", content: "question" } },
      { kind: "message", id: "answer", parentId: "question", timestamp: new Date().toISOString(), message: { kind: "assistant", content: "answer" } },
    ])
    tree.dispose()
    const fork = await manager.forkChat(root)
    await publishTestSubagent(manager, projectRoot, "child", root)
    expect((await manager.read(root))?.childSessionIds).toEqual(expect.arrayContaining([fork, "child"]))

    const plan = await manager.admitDeletion(root)
    expect(plan.targets.map((target) => target.kind === "workflow" ? target.workflowId : target.sessionId)).toEqual(["child", root])
    await executeChildSessionDeletionPlan({
      projectRoot, reader: deps.projectionReader, projectionReader: deps.projectionReader, writer,
      read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget,
    }, plan)

    expect(await manager.read(root)).toBeNull()
    expect(await manager.read("child")).toBeNull()
    const survivor = await manager.read(fork)
    if (survivor?.kind !== "chat") throw new Error("expected the fork to survive as a chat")
    const forked = await ConversationTreeStorage.open({ conversationId: survivor.conversationId, sessionId: fork, store: deps.projectionReader, writer })
    try {
      expect(await forked.getEntry("question")).toMatchObject({ message: { kind: "user", content: "question" } })
      expect(await forked.getEntry("answer")).toMatchObject({ message: { kind: "assistant", content: "answer" } })
    } finally { forked.dispose() }
    store.close()
  })

  test("recovers the remaining targets of a deletion that stopped after its first edge, leaf to root", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const first = createSessionManager({ ...deps, writer })
    const root = await first.createChat({ id: "root", conversationId: "root-conversation", name: "root", initialState: "inactive" })
    await publishTestWorkflow(first, { id: "workflow", launchedFrom: { parentSessionId: root, conversationId: "root-conversation", toolUseId: "workflow-tool" } })
    const member = await startTestWorkflowMember(first, store, "workflow")
    await publishTestSubagent(first, projectRoot, "leaf", member)
    const plan = await first.admitDeletion(root)
    const leaf = plan.targets[0]
    if (!leaf) throw new Error("expected a first deletion target")
    await first.finalizeDeletionTarget(leaf)

    // A new process reads the same store.
    const state = openProjectState({ directories: testDirectories(projectRoot), reader: deps.projectionReader, writer })
    const { manager } = state
    const deleted: string[] = []
    const unsubscribe = manager.subscribe((change) => { if (change.kind === "deleted") deleted.push(change.sessionId) })
    const recovered = await recoverOwedSessions(state, "closed-generation")

    expect(recovered.degraded).toEqual([])
    expect(deleted).toEqual([member, root])
    for (const id of [root, member, "leaf"]) expect(await manager.read(id)).toBeNull()
    expect(await workflowRunReader(deps.projectionReader).read("workflow")).toBeNull()
    expect(store.readInFlight(root, "session.subagent_recursive_deletion")).toEqual([])
    unsubscribe()
    store.close()
  })

  test("awaits a workflow child's settlement before any tombstone of its parent's deletion", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    const root = await manager.createChat({ id: "root", conversationId: "root-conversation", name: "root", initialState: "inactive" })
    await publishTestWorkflow(manager, { id: "workflow", launchedFrom: { parentSessionId: root, conversationId: "root-conversation", toolUseId: "workflow-tool" } })
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const execution = executeChildSessionDeletionPlan({
      projectRoot, reader: deps.projectionReader, projectionReader: deps.projectionReader, writer,
      read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget,
      abort: async (sessionId) => {
        expect(sessionId).toBe("workflow")
        entered.resolve()
        await released.promise
      },
    }, await manager.admitDeletion(root))
    try {
      await entered.promise
      expect(store.read({ types: ["session.deleted"] })).toEqual([])
      expect(await workflowRunReader(deps.projectionReader).read("workflow")).not.toBeNull()
    } finally { released.resolve() }
    await execution
    expect(store.read({ types: ["session.deleted"] }).map((fact) => fact.sessionId)).toEqual([root])
    expect(await workflowRunReader(deps.projectionReader).read("workflow")).toBeNull()
    store.close()
  })

  test("keeps a retained deletion of an unknown version, warns once, and finishes every other one", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    await manager.createChat({ id: "a-unreadable", conversationId: "a-unreadable-conversation", name: "unreadable", initialState: "inactive" })
    await publishTestSubagent(manager, projectRoot, "child", "a-unreadable")
    const tree = await ConversationTreeStorage.open({ conversationId: "a-unreadable-conversation", sessionId: "a-unreadable", store: deps.projectionReader, writer })
    await tree.appendEntries([{ kind: "message", id: "question", parentId: null, timestamp: new Date().toISOString(), message: { kind: "user", content: "question" } }])
    tree.dispose()
    const fork = await manager.forkChat("a-unreadable")
    store.putInFlight("a-unreadable", "session.subagent_recursive_deletion", "a-unreadable", { version: 9, rootSessionId: "a-unreadable", edges: [] })
    store.putInFlight("b-deleted", "session.subagent_recursive_deletion", "b-deleted", { version: 1, rootSessionId: "b-deleted", edges: [] })
    const warn = spyOn(Log.create({ service: "project-state-recovery" }), "warn").mockImplementation(() => {})

    try {
      const recovered = await recoverProject({ directories: testDirectories(projectRoot), reader: deps.projectionReader, writer }, "closed-generation")

      const error = "Session a-unreadable has a recursive deletion operation of unknown version 9"
      expect(recovered.degraded).toEqual([{ sessionId: "a-unreadable", error }])
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith("retained session deletion degraded"))).toEqual([
        ["retained session deletion degraded; its operation is kept and the project opens", { sessionId: "a-unreadable", error }],
      ])
    } finally { warn.mockRestore() }
    expect(store.readInFlight("a-unreadable", "session.subagent_recursive_deletion")).toHaveLength(1)
    expect(await manager.read("a-unreadable")).not.toBeNull()
    expect(await manager.read("child")).not.toBeNull()
    expect(store.readInFlight("b-deleted", "session.subagent_recursive_deletion")).toEqual([])
    expect(store.read({ aggregateId: "session:b-deleted", types: ["session.deleted"] })).toHaveLength(1)
    // The unreadable deletion holds every launch below its root, at any
    // depth, and none in a fork of the root or elsewhere.
    await expect(publishTestSubagent(manager, projectRoot, "held", "a-unreadable")).rejects.toThrow("while deletion is in progress")
    await expect(publishTestSubagent(manager, projectRoot, "held-grandchild", "child")).rejects.toThrow("while deletion is in progress")
    await publishTestSubagent(manager, projectRoot, "below-fork", fork)
    expect((await manager.read(fork))?.childSessionIds).toEqual(["below-fork"])
    const elsewhere = await manager.createChat({ id: "elsewhere", name: "elsewhere", initialState: "inactive" })
    await publishTestSubagent(manager, projectRoot, "launched", elsewhere)
    expect((await manager.read(elsewhere))?.childSessionIds).toEqual(["launched"])
    store.close()
  })

  test("finishes a parent's deletion once its unlinked child's own deletion ends, whatever their order", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...deps, writer })
    const origin = await manager.createChat({ id: "a-origin", conversationId: "origin-conversation", name: "origin", initialState: "inactive" })
    await publishTestSubagent(manager, projectRoot, "b-child", origin)
    await manager.admitDeletion(origin)
    // An earlier build unlinked the child and admitted its own deletion
    // before the process stopped.
    await manager.unlinkChild(origin, "b-child")
    await manager.admitDeletion("b-child")

    const recovered = await recoverProject({ directories: testDirectories(projectRoot), reader: deps.projectionReader, writer }, "closed-generation")

    expect(recovered.degraded).toEqual([])
    expect(await manager.read(origin)).toBeNull()
    expect(await manager.read("b-child")).toBeNull()
    expect(store.readInFlight(origin, "session.subagent_recursive_deletion")).toEqual([])
    expect(store.readInFlight("b-child", "session.subagent_recursive_deletion")).toEqual([])
    store.close()
  })
})
