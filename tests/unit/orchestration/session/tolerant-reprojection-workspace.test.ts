import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTolerantReprojectionWorkspace, readSessionPayloadBytes, tolerantWorkspaceSessions } from "../../../fixtures/create-tolerant-reprojection-workspace.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { testDirectories } from "../../../helpers/directories.js"
import { createWorkflowDetailReader } from "../../../../src/orchestration/modules/workflows/detail.js"

const tail = { anchor: { kind: "tail" as const }, maxBlocks: 100, maxBytes: 1024 * 1024 }

describe("tolerant reprojection workspace", () => {
  it("prepares one mixed historical workspace without a second transcript authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-tolerant-workspace-"))
    const directories = testDirectories(root)
    const fixture = createTolerantReprojectionWorkspace(directories)
    let store = createSqliteEventStore(fixture.dbFile)
    try {
      const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      const listed = await manager.listMetadata()
      const ids = listed.sessions.map(({ id }) => id)
      expect(ids).toContain(tolerantWorkspaceSessions.legacyV1)
      expect(ids).toContain(tolerantWorkspaceSessions.legacyV2)
      expect(ids).toContain(tolerantWorkspaceSessions.retiredField)
      expect(ids).toContain(tolerantWorkspaceSessions.identityOnly)
      expect(ids).not.toContain(tolerantWorkspaceSessions.invalidJson)
      expect(ids).not.toContain(tolerantWorkspaceSessions.newerVersion)
      expect(ids).not.toContain(tolerantWorkspaceSessions.tombstone)

      for (const id of [tolerantWorkspaceSessions.legacyV1, tolerantWorkspaceSessions.legacyV2, tolerantWorkspaceSessions.retiredField]) {
        const session = await manager.read(id)
        const conversationId = session && "conversationId" in session ? session.conversationId : undefined
        if (!conversationId) throw new Error(`missing ${id} conversation`)
        const tree = await tryOpenConversationTree({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
        if (!tree) throw new Error(`missing ${id} tree`)
        const append = await tree.appendMessages([{ kind: "user", content: `new-${id}` }])
        await tree.getStorage().dispose()
        expect(append.kind).toBe("committed")
      }

      const identityBytes = readSessionPayloadBytes(fixture.dbFile).get(tolerantWorkspaceSessions.identityOnly)
      expect((await manager.read(tolerantWorkspaceSessions.identityOnly))?.executionCwd).toBeUndefined()
      expect(readSessionPayloadBytes(fixture.dbFile).get(tolerantWorkspaceSessions.identityOnly)).toEqual(identityBytes)

      const projection = createSessionDetailProjection({ projectRoot: root, sessionStore: { get: () => undefined }, manager, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store) })
      for (const id of [tolerantWorkspaceSessions.legacyV1, tolerantWorkspaceSessions.legacyV2, tolerantWorkspaceSessions.retiredField]) {
        const range = await projection.outputRange(id, tail)
        expect(range.kind).toBe("ok")
        if (range.kind === "ok") expect(range.blocks.some((block) => block.kind === "userMessage" && block.content === `new-${id}`)).toBe(true)
      }
      const beforeRestart = await projection.outputRange(tolerantWorkspaceSessions.legacyV1, tail)
      expect((await projection.sessionDetail(tolerantWorkspaceSessions.strictWorkflow)).view).toBeNull()
      const workflowDetail = await createWorkflowDetailReader({ reader: asAsyncEventReadSurface(store), projectRoot: root, manager })(tolerantWorkspaceSessions.strictWorkflow)
      expect(workflowDetail).toMatchObject({ readability: "unavailable" })
      expect(workflowDetail?.admittedActions).not.toContain("workflow.resume")
      const degraded = await projection.outputRange(tolerantWorkspaceSessions.malformedTree, tail)
      expect(degraded.kind).toBe("ok")
      if (degraded.kind === "ok") {
        expect(degraded.blocks.at(-1)).toMatchObject({ kind: "degraded", notice: "Part of this transcript could not be displayed." })
        expect(JSON.stringify(degraded.blocks)).not.toContain("orphan")
      }
      await projection.dispose()
      store.close()
      store = createSqliteEventStore(fixture.dbFile)
      const reopenedManager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      const reopenedProjection = createSessionDetailProjection({ projectRoot: root, sessionStore: { get: () => undefined }, manager: reopenedManager, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store) })
      expect(await reopenedProjection.outputRange(tolerantWorkspaceSessions.legacyV1, tail)).toEqual(beforeRestart)
      expect((await reopenedManager.read(tolerantWorkspaceSessions.legacyV1))?.executionCwd).toBeUndefined()
      await reopenedProjection.dispose()

      const after = readSessionPayloadBytes(fixture.dbFile)
      expect(after.get(tolerantWorkspaceSessions.newerVersion)).toEqual(fixture.beforeBytes.get(tolerantWorkspaceSessions.newerVersion))
      expect(after.get(tolerantWorkspaceSessions.tombstone)).toEqual(fixture.beforeBytes.get(tolerantWorkspaceSessions.tombstone))
      // ARCH-SUBSTRATE-013: unreadable session bytes are never retired, deleted, or replaced.
      expect(after.get(tolerantWorkspaceSessions.invalidJson)).toEqual([Buffer.from("{{invalid-json").toString("hex").toUpperCase()])
      expect(after.get(tolerantWorkspaceSessions.invalidJson)).toEqual(fixture.beforeBytes.get(tolerantWorkspaceSessions.invalidJson))
      expect(after.get(tolerantWorkspaceSessions.legacyV1)?.[0]).toBe(fixture.beforeBytes.get(tolerantWorkspaceSessions.legacyV1)?.[0])
      expect(after.get(tolerantWorkspaceSessions.identityOnly)).toEqual(identityBytes)
      expect(store.read({ aggregateId: `session:${tolerantWorkspaceSessions.legacyV1}`, types: ["output.log.indexed", "output.block.indexed", "output.chunk.recorded"] })).toHaveLength(0)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
