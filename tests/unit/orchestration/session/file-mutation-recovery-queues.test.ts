import { describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { withMutationQueueKeys } from "../../../../src/infra/file-mutation-queue.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { stageFileMutationOperation, snapshotToFileObjectProof } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { loadSessionPendingFileMutations, reconcilePendingFileMutations } from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { createDeferred } from "../../../fixtures/runtime-supervisor-fixtures.js"
import {
  mutationFacts,
  prepare,
  prepareBatch,
  withStore,
} from "./file-mutation-recovery-fixture.js"

describe("file mutation recovery queues", () => {
  it("holds suffix queues until the current item's guarded retirement commits", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const a = join(root, "a")
      const b = join(root, "b")
      for (const path of [a, b]) writeFileSync(path, "before")
      const [first] = await prepareBatch(writer, [a, b].map(path => ({ path, beforeContent: "before", afterContent: "after" })))
      const base = asAsyncEventWriter(store)
      let suffixAcquired = false
      let suffixAcquiredBeforeCommit = false
      let suffix: Promise<void> | undefined
      expect(await reconcilePendingFileMutations({
        sessionId,
        store: asAsyncEventReadSurface(store),
        writer: {
          appendBatch: base.appendBatch,
          appendBatchGuarded: async events => {
            suffix = withMutationQueueKeys([b], async () => { suffixAcquired = true })
            const result = await base.appendBatchGuarded(events)
            suffixAcquiredBeforeCommit = suffixAcquired
            return result
          },
        },
      })).toEqual([])
      await suffix
      expect(suffixAcquiredBeforeCommit).toBe(false)
      expect(suffixAcquired).toBe(true)
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect(mutationFacts(store, sessionId)).toMatchObject([{ type: "file.mutation.settled", payload: { mutationId: first!.mutationId, outcome: "not_applied" } }])
    })
  })

  it("waits for every unretired target and rereads the filesystem inside the queues", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const a = join(root, "a")
      const b = join(root, "b")
      for (const path of [a, b]) writeFileSync(path, "before")
      await prepareBatch(writer, [a, b].map(path => ({ path, beforeContent: "before", afterContent: "after" })))
      const row = store.readInFlight(sessionId, "file.mutation")[0]!
      const held = createDeferred<void>()
      const release = createDeferred<void>()
      const holding = withMutationQueueKeys([b], async () => { held.resolve(); await release.promise })
      await held.promise
      const recovery = reconcilePendingFileMutations({ sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const retainedWhileQueued = store.readInFlight(sessionId, "file.mutation")[0]?.raw === row.raw
      writeFileSync(a, "outside")
      release.resolve()
      await holding
      const failures = await recovery
      expect(retainedWhileQueued).toBe(true)
      expect(failures).toEqual([])
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect(mutationFacts(store, sessionId)).toMatchObject([{ type: "file.mutation.settled", payload: { outcome: "indeterminate" } }])
    })
  })

  it("retries a changed cell with its new target keys rather than retiring under the old queues", async () => {
    await withStore(async ({ root, store, writer, sessionId }) => {
      const a = join(root, "a")
      const z = join(root, "z")
      for (const path of [a, z]) writeFileSync(path, "before")
      await prepare(writer, a, "before", "after")
      const row = store.readInFlight(sessionId, "file.mutation")[0]!
      const cell = (await loadSessionPendingFileMutations(asAsyncEventReadSurface(store), sessionId)).operations[0]!.cell
      const authority = RetainedFileEditAuthority.admit(z)
      const precondition = snapshotToFileObjectProof(authority.existingSnapshot())
      authority.close()
      const changed = await stageFileMutationOperation({ ...cell, items: [{ ...cell.items[0]!, candidateEvidence: undefined, evidence: { ...cell.items[0]!.evidence, mutationId: "new-target", path: z, displayPath: z }, precondition }] }, nodes => writer.stageSessionContentNodes!(nodes))
      const heldA = createDeferred<void>()
      const heldZ = createDeferred<void>()
      const releaseA = createDeferred<void>()
      const releaseZ = createDeferred<void>()
      const holdingA = withMutationQueueKeys([a], async () => { heldA.resolve(); await releaseA.promise })
      const holdingZ = withMutationQueueKeys([z], async () => { heldZ.resolve(); await releaseZ.promise })
      await Promise.all([heldA.promise, heldZ.promise])
      const recovery = reconcilePendingFileMutations({ sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      store.putInFlight(sessionId, "file.mutation", row.key, changed)
      const afterOldQueue = withMutationQueueKeys([a], async () => store.readInFlight(sessionId, "file.mutation")[0]?.raw)
      releaseA.resolve()
      const rawWhileNewQueueHeld = await afterOldQueue
      releaseZ.resolve()
      await Promise.all([holdingA, holdingZ])
      expect(await recovery).toEqual([])
      expect(rawWhileNewQueueHeld).toBe(JSON.stringify(changed))
      expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
      expect(mutationFacts(store, sessionId)).toMatchObject([{ type: "file.mutation.settled", payload: { mutationId: "new-target", outcome: "not_applied" } }])
    })
  })
})
