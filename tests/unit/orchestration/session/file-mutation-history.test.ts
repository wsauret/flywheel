import { describe, expect, it, mock } from "bun:test"
import { join } from "node:path"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventReader } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { fileMutationCompletionFacts, prepareFileMutationOperation, type FileMutationPreparedFact } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { parseFileMutationOperationHeader } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { loadSessionPendingFileMutations as loadSessionPendingFileMutationsAsync, reconcilePendingFileMutations as reconcilePendingFileMutationsAsync } from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { mutationSnapshot } from "./file-mutation-proof-fixture.js"
import { context, mutationFacts, withStore } from "./file-mutation-recovery-fixture.js"

const loadSessionPendingFileMutations = (store: EventReader, sessionId: string, includeHistorical = true) =>
  loadSessionPendingFileMutationsAsync(asAsyncEventReadSurface(store), sessionId, includeHistorical)
const reconcilePendingFileMutations = (options: Omit<Parameters<typeof reconcilePendingFileMutationsAsync>[0], "store"> & { store: EventReader }) =>
  reconcilePendingFileMutationsAsync({ ...options, store: asAsyncEventReadSurface(options.store) })

function historicalPreparation(path: string, mutationId: string): FileMutationPreparedFact {
  return {
    type: "file.mutation.prepared", version: 1, actor: "flywheel",
    payload: {
      mutationId, path, displayPath: path, changeKind: "modified", toolUseId: "historical-tool",
      before: contentEvidence("before"), after: contentEvidence("after"),
    },
  }
}

