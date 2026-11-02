import { afterEach, describe, expect, it } from "bun:test"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types"
import { cleanupTmpRoot, finalizeTestSessionDeletion, makeDeps, makeDepsWithStore, makeTmpDir, publishTestWorkflow } from "./_session-manager-fixtures"

afterEach(() => {
  cleanupTmpRoot()
})

// Deletion finalization: metadata and queue tombstones share an
// EventStore + transaction. Both writes commit together or both roll back:
// neither projection is left dangling.

describe("SessionManager deletion finalization atomicity", () => {
  it("fences new workflow publication under an admitted workflow target", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "parent" })
    await publishTestWorkflow(manager, { id: "child", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" } })
    await manager.admitDeletion("parent")
    await expect(publishTestWorkflow(manager, { id: "late", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "late-launch" } })).rejects.toThrow("deletion is in progress")
    expect(await manager.read("late")).toBeNull()
    store.close()
  })
  it("tombstones the workflow run and queue projection in one transaction", async () => {
    const baseDir = makeTmpDir()
    const mgr = createSessionManager(makeDeps(baseDir))
    const id = await publishTestWorkflow(mgr, { workflowDefinitionId: "plans/test.md", name: "Test" })

    await finalizeTestSessionDeletion(mgr, id)

    // Both projections should be cleared.
    const verify = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      const queueAfter = await createWorkflowViewStore({ sessionId: id, reader: asAsyncEventReadSurface(verify) }).loadQueue()
      expect(queueAfter).toBeNull()
      expect(verify.read({ aggregateId: `workflow:${id}` }).at(-1)?.type).toBe("queue.deleted")
    } finally {
      verify.close()
    }

    expect((await mgr.listMetadata()).sessions.find((s) => s.id === id)).toBeUndefined()
  })

  it("deletes a pre-cutover workflow whose aggregate has no initialization marker", async () => {
    const baseDir = makeTmpDir()
    const id = "pre-cutover-workflow"
    const { deps, store } = makeDepsWithStore(baseDir)
    store.append({
      aggregateId: `session:${id}`, sessionId: id, timestamp: Date.now(),
      type: "session.created", version: 5, actor: "flywheel",
      payload: { label: "Legacy workflow", name: "Legacy workflow", kind: "workflow", command: "workflow", workflowDefinitionId: "legacy", executionCwd: baseDir, lifecycleState: "inactive", lastUpdated: new Date().toISOString() },
    })
    store.append({
      aggregateId: workflowAggregateId(id),
      sessionId: id,
      timestamp: Date.now(),
      type: "queue.created",
      version: 9,
      actor: "flywheel",
      payload: { queue: { steps: [], cursor: 0, status: "running", mutationLog: [] } },
    })
    const mgr = createSessionManager(deps)

    await expect(finalizeTestSessionDeletion(mgr, id)).resolves.toBeUndefined()

    const sessionEvents = store.read({ aggregateId: `session:${id}` })
    const workflowEvents = store.read({ aggregateId: workflowAggregateId(id) })
    expect(sessionEvents.at(-1)?.type).toBe("session.deleted")
    expect(workflowEvents.map(({ type }) => type)).toEqual(["queue.created", "queue.deleted"])
    expect(workflowEvents.at(-1)?.position).toBe((sessionEvents.at(-1)?.position ?? 0) + 1)
    expect((await mgr.listMetadata()).sessions.find((session) => session.id === id)).toBeUndefined()
  })

  it("leaves no workflow aggregate when deleting a chat session", async () => {
    const baseDir = makeTmpDir()
    const mgr = createSessionManager(makeDeps(baseDir))
    const id = await mgr.createChat({ name: "Chat" })

    await finalizeTestSessionDeletion(mgr, id)

    const verify = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      expect(verify.read({ aggregateId: `workflow:${id}` })).toEqual([])
    } finally {
      verify.close()
    }
  })

  it("listMetadata never lists a deleted session, even when a later metadata fact lands before the next list", async () => {
    const baseDir = makeTmpDir()
    const mgr = createSessionManager(makeDeps(baseDir))
    const doomed = await mgr.createChat({ name: "Doomed" })
    const kept = await mgr.createChat({ name: "Kept" })
    // Warm the long-lived projection so its position sits before the tombstone.
    await mgr.listMetadata()

    await finalizeTestSessionDeletion(mgr, doomed)
    // A sibling metadata fact whose apply() advances the projection past the
    // tombstone's position. If the delete bypassed the store's projection, the
    // tombstone would be skipped forever and the ghost row would persist.
    await mgr.updateLabel(kept, { label: "Kept!", shortLabel: "K" }, "generated")

    expect((await mgr.listMetadata()).sessions.map((s) => s.id)).toEqual([kept])
  })

})
