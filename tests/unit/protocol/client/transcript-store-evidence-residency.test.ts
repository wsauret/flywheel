import assert from "node:assert/strict"
import { test } from "node:test"
import type { MutationEvidence } from "../../../../src/infra/mutation-evidence.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { SESSION, deltaPatch, fakeConnection, settle, toolBlock } from "./_transcript-store-fixtures.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

test("keeps disclosed evidence across same-root history adoption and invalidates only changed or evicted owners", async () => {
  const text = "+retained\n"
  const reference = { version: 1 as const, root: "c".repeat(64), bytes: Buffer.byteLength(text), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
  const evidence: MutationEvidence = {
    version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 100, entries: 1 },
    applied: 1, retainedFiles: 1, omissions: 0, notApplied: 0, added: 0, modified: 1, removed: 0,
    addedLines: 1, removedLines: 0, conflictMarkers: 0, samples: [],
  }
  const first = { ...toolBlock("completed"), mutationEvidence: evidence }
  const second = { ...first, id: "call-2" }
  const fake = fakeConnection({
    windows: [
      { blocks: [], startBlockIndex: 0, totalBlocks: 0 },
      { blocks: [{ ...first, timestamp: 1 }, second], startBlockIndex: 0, totalBlocks: 2, snapshotPosition: 102 },
    ],
  })
  const originalQuery = fake.connection.query
  let evidenceReads = 0
  fake.connection.query = runtimeQuery({
    mutationPatchWindow: async (query) => ({
      kind: "available", sessionId: SESSION, reference, requestedOffset: query.offset, offset: 0,
      totalBytes: reference.bytes, servedBytes: reference.bytes, base64: btoa(text), nextOffset: null,
    }),
    mutationFiles: async (query) => {
      evidenceReads += 1
      return {
        kind: "available", sessionId: SESSION, manifest: query.manifest,
        requestedOffset: query.offset, offset: 0, totalFiles: 1, totalBytes: 100, nextOffset: null,
        files: [{ kind: "applied", file: {
          version: 1, mutationId: "mutation-1", path: "a.ts", displayPath: "a.ts", change: "modified",
          before: null, after: null, retainedLines: 1, renderedLines: 1, omittedLines: 0,
          addedLines: 1, removedLines: 0, patch: { kind: "retained", reference }, conflictMarkers: false,
        } }],
      }
    },
  }, originalQuery)
  const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
  try {
    await settle()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 0, first) })
    fake.emit({ type: "patch", patch: deltaPatch(102, 101, 1, second) })
    assert.equal(store.view.historicalThroughIndex, -1)
    const one = store.mutationEvidence.open(first.id, evidence.manifest)
    const two = store.mutationEvidence.open(blockIdentity(second), evidence.manifest)
    await Promise.all([one.loadFiles(), two.loadFiles()])
    const onePatch = one.patch(one.files.files[0]!)
    const twoPatch = two.patch(two.files.files[0]!)
    assert.ok(onePatch)
    assert.ok(twoPatch)
    await Promise.all([onePatch.continue(), twoPatch.continue()])
    assert.equal(onePatch.view.text, text)
    assert.equal(evidenceReads, 1)
    await store.refresh()
    assert.equal(store.view.historicalThroughIndex, 1)
    assert.equal(one.files.status, "ready")
    assert.equal(onePatch.view.text, text)
    assert.equal(store.mutationEvidence.open(first.id, evidence.manifest), one)
    assert.equal(evidenceReads, 1)
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), prevPosition: 102, position: 103,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 2, blocks: [{
        kind: "edit", index: 0, blockId: blockIdentity(first),
        edits: [{ kind: "assign", path: ["mutationEvidence", "manifest", "root"], value: "b".repeat(64) }],
      }] } },
    } })
    assert.equal(one.files.status, "idle")
    assert.equal(onePatch.view.text, "")
    assert.equal(two.files.status, "ready")
    assert.equal(twoPatch.view.text, text)
    store.dropBefore(1)
    assert.equal(two.files.status, "ready")
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), prevPosition: 103, position: 104,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 2, blocks: [], truncateTo: 1 } },
    } })
    assert.equal(two.files.status, "idle")
    assert.equal(twoPatch.view.text, "")
    assert.equal(store.mutationEvidence.heldBytes, 0)
  } finally {
    store.dispose()
  }
})
