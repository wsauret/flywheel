import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { SESSION, blocks, textBlock, fakeConnection, deltaPatch, settle } from "./_transcript-store-fixtures.js"

describe("transcript store", () => {
  test("recovers from a delta that disagrees with the resident window", async () => {
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 },
        { blocks: [textBlock("a"), textBlock("z")], startBlockIndex: 0, totalBlocks: 2, snapshotPosition: 300 },
      ],
    })
    const diagnostics: { message: string; detail?: unknown }[] = []
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (message, detail) => diagnostics.push({ message, detail }) })

    // An insert far past the resident end is a coordinate disagreement, not an
    // append. It arrives before the snapshot, then diverges while seed drains
    // the held patches.
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 99, textBlock("far")) })
    await settle()

    const divergences = diagnostics.filter((item) => item.message.includes("diverged"))
    assert.equal(divergences.length, 1, "divergence is reported once, not guessed through")
    assert.deepEqual(divergences[0]?.detail, {
      rejection: { reason: "insert-outside-window", operationIndex: 0, operationKind: "insert", index: 99, localIndex: 99, blockId: "text:far", incomingIdentity: "text:far", residentCount: 1 },
      cursor: { applied: 100, incoming: 101, incomingPrevious: 100 },
      resident: { start: 0, end: 0, count: 1, total: 1, visibleMessageCount: 1, atTail: true, hasBefore: false, hasNewer: false, consistencyToken: "t" },
      delta: { blockOperations: 1, streamingOperations: 0, truncateTo: undefined, visibleMessageCount: 100 },
      nearby: [{ localIndex: 0, index: 0, kind: "text", blockId: "text:a" }],
    })
    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "z"], "resident state came from the authoritative read")
    assert.equal(store.view.appliedOutputPosition, 300, "the divergent seed cannot restore its stale snapshot position")
    store.dispose()
  })

  test("repaves a following window whose delta cuts below its start, and never shows it empty", async () => {
    const resident = blocks(10, 3)
    const fake = fakeConnection({ windows: [
      { blocks: resident, startBlockIndex: 10, totalBlocks: 13, hasBefore: true },
      { blocks: blocks(10, 4), startBlockIndex: 10, totalBlocks: 14, hasBefore: true, snapshotPosition: 300 },
    ] })
    const rejections: unknown[] = []
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (name, detail) => { if (name.includes("diverged") && typeof detail === "object" && detail !== null && "rejection" in detail) rejections.push(detail.rejection) } })
    await settle()
    const emptyWhileReady: number[] = []
    const stop = store.onChange(() => { if (store.status === "ready" && store.view.blocks.length === 0) emptyWhileReady.push(store.view.totalBlocks) })
    // A reseed that numbers blocks differently cuts and rewrites only rows
    // below the window, so the held window has nothing true to show.
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 101, prevPosition: 100,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 8, truncateTo: 6, blocks: blocks(6, 2).map((block, offset) => ({ kind: "upsert" as const, index: 6 + offset, blockId: blockIdentity(block), block })) } },
    } })
    assert.deepEqual(rejections, [{ reason: "truncate-below-window", operationKind: "truncate", index: 6, localIndex: -4, residentCount: 3 }])
    assert.deepEqual(store.view.blocks, resident, "the rejected cut leaves the held window in place")
    await settle()
    assert.deepEqual(store.view.blocks, blocks(10, 4), "the window is read again from the authority")
    assert.equal(store.view.appliedOutputPosition, 300)
    assert.deepEqual(emptyWhileReady, [])
    stop()
    store.dispose()
  })

  test("reports the rejected draft operation but samples only the original resident window", async () => {
    const message: FrontendOutputBlock = { kind: "userMessage", id: "user", content: "private user text", timestamp: 1, injected: false, pending: false, submissionIds: Array.from({ length: 12 }, (_, i) => `submission-${i}`), imageCount: 2 }
    const original = [message, ...Array.from({ length: 12 }, (_, i) => textBlock(`a${i}`, "private body"))]
    const fake = fakeConnection({ windows: [{ blocks: original, startBlockIndex: 10, totalBlocks: 23 }] })
    const diagnostics: unknown[] = []
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (name, detail) => { if (name.includes("diverged")) diagnostics.push(detail) } })
    await settle()
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 101, prevPosition: 100,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [
        { kind: "insert", index: 23, blockId: "text:new", block: textBlock("new", "private incoming") },
        { kind: "append-content", index: 11, blockId: "text:a0", contentOffset: 99, text: "private suffix" },
      ] } },
    } })
    assert.equal(diagnostics.length, 1)
    const detail = diagnostics[0]
    assert.ok(typeof detail === "object" && detail !== null && "rejection" in detail && "resident" in detail && "nearby" in detail)
    assert.deepEqual(detail.rejection, { reason: "append-content-gap", operationIndex: 1, operationKind: "append-content", index: 11, localIndex: 1, blockId: "text:a0", contentOffset: 99, residentLength: 12, incomingLength: 14 })
    assert.ok(Array.isArray(detail.nearby))
    assert.equal(detail.nearby.length, 8)
    assert.deepEqual(detail.nearby[0], { localIndex: 0, index: 10, kind: "userMessage", blockId: "userMessage:user", submissionIds: Array.from({ length: 8 }, (_, i) => `submission-${i}`), submissionCount: 12, pending: false, injected: false, imageCount: 2 })
    assert.ok(!JSON.stringify(detail).includes("private"))
    assert.deepEqual(store.view.blocks, original, "a rejected draft never installs its successful prefix")
    await settle()
    assert.deepEqual(store.view.blocks, original, "recovery still reads the authoritative window")
    store.dispose()
  })
})
