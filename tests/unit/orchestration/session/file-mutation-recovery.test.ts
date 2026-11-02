import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type EventReader } from "../../../../src/infra/event-store-types.js"
import {
  prepareFileMutationOperation,
  settleFileMutation,
} from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { parseFileMutationFact } from "../../../../src/orchestration/session/file-mutation-facts.js"
import {
  loadSessionPendingFileMutations as loadSessionPendingFileMutationsAsync,
  reconcilePendingFileMutations as reconcilePendingFileMutationsAsync,
  reconcileWorkspacePendingFileMutations as reconcileWorkspacePendingFileMutationsAsync,
} from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { parseFileMutationOperationCell, snapshotToFileObjectProof } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { mutationSnapshot } from "./file-mutation-proof-fixture.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import {
  context,
  mutationFacts,
  prepare,
  prepareAdd,
  prepareBatch,
  prepareDelete,
  prepareMove,
  prepareLegacy,
  readBackProof,
  publishReplacement,
  withStore,
} from "./file-mutation-recovery-fixture.js"

type RecoveryReader = EventReader | AsyncEventStateReadSurface
const recoveryReader = (store: RecoveryReader): AsyncEventStateReadSurface =>
  "readSlice" in store ? store : asAsyncEventReadSurface(store)
const loadSessionPendingFileMutations = (store: RecoveryReader, sessionId: string, includeHistorical = true) =>
  loadSessionPendingFileMutationsAsync(recoveryReader(store), sessionId, includeHistorical)
const reconcilePendingFileMutations = (options: Omit<Parameters<typeof reconcilePendingFileMutationsAsync>[0], "store"> & { store: RecoveryReader }) =>
  reconcilePendingFileMutationsAsync({ ...options, store: recoveryReader(options.store) })
const reconcileWorkspacePendingFileMutations = (options: Omit<Parameters<typeof reconcileWorkspacePendingFileMutationsAsync>[0], "store"> & { store: RecoveryReader }) =>
  reconcileWorkspacePendingFileMutationsAsync({ ...options, store: recoveryReader(options.store) })

