import { afterEach, describe, expect, it } from "bun:test"

import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir } from "./_session-manager-fixtures"
import { historicalSessionCreatedFacts } from "../../../fixtures/tolerant-reprojection-fixtures.js"

afterEach(() => {
  cleanupTmpRoot()
})

// SessionManager.listForIds() reads only targeted metadata and workflow state.
// Other derived history belongs to the background summary and detail readers.

describe("SessionManager.listForIds() metadata isolation", () => {
  it("confirms conservative active candidates through reducer metadata", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const activeWithUnreadableDeletion = await manager.createChat({ name: "Active" })
    const activeWithCorruptLifecycle = await manager.createChat({ name: "Active corrupt" })
    const inactiveWithUnreadableLifecycle = await manager.createChat({ name: "Inactive undecodable" })
    const inactiveWithCorruptLifecycle = await manager.createChat({ name: "Inactive corrupt" })
    const deleted = await manager.createChat({ name: "Deleted" })
    await manager.updateLifecycleState(inactiveWithUnreadableLifecycle, "inactive")
    await manager.updateLifecycleState(inactiveWithCorruptLifecycle, "inactive")
    const deletedPlan = await manager.admitDeletion(deleted)
    for (const target of deletedPlan.targets) await manager.finalizeDeletionTarget(target)
    store.append({
      aggregateId: `session:${activeWithUnreadableDeletion}`,
      type: "session.deleted",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: activeWithUnreadableDeletion,
      payload: { lastUpdated: 42 },
    })
    store.append({
      aggregateId: `session:${activeWithCorruptLifecycle}`,
      type: "session.lifecycle.changed",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: activeWithCorruptLifecycle,
      payload: {},
      payloadJson: "{{not-json",
    })
    store.append({
      aggregateId: `session:${inactiveWithUnreadableLifecycle}`,
      type: "session.lifecycle.changed",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: inactiveWithUnreadableLifecycle,
      payload: { lifecycleState: "active", lastUpdated: 42 },
    })
    store.append({
      aggregateId: `session:${inactiveWithCorruptLifecycle}`,
      type: "session.lifecycle.changed",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: inactiveWithCorruptLifecycle,
      payload: {},
      payloadJson: "{{not-json",
    })
    store.append({
      aggregateId: "session:unreadable-creation",
      type: "session.created",
      version: 4,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "unreadable-creation",
      payload: {},
    })

    const result = await manager.listActive()

    expect(result.sessions.map((session) => session.id)).toEqual([
      activeWithUnreadableDeletion,
      activeWithCorruptLifecycle,
    ])
    expect(result.sessions[1]).toMatchObject({ degraded: true, unavailableFields: ["metadata"] })
    expect(result.errors.map((error) => error.sessionId).sort()).toEqual([
      activeWithCorruptLifecycle,
      inactiveWithCorruptLifecycle,
      "unreadable-creation",
    ].sort())
  })

  it("lists a subagent as a conversation-backed catalog row without workflow enrichment", async () => {
    const baseDir = makeTmpDir()
    const { deps } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const parentId = await manager.createChat({ name: "Parent" })
    const childId = manager.allocateId()
    const conversationId = manager.allocateId()
    await manager.publishSubagent({
      id: childId,
      conversationId,
      description: "Child",
      launchedFrom: { parentSessionId: parentId, toolUseId: "tool-1" },
      initialRoles: {},
      runBinding: {
        aggregateId: `session:${childId}`,
        type: "subagent.run.bound",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: childId,
        payload: { runId: "run-1" },
      },
      assignment: "inspect",
      promptFact: {
        aggregateId: `session:${childId}`,
        type: "subagent.prompted",
        version: 3,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: childId,
        payload: { childRunId: "run-1", prompt: "inspect", task: "inspect", toolNames: [] },
      },
    })

    expect((await manager.listForIds([childId])).sessions).toEqual([
      expect.objectContaining({
        id: childId,
        kind: "subagent",
        command: "subagent",
        conversationId,
        parentSessionId: parentId,
      }),
    ])
  })

  it("session_metadata historical versions list with a resolved catalog execution directory", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    store.appendBatch(historicalSessionCreatedFacts("legacy-list"))

    const result = await createSessionManager(deps).listForIds(["legacy-list-1", "legacy-list-2"])

    expect(result.sessions.map((session) => session.id).sort()).toEqual(["legacy-list-1", "legacy-list-2"])
    expect(result.sessions.every((session) => session.executionCwd === baseDir)).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("keeps v1 and v2 executionCwd absent and preserves creation bytes through narrow metadata deltas and restart", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    store.appendBatch(historicalSessionCreatedFacts("legacy-durable"))
    const manager = createSessionManager(deps)

    for (const version of [1, 2]) {
      const id = `legacy-durable-${version}`
      const before = metadataPayloadBytes(store, id)
      await manager.updateLifecycleState(id, "active")
      await manager.updateChatMetadata(id, { providerConversationId: `provider-thread-${version}` })
      expect((await manager.read(id))?.executionCwd).toBeUndefined()
      expect(metadataPayloadBytes(store, id)[0]).toBe(before[0])

      const restarted = createSessionManager(deps)
      expect((await restarted.read(id))?.executionCwd).toBeUndefined()
      expect(metadataPayloadBytes(store, id)[0]).toBe(before[0])
    }
  })

  it("keeps identity-only executionCwd absent in replayed metadata", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    store.append({ aggregateId: "session:identity-only", sessionId: "identity-only", type: "session.created", version: 3, actor: "flywheel", timestamp: 1, payload: { kind: "chat", command: "chat", conversationId: "identity-conversation", label: "Identity", lastUpdated: "2023-11-14T22:13:20.000Z", lifecycleState: "inactive" } })

    expect((await createSessionManager(deps).read("identity-only"))?.executionCwd).toBeUndefined()
  })

  it("omits corrupt session metadata while listing healthy sessions", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const mgr = createSessionManager(deps)
    const healthyId = await mgr.createChat({ name: "Healthy" })

    store.append({
      aggregateId: "session:broken-session",
      type: "session.created",
      version: 3,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "broken-session",
      payload: {},
    })

    const result = await mgr.listForIds([healthyId])

    expect(result.sessions.map((session) => session.id)).toEqual([healthyId])
    expect(result.errors).toEqual([])
    expect((await mgr.listForIds([healthyId])).sessions).toHaveLength(1)
  })

  it("reports and salvages only requested corrupt metadata", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const requestedId = await manager.createChat({ name: "Requested" })
    await manager.updateLifecycleState(requestedId, "inactive")
    store.append({
      aggregateId: `session:${requestedId}`,
      type: "session.auth.profile.selected",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: requestedId,
      payload: { authProfileId: "work" },
      payloadJson: "{{not-json",
    })
    store.append({
      aggregateId: "session:unrelated-corrupt",
      type: "session.created",
      version: 3,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "unrelated-corrupt",
      payload: {},
    })

    const result = await manager.listForIds([requestedId])

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ sessionId: requestedId, scope: "metadata" })
    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: requestedId,
        degraded: true,
        unavailableFields: ["metadata"],
      }),
    ])
  })

  it("does not read corrupt budget history", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const mgr = createSessionManager(deps)
    const id = await mgr.createChat({ name: "Conversation" })

    store.append({
      aggregateId: `session:${id}`,
      type: "model.turn.completed",
      version: 1,
      timestamp: Date.now(),
      actor: "provider",
      sessionId: id,
      payload: {},
    })

    const result = await mgr.listForIds([id])

    expect(result.sessions.map((session) => session.id)).toEqual([id])
    // Uncomputed stats are absent, never a zero placeholder (sparse-stats contract).
    expect(result.sessions[0]?.totalTokens).toBeUndefined()
    expect(result.errors).toEqual([])
  })

  it("does not read corrupt fork history", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const mgr = createSessionManager(deps)
    const sourceId = await mgr.createChat({ name: "Source" })
    const targetId = await mgr.createChat({ name: "Target" })

    store.append({
      aggregateId: `session:${targetId}`,
      type: "session.forked",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: targetId,
      payload: { sourceSessionId: sourceId },
    })

    const result = await mgr.listForIds([sourceId, targetId])

    expect(result.sessions.map((session) => session.id).sort()).toEqual([sourceId, targetId].sort())
    expect(result.sessions.find((session) => session.id === targetId)?.fork).toBeUndefined()
    expect(result.errors).toEqual([])
  })

  it("does not read unrelated fork facts for a scoped catalog request", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const mgr = createSessionManager(deps)
    const requestedId = await mgr.createChat({ name: "Requested" })

    store.append({
      aggregateId: "session:unrelated",
      type: "session.forked",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "unrelated",
      payload: {},
    })

    const result = await mgr.listForIds([requestedId])

    expect(result.sessions.map((session) => session.id)).toEqual([requestedId])
    expect(result.errors).toEqual([])
  })

  it("preserves a session when a later metadata decoration is unreadable", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const mgr = createSessionManager(deps)

    store.append({
      aggregateId: "session:broken-session",
      type: "session.created",
      version: 3,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "broken-session",
      payload: { kind: "chat", command: "chat", conversationId: "broken-conversation", label: "Broken", name: "Broken", lastUpdated: new Date().toISOString(), executionCwd: baseDir, lifecycleState: "inactive" },
    })
    store.append({
      aggregateId: "session:broken-session",
      type: "session.label.updated",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "broken-session",
      payload: {},
    })

    const result = await mgr.listForIds(["broken-session"])
    expect(result.errors).toEqual([])
    expect(result.sessions.find((session) => session.id === "broken-session")?.label).toBe("Broken")
  })

})

function metadataPayloadBytes(store: ReturnType<typeof makeDepsWithStore>["store"], sessionId: string): string[] {
  return store.read({ aggregateId: `session:${sessionId}` }).map((event) => JSON.stringify(event.payload))
}
