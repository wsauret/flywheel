import { afterEach, describe, expect, spyOn, test } from "bun:test"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createFrontendProjection, type SessionChange } from "../../../../src/orchestration/app-service/frontend-projection"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection"
import { createWorkflowDetailReader } from "../../../../src/orchestration/modules/workflows/detail"
import { cleanupTmpRoot, makeTmpDir } from "../session/_session-manager-fixtures"
import { chatEntry, fakeSessionStore, fileChanged } from "./_frontend-projection-fixtures"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"

const ownedStores: EventStore[] = []
afterEach(() => {
  for (const store of ownedStores.splice(0)) store.close()
  cleanupTmpRoot()
})

describe("frontend projection on an agent-launched workflow", () => {
  test("publishWorkflow binds an aggregate without a workflow session or a chat child link", async () => {
    const baseDir = makeTmpDir()
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    ownedStores.push(eventStore)
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: eventStore })
    const parentId = await manager.createChat({ name: "parent chat", executionCwd: baseDir })
    const sessionStore = fakeSessionStore(new Map([[parentId, chatEntry()]]))
    const projection = createFrontendProjection({ projectRoot: baseDir, sessionStore, manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    const workflowId = await manager.publishWorkflow({
      id: manager.allocateId(),
      description: "Implement the thing",
      workflowDefinitionId: "implement-and-review",
      initialRoles: {},
      facts: [],
      launchedFrom: await workflowParentBinding(manager, { parentSessionId: parentId, toolUseId: "launch", workflowDefinitionId: "implement-and-review", description: "Implement the thing" }),
    })
    await Bun.sleep(5)

    expect(batches.flat()).toEqual([])
    expect((await projection.snapshot()).rows.map((row) => row.id)).toEqual([parentId])
    const reader = asAsyncEventReadSurface(eventStore)
    const detail = createSessionDetailProjection({ projectRoot: baseDir, sessionStore, manager, reader, projectionReader: reader })
    expect((await detail.sessionDetail(workflowId)).view).toBeNull()
    expect(await createWorkflowDetailReader({ projectRoot: baseDir, manager, reader })(workflowId)).toMatchObject({ workflowId, title: "Implement the thing", launchedFrom: { parentSessionId: parentId } })
    expect((await manager.read(parentId))?.childSessionIds ?? []).toEqual([])
    await detail.dispose()
    unsubscribe()
  })

  test("SQLite file.changed commits do not make the foreground projection fold summaries", async () => {
    const baseDir = makeTmpDir()
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    ownedStores.push(eventStore)
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: eventStore })
    const changedId = await manager.createChat({ name: "changed", executionCwd: baseDir })
    const stableId = await manager.createChat({ name: "stable", executionCwd: baseDir })
    const sessionStore = fakeSessionStore(new Map([[changedId, chatEntry()], [stableId, chatEntry()]]))
    const projection = createFrontendProjection({ projectRoot: baseDir, sessionStore, manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    const lastUpdated = (await manager.read(changedId))?.lastUpdated
    const listForIds = spyOn(manager, "listForIds")
    const listMetadata = spyOn(manager, "listMetadata")
    try {
      eventStore.append(fileChanged(changedId))
      expect(listForIds).not.toHaveBeenCalled()
      expect(listMetadata).not.toHaveBeenCalled()
      expect(batches).toEqual([])
      await Bun.sleep(5)
      expect(sessionStore.revision(changedId)).toBe(0)
      expect((await manager.read(changedId))?.lastUpdated).toBe(lastUpdated)
      expect(listForIds).not.toHaveBeenCalled()
      expect(listMetadata).not.toHaveBeenCalled()
      expect(batches).toEqual([])
    } finally {
      unsubscribe()
      listForIds.mockRestore()
      listMetadata.mockRestore()
    }
  })
})