describe("file mutation recovery", () => {
  it("awaits asynchronous in-flight and sequence reads before recovery writes", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "async-recovery.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      const base = asAsyncEventReadSurface(store)
      const reader: AsyncEventStateReadSurface = {
        ...base,
        async readInFlight(targetSessionId, kind) {
          await Promise.resolve()
          return base.readInFlight(targetSessionId, kind)
        },
        async aggregateSeq(aggregateId) {
          await Promise.resolve()
          return base.aggregateSeq(aggregateId)
        },
      }

      expect(await reconcilePendingFileMutations({ sessionId, store: reader, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("exposes unreadable cell keys without interpreting malformed paths", async () => {
    await withStore(async ({ store, sessionId }) => {
      const payload = { path: "not-a-trusted-location", version: 200 }
      store.putInFlight(sessionId, "file.mutation", "unreadable", payload)
      const loaded = await loadSessionPendingFileMutations(store, sessionId, false)
      expect(loaded.pending).toEqual([])
      expect(loaded.unreadableCells).toEqual([{ key: "unreadable", reason: expect.any(String) }])
      expect(store.readInFlight(sessionId, "file.mutation")[0]?.payload).toEqual(payload)
    })
  })
  it("keeps legacy recovered changes readable without inventing endpoint access", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "legacy-published")
      writeFileSync(path, "after")
      await prepareLegacy(writer, path, "before", "after")
      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      const changed = mutationFacts(store, sessionId).find(fact => fact.type === "file.changed")
      expect(changed).toMatchObject({ version: 2, payload: { mutationId: "legacy-mutation" } })
      expect(changed?.payload).not.toHaveProperty("beforeAccess")
      expect(changed?.payload).not.toHaveProperty("afterAccess")
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("reads v1, v2 and v3 operation cells and historical prepared facts together", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "old-and-new.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      const current = (await loadSessionPendingFileMutations(store, sessionId)).operations[0]!.cell
      const item = current.items[0]!
      if (!("origin" in item.evidence) || item.evidence.origin.kind !== "tool_call") throw new Error("expected current tool origin")
      const { origin, operationId: _operationId, ...content } = item.evidence
      const { kind: _kind, ...toolIdentity } = origin
      const legacyPayload = { ...content, mutationId: "legacy-cell", ...toolIdentity }
      const legacyCell = { ...current, version: 1 as const, operationId: "old-operation", items: [{ ...item, candidateEvidence: undefined, evidence: legacyPayload }] }
      store.putInFlight(sessionId, "file.mutation", "old-operation", legacyCell)
      const oldDiff = { version: 1 as const, files: [{ path: "old-and-new.txt", change: "modified" as const, unifiedDiff: "--- old-and-new.txt\n+++ old-and-new.txt\n@@ -1 +1 @@\n-before\n+after\n" }], omissions: [] }
      const v2Cell = { ...current, version: 2 as const, operationId: "v2-operation", items: [{ ...item, candidateEvidence: undefined, evidence: { ...item.evidence, mutationId: "v2-cell" }, mutationDiff: oldDiff }] }
      store.putInFlight(sessionId, "file.mutation", "v2-operation", v2Cell)
      expect(parseFileMutationOperationCell(v2Cell).items[0]?.mutationDiff).toEqual(oldDiff)
      const historical = { type: "file.mutation.prepared" as const, version: 1 as const, actor: "flywheel" as const, payload: { ...legacyPayload, mutationId: "old-fact" } }
      await writer.record(historical)
      const loaded = await loadSessionPendingFileMutations(store, sessionId)
      expect(loaded.operations.map(operation => operation.cell.version).sort()).toEqual([1, 2, 3])
      expect(loaded.unreadableCells).toEqual([])
      expect(loaded.pending.map(fact => fact.payload.mutationId).sort()).toEqual([content.mutationId, "legacy-cell", "v2-cell", "old-fact"].sort())
      expect(parseFileMutationOperationCell(legacyCell)).toEqual(legacyCell)
      const missingProofCell = { ...legacyCell, items: [{ ...legacyCell.items[0]!, precondition: null, postcondition: null }] }
      expect(parseFileMutationOperationCell(missingProofCell)).toEqual(missingProofCell)
      expect(parseFileMutationFact({ ...historical, type: "file.changed", version: 2 })).toMatchObject({ version: 2, payload: { toolUseId: "tool-call" } })
      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("round trips per-item operator origins and atomically completes runtime diffs", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const origin = { kind: "user_undo" as const, reviewRevision: 4, scope: "lastTurn" as const, fileId: "a", sourceMutationIds: ["source-a"] }
      const secondOrigin = { ...origin, fileId: "b", sourceMutationIds: ["source-b", "source-c"] }
      const operationContext = { sessionEventWriter: writer, origin }
      const [first, second] = await prepareFileMutationOperation(operationContext, [
        { change: { path: join(root, "a"), displayPath: "a", changeKind: "modified", beforeContent: "new\n", afterContent: "old\n" }, evidence: { beforeSnapshot: mutationSnapshot("new\n") } },
        { origin: secondOrigin, change: { path: join(root, "b"), displayPath: "b", changeKind: "deleted", beforeContent: "new\n", afterContent: null }, evidence: { beforeSnapshot: mutationSnapshot("new\n") } },
      ])
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending[0]).toMatchObject({ version: 2, payload: { origin } })
      expect(store.readInFlight(sessionId, "file.mutation")[0]?.key).toBe(first!.operationId)
      await settleFileMutation(operationContext, first!, snapshotToFileObjectProof(mutationSnapshot("old\n")))
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending[0]).toMatchObject({ version: 2, payload: { origin: secondOrigin } })
      await settleFileMutation(operationContext, second!, { kind: "absent" })
      const facts = mutationFacts(store, sessionId)
      expect(facts.map(fact => fact.type)).toEqual(["file.changed", "file.artifact.recorded", "file.changed", "file.artifact.recorded"])
      expect(facts[1]).toMatchObject({ version: 4, payload: { ownerKind: "runtime", ownerId: first!.operationId, mutationId: first!.mutationId, artifactKind: "mutation_diff" } })
      expect(facts[3]).toMatchObject({ payload: { evidence: { displayPath: "b", change: "removed" } } })
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect(facts.every(fact => !("toolUseId" in fact.payload))).toBe(true)
    })
  })

  it.each(["generation", "cursor"] as const)("rolls back both operator change and diff when the %s CAS fails", async stale => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const origin = { kind: "user_undo" as const, reviewRevision: 4, scope: "session" as const, fileId: "a", sourceMutationIds: ["source-a"] }
      const operationContext = { sessionEventWriter: writer, origin }
      const plans = [0, 1].map(index => ({
        change: { path: join(root, `a-${index}`), displayPath: `a-${index}`, changeKind: "modified" as const, beforeContent: "new\n", afterContent: "old\n" },
        evidence: { beforeSnapshot: mutationSnapshot("new\n") },
      }))
      const prepared = (await prepareFileMutationOperation(operationContext, plans))[0]!
      const original = store.readInFlight(sessionId, "file.mutation")[0]!
      let beforeFacts = mutationFacts(store, sessionId)
      if (stale === "generation") {
        store.dropInFlight(sessionId, "file.mutation", original.key)
        // Tool call ids can be reused by Bash rebase rounds with a different plan.
        const replacement = await prepareFileMutationOperation({ ...operationContext, origin: { kind: "tool_call", toolUseId: prepared.operationId } }, plans)
        expect(replacement[0]!.state.header!.plan.root).not.toBe(prepared.state.header!.plan.root)
      } else {
        const duplicate = { ...prepared, state: { ...prepared.state } }
        await settleFileMutation(operationContext, duplicate, snapshotToFileObjectProof(mutationSnapshot("old\n")))
        beforeFacts = mutationFacts(store, sessionId)
      }
      const winner = store.readInFlight(sessionId, "file.mutation")[0]!
      await expect(settleFileMutation(operationContext, prepared, snapshotToFileObjectProof(mutationSnapshot("old\n")))).rejects.toThrow()
      expect(mutationFacts(store, sessionId)).toEqual(beforeFacts)
      expect(store.readInFlight(sessionId, "file.mutation")[0]?.raw).toBe(winner.raw)
    })
  })

  it.each(["missing", "corrupt"] as const)("keeps a header with a %s immutable plan and reports a typed recovery failure", async failure => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "pending")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      const original = store.readInFlight(sessionId, "file.mutation")[0]!
      const reader = { ...asAsyncEventReadSurface(store), readSessionContentNode: async () => failure === "missing" ? null : { version: 1, kind: "records", records: ["corrupt"] } }
      const failures = await reconcilePendingFileMutations({ sessionId, store: reader, writer: asAsyncEventWriter(store) })
      expect(failures).toHaveLength(1)
      expect(failures[0]?.name).toBe("FileMutationRecoveryError")
      expect(failures[0]?.message).toContain("Its recovery record was kept; no remaining files were published.")
      expect(store.readInFlight(sessionId, "file.mutation")[0]?.raw).toBe(original.raw)
      expect(mutationFacts(store, sessionId)).toEqual([])
    })
  })

  it("settles a preparation as not applied when publication never happened", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "not-applied.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])

      const facts = mutationFacts(store, sessionId)
      expect(facts.filter((fact) => fact.type === "file.changed")).toHaveLength(0)
      expect(facts.filter((fact) => fact.type === "file.mutation.settled").map((fact) => fact.payload)).toEqual([
        expect.objectContaining({ outcome: "not_applied" }),
      ])
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toHaveLength(0)
    })
  })

  it("settles matching post-bytes as indeterminate without publication-specific actor proof", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "published.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      publishReplacement(path, "after")

      const failures = await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })
      expect(failures).toEqual([])

      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: expect.any(String), outcome: "indeterminate" } }),
      ])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("does not duplicate a mutation settled before the caller returned", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "settled.txt")
      writeFileSync(path, "before")
      const prepared = await prepare(writer, path, "before", "after")
      writeFileSync(path, "after")
      await settleFileMutation(context(writer), prepared, readBackProof(path))

      await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })

      const facts = mutationFacts(store, sessionId)
      expect(facts.filter((fact) => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === prepared.mutationId)).toHaveLength(1)
      expect(facts.filter((fact) => fact.type === "file.artifact.recorded" && "mutationId" in fact.payload && fact.payload.mutationId === prepared.mutationId)).toHaveLength(1)
    })
  })

  it("keeps identical content mutations distinct by mutation ID", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "same.txt")
      writeFileSync(path, "same")
      const first = await prepare(writer, path, "same", "same")
      await settleFileMutation(context(writer), first, readBackProof(path))
      const second = await prepare(writer, path, "same", "same")
      await settleFileMutation(context(writer), second, readBackProof(path))

      const changed = mutationFacts(store, sessionId).filter((fact) => fact.type === "file.changed")
      expect(first.mutationId).not.toBe(second.mutationId)
      expect(changed.map((fact) => "mutationId" in fact.payload ? fact.payload.mutationId : undefined)).toEqual([first.mutationId, second.mutationId])
    })
  })

  it("keeps one operation cell and advances its exact settled prefix", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const firstPath = join(root, "first.txt")
      const secondPath = join(root, "second.txt")
      writeFileSync(firstPath, "before")
      writeFileSync(secondPath, "before")
      const [first, second] = await prepareBatch(writer, [
        { path: firstPath, beforeContent: "before", afterContent: "after" },
        { path: secondPath, beforeContent: "before", afterContent: "after" },
      ])
      if (!first || !second) throw new Error("expected two prepared mutations")

      expect(store.readInFlight(sessionId, "file.mutation")).toHaveLength(1)
      publishReplacement(firstPath, "after")
      await settleFileMutation(context(writer), first, readBackProof(firstPath))
      const advanced = await loadSessionPendingFileMutations(store, sessionId)
      expect(advanced.pending.map((fact) => fact.payload.mutationId)).toEqual([second.mutationId])
      expect(advanced.operations[0]?.cell.cursor).toBe(1)

      publishReplacement(secondPath, "after")
      await settleFileMutation(context(writer), second, readBackProof(secondPath))
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("records omitted access as an intentional add postcondition boundary", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "windows-add.txt")
      await prepareAdd(writer, path, "after")

      const cell = (await loadSessionPendingFileMutations(store, sessionId)).operations[0]!.cell
      expect(cell.items[0]?.postcondition).toEqual({
        kind: "file",
        bytes: 5,
        sha256: "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
        identity: { kind: "new", replaced: null },
        linkCount: 1,
        executable: false,
        access: null,
      })
    })
  })

  it("strictly parses nullable postcondition access without weakening preconditions", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "strict-access.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      const cell = (await loadSessionPendingFileMutations(store, sessionId)).operations[0]!.cell
      const item = cell.items[0]!
      if (item.precondition?.kind !== "file" || item.postcondition?.kind !== "file") throw new Error("Expected file proofs")

      expect(() => parseFileMutationOperationCell({
        ...cell,
        items: [{ ...item, precondition: { ...item.precondition, access: null } }],
      })).toThrow("Invalid file access proof")
      const { access: _access, ...postconditionWithoutAccess } = item.postcondition
      expect(() => parseFileMutationOperationCell({
        ...cell,
        items: [{ ...item, postcondition: postconditionWithoutAccess }],
      })).toThrow("Invalid file access proof")
      expect(parseFileMutationOperationCell({
        ...cell,
        items: [{ ...item, postcondition: { ...item.postcondition, access: null } }],
      }).items[0]?.postcondition).toEqual({ ...item.postcondition, access: null })
    })
  })

  it("settles a matching add as indeterminate without publication-specific actor proof", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "recovered-windows-add.txt")
      await prepareAdd(writer, path, "after")
      writeFileSync(path, "after")

      const failures = await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })
      expect(failures).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: expect.any(String), outcome: "indeterminate" } }),
      ])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("settles an absent nested add as indeterminate when publication may have created parents", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "missing", "nested.txt")
      const authority = RetainedFileEditAuthority.admitWritable(path)
      try {
        const [prepared] = await prepareFileMutationOperation(context(writer), [{
          change: { path, displayPath: path, changeKind: "created", beforeContent: null, afterContent: "after" },
          evidence: { beforeSnapshot: null, mayCreateMissingParents: authority.mayCreateMissingParents },
        }])
        if (!prepared) throw new Error("expected prepared add")
      } finally {
        authority.close()
      }

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: expect.any(String), outcome: "indeterminate" } }),
      ])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("settles changed access as indeterminate for an existing Windows-style update", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "changed-dacl.txt")
      writeFileSync(path, "before")
      const authority = RetainedFileEditAuthority.admit(path)
      try {
        await prepareFileMutationOperation(context(writer), [{
          change: {
            path,
            displayPath: path,
            changeKind: "modified",
            beforeContent: "before",
            afterContent: "after",
          },
          evidence: {
            beforeSnapshot: authority.existingSnapshot(),
            postconditionAccess: { kind: "win32", dacl: Buffer.from("expected-dacl") },
          },
        }])
      } finally {
        authority.close()
      }
      publishReplacement(path, "after")

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: expect.any(String), outcome: "indeterminate" } }),
      ])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("settles a move destination as indeterminate without publication-specific actor proof", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const move = await prepareMove(root, writer)
      move.destination.publish(move.sourceSnapshot.content, move.sourceSnapshot.metadata)
      move.destination.readBackAndVerify(move.sourceSnapshot.content, move.sourceSnapshot.metadata)
      move.source.close()
      move.destination.close()

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: move.destinationMutation.mutationId, outcome: "indeterminate" } }),
      ])
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toEqual([])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("recovers an unsettled move source deletion after destination settlement", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const move = await prepareMove(root, writer)
      move.destination.publish(move.sourceSnapshot.content, move.sourceSnapshot.metadata)
      const after = move.destination.readBackAndVerify(move.sourceSnapshot.content, move.sourceSnapshot.metadata)
      await settleFileMutation(context(writer), move.destinationMutation, snapshotToFileObjectProof(after))
      move.source.close()
      move.destination.close()

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])

      const facts = mutationFacts(store, sessionId)
      expect(facts.filter((fact) => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === move.destinationMutation.mutationId)).toHaveLength(1)
      expect(facts.filter((fact) => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === move.sourceMutation.mutationId)).toHaveLength(0)
      expect(facts.flatMap((fact) => fact.type === "file.mutation.settled" && fact.payload.mutationId === move.sourceMutation.mutationId ? [fact.payload.outcome] : [])).toEqual(["not_applied"])
      expect(existsSync(move.source.canonicalPath)).toBe(true)
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toHaveLength(0)
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("settles ambiguous current bytes as indeterminate without inventing publication evidence", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "moved-on.txt")
      writeFileSync(path, "before")
      const prepared = await prepare(writer, path, "before", "after")
      writeFileSync(path, "later and larger")

      const failures = await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })

      const facts = mutationFacts(store, sessionId)
      expect(failures).toEqual([])
      expect(facts.filter((fact) => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === prepared.mutationId)).toHaveLength(0)
      expect(facts.filter((fact) => fact.type === "file.artifact.recorded" && "mutationId" in fact.payload && fact.payload.mutationId === prepared.mutationId)).toHaveLength(0)
      expect(facts.filter((fact) => fact.type === "file.mutation.settled")).toEqual([
        expect.objectContaining({ payload: { mutationId: prepared.mutationId, outcome: "indeterminate" } }),
      ])
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("leaves a symlink target unresolved without reading it", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const target = join(root, "target.txt")
      const link = join(root, "link.txt")
      writeFileSync(target, "before")
      symlinkSync(target, link)
      await prepareLegacy(writer, link, "before", "after")

      const failures = await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })

      expect(failures).toHaveLength(1)
      expect(failures[0]?.message).toContain("Cannot safely reconcile")
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toHaveLength(1)
    })
  })

  it.skipIf(process.platform === "win32")("leaves a target below a symlinked ancestor unresolved", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const outside = join(root, "outside")
      const linkedDirectory = join(root, "linked")
      mkdirSync(outside)
      writeFileSync(join(outside, "target.txt"), "before")
      symlinkSync(outside, linkedDirectory, "dir")
      await prepare(writer, join(linkedDirectory, "target.txt"), "before", "after")

      const failures = await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })

      expect(failures).toHaveLength(1)
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toHaveLength(1)
    })
  })

  it("recovers pending dead sessions in deterministic workspace order and excludes live owners", async () => {
    await withStore(async ({ root, store }) => {
      const deadWriter = createSessionFactWriter({ sessionId: "a-dead", writer: asAsyncEventWriter(store) })
      const liveWriter = createSessionFactWriter({ sessionId: "z-live", writer: asAsyncEventWriter(store) })
      const deadPath = join(root, "dead.txt")
      const livePath = join(root, "live.txt")
      writeFileSync(deadPath, "before")
      writeFileSync(livePath, "before")
      await prepare(deadWriter, deadPath, "before", "after")
      await prepare(liveWriter, livePath, "before", "after")
      publishReplacement(deadPath, "after")
      publishReplacement(livePath, "after")
      const ownerPath = join(root, ".flywheel", "sessions", "z-live", "owner.pid")
      mkdirSync(dirname(ownerPath), { recursive: true })
      writeFileSync(ownerPath, String(process.pid))

      const result = await reconcileWorkspacePendingFileMutations({ projectRoot: root, store, writer: asAsyncEventWriter(store) })

      expect(result.map(({ sessionId }) => sessionId)).toEqual(["a-dead"])
      expect(result[0]?.failures).toEqual([])
      expect((await loadSessionPendingFileMutations(store, "a-dead")).pending).toEqual([])
      expect((await loadSessionPendingFileMutations(store, "z-live")).pending).toHaveLength(1)
      deadWriter.dispose()
      liveWriter.dispose()
    })
  })

  it("uses the guarded session sequence to prevent concurrent duplicates", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "concurrent.txt")
      writeFileSync(path, "before")
      const prepared = await prepare(writer, path, "before", "after")
      publishReplacement(path, "after")

      await Promise.all([
        reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) }),
        reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) }),
      ])

      const facts = mutationFacts(store, sessionId)
      expect(facts.filter((fact) => fact.type === "file.changed" && "mutationId" in fact.payload && fact.payload.mutationId === prepared.mutationId)).toHaveLength(0)
      expect(facts.filter((fact) => fact.type === "file.mutation.settled")).toEqual([
        expect.objectContaining({ payload: { mutationId: prepared.mutationId, outcome: "indeterminate" } }),
      ])
      expect((await loadSessionPendingFileMutations(store, sessionId)).pending).toEqual([])
    })
  })

  it("settles an absent deletion as indeterminate without publication-specific actor proof", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "deleted.txt")
      writeFileSync(path, "before")
      await prepareDelete(writer, path, "before")
      rmSync(path)

      expect(await reconcilePendingFileMutations({ sessionId, store, writer: asAsyncEventWriter(store) })).toEqual([])
      expect(mutationFacts(store, sessionId)).toEqual([
        expect.objectContaining({ type: "file.mutation.settled", payload: { mutationId: expect.any(String), outcome: "indeterminate" } }),
      ])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    })
  })

  it("replays historical version 1 file.changed facts", async () => {
    await withStore(async ({ store, sessionId }) => {
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "file.changed",
        version: 1,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: {
          path: "/historical.txt",
          displayPath: "historical.txt",
          changeKind: "modified",
          before: null,
          after: { bytes: 3, sha256: "a".repeat(64), preview: "old" },
          toolUseId: "legacy-tool",
        },
      })

      const changed = mutationFacts(store, sessionId).filter((fact) => fact.type === "file.changed")
      expect(changed).toHaveLength(1)
      expect(changed[0] && "mutationId" in changed[0].payload).toBe(false)
    })
  })

  it("skips an unreadable in-flight cell instead of failing the whole load", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const path = join(root, "readable.txt")
      writeFileSync(path, "before")
      await prepare(writer, path, "before", "after")
      // A cell this binary cannot decode: coerced-to-empty corruption, or a
      // shape a newer binary wrote. One bad row must not brick activation.
      store.putInFlight(sessionId, "file.mutation", "corrupt-cell", { unexpected: "shape" })

      const projection = await loadSessionPendingFileMutations(store, sessionId)

      expect(projection.pending).toHaveLength(1)
      expect(projection.pending[0]?.payload.path).toBe(path)
      // The unreadable row stays for a binary that can read it.
      expect(store.readInFlight(sessionId, "file.mutation")).toHaveLength(2)
    })
  })

  it("never reconciles a tombstoned session's pending preparations", async () => {
    await withStore(async ({ root, store }) => {
      const deadWriter = createSessionFactWriter({ sessionId: "tombstoned", writer: asAsyncEventWriter(store) })
      const path = join(root, "tombstoned.txt")
      writeFileSync(path, "before")
      await prepare(deadWriter, path, "before", "after")
      store.append({
        aggregateId: "session:tombstoned",
        type: "session.deleted",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "tombstoned",
        payload: { lastUpdated: new Date().toISOString() },
      })

      const result = await reconcileWorkspacePendingFileMutations({ projectRoot: root, store, writer: asAsyncEventWriter(store) })

      // A deleted session's retained rows are deletion's remainder, not work:
      // reconciling would append fresh facts to the dead aggregate.
      expect(result).toEqual([])
      deadWriter.dispose()
    })
  })

  it("decodes historical and current settlement outcomes", () => {
    const settlement = (outcome: "attributed_after_later_mutation" | "indeterminate") => {
      const fact = parseFileMutationFact({
        type: "file.mutation.settled",
        version: 1,
        actor: "flywheel",
        payload: { mutationId: "mutation", outcome },
      })
      if (fact.type !== "file.mutation.settled") throw new Error("Expected settlement fact")
      return fact.payload.outcome
    }

    expect(settlement("attributed_after_later_mutation")).toBe("attributed_after_later_mutation")
    expect(settlement("indeterminate")).toBe("indeterminate")
  })
})
