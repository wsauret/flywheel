import { afterEach, describe, expect, it, mock } from "bun:test"
import { FIXTURE_WORKFLOW_ID } from "../../../helpers/project-definitions.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store.js"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { loadDefinitionLineageFromEvents } from "../../../../src/workflows/definition-provenance-projection.js"
import { hashContent } from "../../../../src/workflows/definition-hash.js"
import { readStoredSession } from "../session/_session-metadata-test-helpers.js"
import { seedModelWorkflowCall } from "./_workflow-progress-fixtures.js"
import { cleanupProjectRoots, trackProjectRoot, trackEventStore, createDeps, fixtureSource, until, createMockSessionStore } from "./_workflow-controller-fixtures.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { modelWorkflowLaunchOrigin } from "../../../../src/orchestration/workflow-host/launch-origin.js"

function origin(parentId: string, conversationId: string) {
  return modelWorkflowLaunchOrigin(parentId, { conversationId, toolUseId: "tool-1", confirmation: { kind: "absent" }, authority: fullAuthority() })
}

function observingWriter(store: EventStore, batches: string[][]): AsyncGuardedEventWriter {
  return {
    ...asAsyncEventWriter(store),
    append: async () => { throw new Error("workflow launch must use appendBatch") },
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => {
      batches.push(events.map((event) => event.type))
      return store.appendBatchGuarded(events)
    },
    pruneSupersededEvents: async (...args) => store.pruneSupersededEvents(...args),
  }
}

afterEach(() => {
  cleanupProjectRoots()
})