describe("file mutation history", () => {
  it("folds history once, then reads only new relevant facts without changing earlier pending snapshots", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const settled = historicalPreparation(join(root, "settled"), "settled")
      const pending = historicalPreparation(join(root, "pending"), "pending")
      await writer.record(settled)
      await writer.record(pending)
      for (const fact of fileMutationCompletionFacts(settled, "applied", null)) await writer.record(fact)
      await writer.record({ type: "file.mutation.settled", version: 1, actor: "flywheel", payload: { mutationId: "settled", outcome: "applied" } })
      const initialPosition = store.currentPosition()
      const read = mock(store.read)
      const reader = { ...store, read }

      const initial = await loadSessionPendingFileMutations(reader, sessionId)
      expect(initial.pending).toEqual([pending])
      expect([...initial.changedMutationIds]).toEqual(["settled"])
      expect([...initial.artifactMutationIds]).toEqual(["settled"])
      expect(read.mock.results[0]?.value).toHaveLength(5)
      expect(await loadSessionPendingFileMutations(reader, sessionId)).toEqual(initial)
      expect(read).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenLastCalledWith({
        aggregateId: `session:${sessionId}`,
        types: ["file.mutation.prepared", "file.mutation.settled", "file.changed", "file.artifact.recorded"],
        afterPosition: 0,
        beforePosition: initialPosition + 1,
        limit: 257,
        order: "asc",
      })

      const next = historicalPreparation(join(root, "next"), "next")
      await writer.record(next)
      const nextPosition = store.currentPosition()
      expect((await loadSessionPendingFileMutations(reader, sessionId)).pending).toEqual([pending, next])
      expect(read).toHaveBeenCalledTimes(2)
      expect(read.mock.calls[1]?.[0]?.afterPosition).toBe(initialPosition)
      expect(read.mock.results[1]?.value).toHaveLength(1)
      expect(initial.pending).toEqual([pending])

      const unrelated = store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "unrelated.fact", version: 1, actor: "flywheel", timestamp: Date.now(), payload: {} })
      expect((await loadSessionPendingFileMutations(reader, sessionId)).pending).toEqual([pending, next])
      expect(read).toHaveBeenCalledTimes(3)
      expect(read.mock.calls[2]?.[0]?.afterPosition).toBe(nextPosition)
      expect(read.mock.results[2]?.value).toEqual([])
      // The unrelated fact's range was read once, so a repeat load reads nothing.
      await loadSessionPendingFileMutations(reader, sessionId)
      expect(read).toHaveBeenCalledTimes(3)

      await writer.record({ type: "file.mutation.settled", version: 1, actor: "flywheel", payload: { mutationId: "pending", outcome: "not_applied" } })
      const final = await loadSessionPendingFileMutations(reader, sessionId)
      expect(final.pending).toEqual([next])
      expect([...final.changedMutationIds]).toEqual(["settled"])
      expect([...final.artifactMutationIds]).toEqual(["settled"])
      expect(read.mock.calls[3]?.[0]?.afterPosition).toBe(unrelated.position)
      expect(read.mock.results[3]?.value).toHaveLength(1)
      expect(initial.pending).toEqual([pending])
    })
  })

  it("reads a swapped operation cell with an unchanged fact position and keeps historical exclusion local to each load", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const historical = historicalPreparation(join(root, "history"), "history")
      await writer.record(historical)
      const prepared = await prepareFileMutationOperation(context(writer), ["first", "second"].map(name => ({
        change: { path: join(root, name), displayPath: name, changeKind: "modified", beforeContent: "before", afterContent: "after" },
        evidence: { beforeSnapshot: mutationSnapshot("before") },
      })))
      const position = store.currentPosition()
      const read = mock(store.read)
      const reader = { ...store, read }
      const currentOnly = await loadSessionPendingFileMutations(reader, sessionId, false)
      expect(currentOnly.pending.map(fact => fact.payload.mutationId)).toEqual([prepared[0]!.mutationId])
      expect([...currentOnly.changedMutationIds]).toEqual([])
      expect([...currentOnly.artifactMutationIds]).toEqual([])
      expect(read).not.toHaveBeenCalled()
      const initial = await loadSessionPendingFileMutations(reader, sessionId)
      expect(initial.pending.map(fact => fact.payload.mutationId)).toEqual([prepared[0]!.mutationId, "history"])
      const row = store.readInFlight(sessionId, "file.mutation")[0]!
      const cell = parseFileMutationOperationHeader(row.payload)
      expect(store.swapInFlight(sessionId, "file.mutation", row.key, row.raw, { ...cell, cursor: 1 })).toBe(true)
      expect(store.currentPosition()).toBe(position)

      const next = await loadSessionPendingFileMutations(reader, sessionId)
      expect(next.pending.map(fact => fact.payload.mutationId)).toEqual([prepared[1]!.mutationId, "history"])
      expect(next.operations[0]?.cell.cursor).toBe(1)
      expect(initial.pending.map(fact => fact.payload.mutationId)).toEqual([prepared[0]!.mutationId, "history"])
      expect(read).toHaveBeenCalledTimes(1)
      expect((await loadSessionPendingFileMutations(reader, sessionId, false)).pending).toEqual([next.pending[0]!])
      expect(read).toHaveBeenCalledTimes(1)
    })
  })

  it("retains known-applied change and artifact evidence across loads without recording them twice", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const prepared = historicalPreparation(join(root, "no-longer-present"), "known-applied")
      await writer.record(prepared)
      const initial = await loadSessionPendingFileMutations(store, sessionId)
      for (const fact of fileMutationCompletionFacts(prepared, "applied", null)) await writer.record(fact)
      const knownApplied = await loadSessionPendingFileMutations(store, sessionId)
      expect(knownApplied.pending).toEqual([prepared])
      expect([...knownApplied.changedMutationIds]).toEqual(["known-applied"])
      expect([...knownApplied.artifactMutationIds]).toEqual(["known-applied"])
      expect(await loadSessionPendingFileMutations(store, sessionId)).toEqual(knownApplied)

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store), initial })).toEqual([])
      expect(mutationFacts(store, sessionId).map(fact => fact.type)).toEqual([
        "file.mutation.prepared", "file.changed", "file.artifact.recorded", "file.mutation.settled",
      ])
      const settled = await loadSessionPendingFileMutations(store, sessionId)
      expect(settled.pending).toEqual([])
      expect([...settled.changedMutationIds]).toEqual(["known-applied"])
      expect([...settled.artifactMutationIds]).toEqual(["known-applied"])
      expect(initial.pending).toEqual([prepared])
    })
  })

  it("isolates sessions and sees another SQLite connection's commits", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const otherSessionId = "other-session"
      const otherWriter = createSessionFactWriter({ sessionId: otherSessionId, writer: asAsyncEventWriter(store) })
      const secondStore = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const first = historicalPreparation(join(root, "first"), "same-id")
        const other = historicalPreparation(join(root, "other"), "same-id")
        await writer.record(first)
        const initial = await loadSessionPendingFileMutations(secondStore, sessionId)
        expect(initial.pending).toEqual([first])
        expect((await loadSessionPendingFileMutations(secondStore, otherSessionId)).pending).toEqual([])
        await otherWriter.record(other)
        for (const fact of fileMutationCompletionFacts(other, "applied", null)) await otherWriter.record(fact)
        const otherLoaded = await loadSessionPendingFileMutations(secondStore, otherSessionId)
        expect(otherLoaded.pending).toEqual([other])
        expect([...otherLoaded.changedMutationIds]).toEqual(["same-id"])
        expect([...otherLoaded.artifactMutationIds]).toEqual(["same-id"])
        const firstLoaded = await loadSessionPendingFileMutations(secondStore, sessionId)
        expect(firstLoaded.pending).toEqual([first])
        expect([...firstLoaded.changedMutationIds]).toEqual([])
        expect([...firstLoaded.artifactMutationIds]).toEqual([])
        await writer.record({ type: "file.mutation.settled", version: 1, actor: "flywheel", payload: { mutationId: "same-id", outcome: "not_applied" } })
        expect((await loadSessionPendingFileMutations(secondStore, sessionId)).pending).toEqual([])
        expect((await loadSessionPendingFileMutations(secondStore, otherSessionId)).pending).toEqual([other])
        expect(initial.pending).toEqual([first])
      } finally {
        otherWriter.dispose()
        secondStore.close()
      }
    })
  })

  it("rejects a duplicate preparation in a later batch without poisoning its valid prefix", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const first = historicalPreparation(join(root, "first"), "first")
      await writer.record(first)
      await writer.record({ type: "file.mutation.settled", version: 1, actor: "flywheel", payload: { mutationId: "first", outcome: "not_applied" } })
      const read = mock(store.read)
      const reader = { ...store, read }
      const initial = await loadSessionPendingFileMutations(reader, sessionId)
      const initialPosition = store.currentPosition()
      expect(initial.pending).toEqual([])
      const valid = await writer.record(historicalPreparation(join(root, "valid"), "valid"))
      await writer.record(first)

      await expect(loadSessionPendingFileMutations(reader, sessionId)).rejects.toThrow("Duplicate file mutation preparation: first")
      expect(read.mock.calls[1]?.[0]?.afterPosition).toBe(initialPosition)
      expect(read.mock.results[1]?.value).toHaveLength(2)
      await expect(loadSessionPendingFileMutations(reader, sessionId)).rejects.toThrow("Duplicate file mutation preparation: first")
      expect(read.mock.calls[2]?.[0]?.afterPosition).toBe(valid!.position)
      expect(read.mock.results[2]?.value).toHaveLength(1)
      expect(initial.pending).toEqual([])
    })
  })
})
