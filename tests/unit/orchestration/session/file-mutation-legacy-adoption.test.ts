import { describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type FactQuery } from "../../../../src/infra/event-store-types.js"
import { loadSessionPendingFileMutations, reconcileWorkspacePendingFileMutations } from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { mutationFacts, prepare, prepareLegacy, withStore } from "./file-mutation-recovery-fixture.js"

describe("legacy file mutation adoption", () => {
  it("leaves the adoption off the migration ledger when its settlement fails beside a reconciled current cell", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "cell-and-legacy.txt")
      writeFileSync(path, "before")
      const current = await prepare(writer, path, "before", "after")
      const { origin, operationId: _operationId, ...content } = current.fact.payload
      if (origin.kind !== "tool_call") throw new Error("expected current tool origin")
      const { kind: _kind, ...toolIdentity } = origin
      await writer.record({ type: "file.mutation.prepared", version: 1, actor: "flywheel", payload: { ...content, ...toolIdentity, mutationId: "legacy-fact" } })
      const base = asAsyncEventWriter(store)
      // A persistence failure must not let the migration retire the historical preparation.
      const recoveryWriter = {
        ...base,
        appendBatchGuarded: async (events: Parameters<typeof base.appendBatchGuarded>[0]) => {
          if (events.some(event => event.type === "file.mutation.settled" && typeof event.payload === "object"
            && event.payload !== null && "mutationId" in event.payload && event.payload.mutationId === "legacy-fact")) {
            throw new Error("legacy settlement failed")
          }
          return await base.appendBatchGuarded(events)
        },
      }
      const reader = asAsyncEventReadSurface(store)

      await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: recoveryWriter })

      expect(store.readInFlight(sessionId, "file.mutation")).toHaveLength(0)
      expect((await loadSessionPendingFileMutations(reader, sessionId)).pending.some(fact => fact.payload.mutationId === "legacy-fact")).toBe(true)
      expect(store.read({ aggregateId: "workspace" })).toEqual([])
    })
  })

  it("rescans the old adoption marker once without duplicating a preparation covered by its own cell", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "old-marker.txt")
      writeFileSync(path, "after")
      await prepareLegacy(writer, path, "before", "after")
      const covered = (await loadSessionPendingFileMutations(asAsyncEventReadSurface(store), sessionId)).pending[0]
      if (!covered || covered.version !== 1) throw new Error("expected legacy cell")
      await writer.record(covered)
      await writer.record({ ...covered, payload: { ...covered.payload, mutationId: "missed-preparation" } })
      store.append({
        aggregateId: "workspace",
        type: "workspace.facts.migrated",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "workspace",
        payload: {
          migrationId: "file-mutation-legacy-pending",
          factTypes: ["file.mutation.prepared", "file.mutation.settled", "file.changed", "file.artifact.recorded"],
          repaired: 2,
        },
      })
      let historicalReads = 0
      const base = asAsyncEventReadSurface(store)
      const reader: AsyncEventStateReadSurface = {
        ...base,
        async readPage(query: FactQuery, upperPosition: number, afterPosition: number, tolerant?: boolean) {
          if (query.types?.includes("file.mutation.prepared")) historicalReads += 1
          return base.readPage(query, upperPosition, afterPosition, tolerant)
        },
      }

      const recovered = await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: asAsyncEventWriter(store) })
      expect(recovered).toEqual([{ sessionId, failures: [] }])
      expect(historicalReads).toBeGreaterThan(0)
      historicalReads = 0
      await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: asAsyncEventWriter(store) })
      await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: asAsyncEventWriter(store) })

      expect(historicalReads).toBe(0)
      const facts = mutationFacts(store, sessionId)
      for (const mutationId of ["legacy-mutation", "missed-preparation"]) {
        expect(facts.filter(fact => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === mutationId)).toHaveLength(1)
        expect(facts.filter(fact => fact.type === "file.mutation.settled" && fact.payload.mutationId === mutationId)).toHaveLength(1)
      }
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect((await loadSessionPendingFileMutations(reader, sessionId)).pending).toEqual([])
      expect(store.read({ aggregateId: "workspace" }).map(fact => fact.payload)).toEqual([
        expect.objectContaining({ migrationId: "file-mutation-legacy-pending" }),
        expect.objectContaining({ migrationId: "file-mutation-legacy-pending:v2" }),
      ])
    })
  })

  it("reads only live cells once the adoption is on the migration ledger", async () => {
    await withStore(async ({ root, store }) => {
      let historicalReads = 0
      const base = asAsyncEventReadSurface(store)
      const reader: AsyncEventStateReadSurface = {
        ...base,
        async readPage(query: FactQuery, upperPosition: number, afterPosition: number, tolerant?: boolean) {
          if (query.types?.includes("file.mutation.prepared")) historicalReads += 1
          return base.readPage(query, upperPosition, afterPosition, tolerant)
        },
      }

      await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: asAsyncEventWriter(store) })
      historicalReads = 0
      await reconcileWorkspacePendingFileMutations({ projectRoot: root, store: reader, writer: asAsyncEventWriter(store) })

      expect(historicalReads).toBe(0)
    })
  })
})