// Atomic publish: a crash mid-publish must leave either a fully-linked
// resumable workflow or no published launch at all. Tests use a real
// SessionManager (durable SQLite metadata) and observe disk state so that
// queue projection presence vs absence reflects the published boundary.
describe("startWorkflow atomic publish", () => {
  it("publishes run settings, parent binding, lineage, and queue creation in one SQLite batch", async () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-atomic-transaction-")))
    trackProjectRoot(projectRoot)
    let store: EventStore | undefined
    try {
      const sessionStore = createMockSessionStore()
      store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const parentManager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const parentId = await parentManager.createChat({ name: "Chat", authProfileId: "default" })
      const parent = await parentManager.read(parentId)
      if (parent?.kind !== "chat") throw new Error("expected parent chat")
      await seedModelWorkflowCall({ eventWriter: asAsyncEventWriter(store) }, parentId, "tool-1", "x")
      const batches: string[][] = []
      const writer = observingWriter(store, batches)
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store, writer })
      await manager.listMetadata()
      const result = await createWorkflowController(createDeps({ sessionStore, manager, projectRoot, eventWriter: writer }))
        .startWorkflow({ source: fixtureSource({ projectRoot }, parentId), description: "x", origin: origin(parentId, parent.conversationId) })
      if ("error" in result) throw new Error(result.error)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toEqual(expect.arrayContaining([
        "workflow.run.registered",
        "definition.loaded",
        "definition.hash_recorded",
        "workflow.compiled",
        "context.input.seeded",
        "workflow.control.initialized",
        "queue.created",
      ]))
      const published = batches[0] ?? []
      const compiled = published.indexOf("workflow.compiled")
      const seeded = published.indexOf("context.input.seeded")
      const initialized = published.indexOf("workflow.control.initialized")
      const queued = published.indexOf("queue.created")
      expect(compiled).toBeLessThan(seeded)
      expect(seeded).toBeLessThan(initialized)
      expect(initialized).toBeLessThan(queued)
      const reader = createWorkflowRunReader(asAsyncEventReadSurface(store))
      expect((await readStoredSession(parentId, projectRoot))?.childSessionIds ?? []).toEqual([])
      expect(await reader.read(result.workflowId)).toMatchObject({ launchedFrom: { parentSessionId: parentId }, roleAssignments: expect.any(Object) })
      const catalog = (await manager.listMetadata()).sessions
      expect(catalog.some(({ id }) => id === result.workflowId)).toBe(false)
      expect((await reader.listForParent(parentId)).map(run => run.workflowId)).toEqual([result.workflowId])
      const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), result.workflowId)
      const lineage = loadDefinitionLineageFromEvents(store.read({ aggregateId: `workflow:${result.workflowId}` }))
      expect(queue).not.toBeNull()
      expect(lineage.compiledWorkflow).toMatchObject({
        workflowDefinitionId: FIXTURE_WORKFLOW_ID,
        userRequestArtifactId: "user-request",
        userRequestSha256: hashContent("x").sha256,
      })
      expect(lineage.compiledWorkflow).not.toHaveProperty("userDescription")
      expect(lineage.definitions["workflow:repair"]).toBeDefined()
      expect(lineage.definitions["agent:investigate"]).toBeDefined()
      expect(lineage.definitions["agent:fix"]).toBeDefined()
      expect(lineage.definitions["agent:verify"]).toBeDefined()
      expect(lineage.definitions["skill:root-cause-analysis"]).toBeDefined()
    } finally {
      store?.close()
      // Removal is the shared cleanup's: it closes every tracked store first.
    }
  })

  it("leaves no child aggregate or parent link when the publication transaction fails", async () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-atomic-q-fail-")))
    trackProjectRoot(projectRoot)
    let store: EventStore | undefined
    try {
      const sessionStore = createMockSessionStore()
      store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const parentManager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const parentId = await parentManager.createChat({ name: "Chat", authProfileId: "default" })
      const parent = await parentManager.read(parentId)
      if (parent?.kind !== "chat") throw new Error("expected parent chat")
      await seedModelWorkflowCall({ eventWriter: asAsyncEventWriter(store) }, parentId, "tool-1", "x")
      const batches: string[][] = []
      let childId: string | undefined
      const writer = observingWriter(store, batches)
      writer.appendBatchGuarded = async (events) => {
        batches.push(events.map((event) => event.type))
        childId = events.find(({ type }) => type === "queue.created")?.sessionId
        throw new Error("launch batch boom")
      }
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store, writer })

      const hosts = createMockWorkflowHosts()
      const result = await createWorkflowController(createDeps({ sessionStore, manager, projectRoot, eventWriter: writer, workflowHosts: hosts }))
        .startWorkflow({ source: fixtureSource({ projectRoot }, parentId), description: "x", origin: origin(parentId, parent.conversationId) })

      expect(result).toEqual({ error: "Workflow publish error: launch batch boom" })
      if (!childId) throw new Error("publication did not attempt a child")
      expect(batches).toHaveLength(1)
      expect(store.read({ aggregateId: `session:${childId}` })).toEqual([])
      expect(store.read({ aggregateId: `workflow:${childId}` })).toEqual([])
      expect((await readStoredSession(parentId, projectRoot))?.childSessionIds ?? []).toEqual([])
      expect(hosts._startCalls).toHaveLength(0)
    } finally {
      store?.close()
      // Removal is the shared cleanup's: it closes every tracked store first.
    }
  })

  it("retains the published run and parent binding when the workflow host cannot start", async () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-atomic-start-fail-")))
    trackProjectRoot(projectRoot)
    let store: EventStore | undefined
    try {
      const sessionStore = createMockSessionStore()
      const hosts = createMockWorkflowHosts()
      hosts.start = mock(async (): Promise<string> => { throw new Error("runner boom") })
      const onRunnerError = mock(async () => {})
      store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const parentId = await manager.createChat({ name: "Chat", authProfileId: "default" })
      const parent = await manager.read(parentId)
      if (parent?.kind !== "chat") throw new Error("expected parent chat")
      await seedModelWorkflowCall({ eventWriter: asAsyncEventWriter(store) }, parentId, "tool-1", "x")
      const result = await createWorkflowController(createDeps({ sessionStore, manager, projectRoot, onRunnerError, workflowHosts: hosts })).startWorkflow({ source: fixtureSource({ projectRoot }, parentId), description: "x", origin: origin(parentId, parent.conversationId) })
      if ("error" in result) throw new Error(result.error)
      await until(() => onRunnerError.mock.calls.length > 0, "the start failure")
      expect(onRunnerError).toHaveBeenCalledWith(result.workflowId, "runner boom")
      expect((await readStoredSession(parentId, projectRoot))?.childSessionIds ?? []).toEqual([])
      expect(await createWorkflowRunReader(asAsyncEventReadSurface(store)).read(result.workflowId)).toMatchObject({ launchedFrom: { parentSessionId: parentId } })
      expect(await readStoredSession(result.workflowId, projectRoot)).toBeNull()
      expect(await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), result.workflowId)).not.toBeNull()
    } finally {
      store?.close()
      // Removal is the shared cleanup's: it closes every tracked store first.
    }
  })
})
