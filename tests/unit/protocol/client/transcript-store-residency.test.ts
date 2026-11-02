import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { spyOn } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import * as transcriptDelta from "../../../../src/protocol/client/transcript-delta.js"
import * as transcriptPaging from "../../../../src/protocol/client/transcript-store-paging.js"
import { outputCursor, type OutputDelta } from "../../../../src/protocol/output-protocol-types.js"
import type { HydratedOutputBlockBody, HydratedOutputGroupChildrenBatch } from "../../../../src/protocol/transcript-protocol-types.js"
import { SESSION, blocks, deltaPatch, fakeConnection, settle, textBlock, toolBlock } from "./_transcript-store-fixtures.js"

function groupBlock(id: string): Extract<FrontendOutputBlock, { kind: "agentGroup" }> {
  return { kind: "agentGroup", containerKind: "subagent", id, toolUseId: id, description: "Test agent", children: [], totalToolCount: 2, status: "active", timestamp: 0, label: "Agent" }
}

const call = (id: string, content: string): FrontendToolEntry => ({ ...toolBlock("completed", content), id })

/** Replays one live delta sequence over a seeded window with fetched bodies
 *  and group children. On the copy path, an inert truncate to the current end
 *  sends each delta through the production copy path. */
async function replayDeltas(path: "slot" | "copy", seed: readonly FrontendOutputBlock[], sequence: readonly Extract<OutputDelta, { visibleMessageCount: number }>[], hydrated: { readonly bodies: readonly string[]; readonly groups: readonly string[] }) {
  const fake = fakeConnection({
    windows: [{ blocks: [...seed], startBlockIndex: 2, totalBlocks: seed.length + 2, hasBefore: true }],
    body: async (blockId) => ({ blockId, content: `full ${blockId}` }),
    group: async (ids) => ({ groups: ids.map((groupBlockId) => ({ groupBlockId, children: [call("c0", "hidden"), call("c1", "first")], totalChildren: 2, contentBytes: 0 })), contentBytes: 0 }),
  })
  const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
  await settle()
  for (const id of hydrated.bodies) await store.hydrateBody(id)
  for (const id of hydrated.groups) await store.hydrateGroup(id)
  const changes: unknown[] = []
  store.onChange((change) => { if (change.kind === "deltas") changes.push({ replaced: change.replaced, streamingChanged: change.streamingChanged }) })
  for (const [offset, delta] of sequence.entries()) {
    const end = (store.view.startBlockIndex ?? 0) + store.view.blocks.length
    const sent: OutputDelta = path === "copy" && delta.truncateTo === undefined ? { ...delta, truncateTo: end } : delta
    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 101 + offset, prevPosition: 100 + offset, payload: { kind: "output.delta", delta: sent } } })
  }
  assert.equal(fake.windowCalls, 1, `the ${path} path applied every delta without a recovery read`)
  const view = store.view
  store.dispose()
  return { view, changes }
}

describe("transcript resident window", () => {
  for (const count of [4, 1000]) test(`detached row updates and unseen appends read no history with ${count} residents`, async () => {
    const fake = fakeConnection({ windows: [{ blocks: blocks(0, count), startBlockIndex: 0, totalBlocks: count }] })
    const options = { connection: fake.connection, sessionId: SESSION, maxResidentBlocks: count, reader: () => ({ following: false, blockIds: ["text:b0"] }) }
    const store = createTranscriptStore(options)
    await settle()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, count, textBlock(`b${count}`)) })
    const bound = spyOn(transcriptPaging, "boundedWindow")
    const index = spyOn(transcriptDelta, "buildBlockIndex")
    try {
      for (let change = 0; change < 20; change++) {
        const position = 102 + change * 2
        fake.emit({ type: "patch", patch: deltaPatch(position, position - 1, count + change + 1, textBlock(`new${change}`)) })
        fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: position + 1, prevPosition: position, payload: { kind: "output.delta", delta: {
          visibleMessageCount: count + change + 1,
          blocks: [{ kind: "append-content", index: 0, blockId: "text:b0", contentOffset: 2 + change, text: "!" }],
        } } } })
      }
      assert.deepEqual(store.view.blocks[0], textBlock("b0", `b0${"!".repeat(20)}`))
      assert.equal(fake.windowCalls, 1)
      assert.equal(bound.mock.calls.length, 0)
      assert.equal(index.mock.calls.length, 0)
      assert.equal(store.view.blocks.length, count)
    } finally { bound.mockRestore(); index.mockRestore(); store.dispose() }
  })

  test("the oldest visible row survives the residency cap and detached updates", async () => {
    const fake = fakeConnection({ windows: [{ blocks: blocks(0, 4), startBlockIndex: 0, totalBlocks: 4 }] })
    const options = {
      connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4,
      reader: () => ({ following: false, blockIds: ["text:b0", "text:b1"] }),
    }
    const store = createTranscriptStore(options)
    try {
      await settle()
      fake.emit({ type: "patch", patch: deltaPatch(101, 100, 4, textBlock("b4")) })
      assert.deepEqual(store.view.blocks, blocks(0, 4), "trim the unseen newer edge, not the visible oldest row")
      assert.equal(store.view.atTail, false)
      assert.equal(store.view.hasNewer, true)
      fake.emit({ type: "patch", patch: deltaPatch(102, 101, 0, textBlock("b0", "updated")) })
      assert.deepEqual(store.view.blocks[0], textBlock("b0", "updated"))
    } finally { store.dispose() }
  })

  test("failed numeric recovery stays unsatisfied until an ordinary refresh adopts final output", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("answer", "Old answer")], startBlockIndex: 0, totalBlocks: 1 },
      { blocks: [textBlock("answer", "Final answer")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 101 },
    ] })
    let reads = 0
    const store = createTranscriptStore({
      sessionId: SESSION,
      recoveryMaxAttempts: 1,
      connection: {
        ...fake.connection,
        async query(request) {
          if (request.type === "outputWindow" && ++reads === 2) throw new Error("offline")
          return fake.connection.query(request)
        },
      },
    })
    try {
      await settle()
      store.recoverSettlement(101)
      store.recoverSettlement(101)
      await settle()
      assert.equal(reads, 2)
      assert.equal(store.status, "recovery-failed")
      assert.equal(store.view.appliedOutputPosition, null)
      assert.deepEqual(store.view.blocks, [textBlock("answer", "Old answer")])
      store.recoverSettlement(101)
      await settle()
      assert.equal(reads, 2)
      await store.refresh()
      assert.equal(reads, 3)
      assert.equal(store.view.appliedOutputPosition, 101)
      assert.deepEqual(store.view.blocks, [textBlock("answer", "Final answer")])
    } finally { store.dispose() }
  })

  test("queued numeric recovery skips its read when contiguous output already arrived", async () => {
    const page = Promise.withResolvers<{ blocks: FrontendOutputBlock[]; startBlockIndex: number }>()
    const fake = fakeConnection({
      windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: true }],
      ranges: [page.promise],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 12 })
    try {
      await settle()
      const loading = store.loadOlder()
      store.recoverSettlement(101)
      store.recoverSettlement(101)
      fake.emit({ type: "patch", patch: deltaPatch(101, 100, 8, textBlock("b8")) })
      page.resolve({ blocks: blocks(0, 4), startBlockIndex: 0 })
      await loading
      await settle()
      assert.equal(fake.windowCalls, 1)
      assert.equal(store.view.appliedOutputPosition, 101)
      assert.deepEqual(store.view.blocks, blocks(0, 9))
    } finally { store.dispose() }
  })

  test("queued settlement leaves an older trimmed window and its intake anchored", async () => {
    const page = Promise.withResolvers<{ blocks: FrontendOutputBlock[]; startBlockIndex: number }>()
    const fake = fakeConnection({
      windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: true }],
      ranges: [page.promise],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4 })
    try {
      await settle()
      const loading = store.loadOlder()
      store.recoverSettlement("final")
      page.resolve({ blocks: blocks(0, 4), startBlockIndex: 0 })
      await loading
      await settle()
      const resident = store.view.blocks
      for (let index = 0; index < 300; index++) {
        fake.emit({ type: "patch", patch: deltaPatch(101 + index, 100 + index, 8 + index, textBlock(`live${index}`)) })
      }
      await settle()
      assert.equal(store.view.atTail, false)
      assert.equal(store.view.blocks, resident)
      assert.deepEqual(resident, blocks(0, 4))
      assert.equal(fake.windowCalls, 2, "the tail read proves settlement without installing it")
      assert.equal(store.settledOutputRecovery, "final")
    } finally { store.dispose() }
  })

  test("reuses the delta index until window trimming changes coordinates", async () => {
    const fake = fakeConnection({ windows: [{ blocks: blocks(0, 1), startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 2,
      reader: () => ({ following: true, blockIds: ["text:b0"] }) })
    await settle()
    const buildIndex = spyOn(transcriptDelta, "buildBlockIndex")
    try {
      fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b1")) })
      assert.equal(buildIndex.mock.calls.length, 0)
      fake.emit({ type: "patch", patch: deltaPatch(102, 101, 2, textBlock("b2")) })
      assert.equal(buildIndex.mock.calls.length, 1)
      assert.deepEqual(store.view.blocks, blocks(1, 2))
      assert.equal(store.view.startBlockIndex, 1)
      fake.emit({ type: "patch", patch: deltaPatch(103, 102, 1, textBlock("b1", "updated")) })
      assert.equal(buildIndex.mock.calls.length, 1)
      assert.deepEqual(store.view.blocks, [textBlock("b1", "updated"), textBlock("b2")])
    } finally {
      buildIndex.mockRestore()
      store.dispose()
    }
  })

  test("rewrites slots for edits and content appends without bounding the window again", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a"), toolBlock("streaming", "one")], startBlockIndex: 0, totalBlocks: 2 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const bound = spyOn(transcriptPaging, "boundedWindow")
    try {
      fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 101, prevPosition: 100, payload: { kind: "output.delta", delta: {
        visibleMessageCount: 2,
        blocks: [
          { kind: "append-content", index: 0, blockId: "text:a", contentOffset: 1, text: "b" },
          { kind: "edit", index: 1, blockId: "tool:call-1", edits: [{ kind: "append", path: ["content"], offset: 3, text: " two" }] },
        ],
      } } } })
      assert.equal(bound.mock.calls.length, 0)
      assert.deepEqual(store.view.blocks, [textBlock("a", "ab"), toolBlock("streaming", "one two")])
      assert.equal(store.view.appliedOutputPosition, 101)
      fake.emit({ type: "patch", patch: deltaPatch(102, 101, 2, textBlock("c")) })
      assert.equal(bound.mock.calls.length, 1, "an insert moves indexes and still bounds the window")
    } finally {
      bound.mockRestore()
      store.dispose()
    }
  })

  test("applies a replayed delta sequence to the same view on the slot path as on the copy path", async () => {
    const thinking: FrontendOutputBlock = { kind: "thinking", id: "th", content: "x", status: "completed", timestamp: 0 }
    const seed = [textBlock("a"), call("t1", "one"), { ...groupBlock("g"), children: [call("c1", "first")] }, call("t2", "two"), thinking, textBlock("b")]
    const append = (index: number, blockId: string, contentOffset: number, text: string) => ({ kind: "append-content" as const, index, blockId, contentOffset, text })
    // Absolute indexes: a 2, t1 3, g 4, t2 5, th 6, b 7; c arrives at 8.
    const sequence: Extract<OutputDelta, { visibleMessageCount: number }>[] = [
      { visibleMessageCount: 4, blocks: [append(7, "text:b", 1, "c")] },
      { visibleMessageCount: 4, blocks: [append(7, "text:b", 2, "d"), append(7, "text:b", 3, "e")] },
      // The owner of a fetched body changes, so the body no longer describes it.
      { visibleMessageCount: 4, blocks: [{ kind: "edit", index: 3, blockId: "tool:t1", edits: [{ kind: "append", path: ["content"], offset: 3, text: " more" }] }] },
      // A group gains a child: the fetched children fold into the new block.
      { visibleMessageCount: 4, blocks: [{ kind: "edit", index: 4, blockId: "tool:g", edits: [
        { kind: "push", path: ["children"], length: 1, items: [{ ...call("c2", "second"), status: "streaming" }] },
        { kind: "assign", path: ["status"], value: "active" },
      ] }], streamingToolTextOps: [{ kind: "set", toolUseId: "c2", entry: { content: "partial" } }] },
      // A new copy with the same content keeps its fetched body.
      { visibleMessageCount: 4, blocks: [{ kind: "edit", index: 5, blockId: "tool:t2", edits: [{ kind: "assign", path: ["presentation"], value: { name: "Bash", detail: "printf output" } }] }] },
      { visibleMessageCount: 5, blocks: [{ kind: "insert", index: 8, blockId: "text:c", block: textBlock("c") }] },
      { visibleMessageCount: 5, blocks: [append(8, "text:c", 1, "!"), append(6, "thinking:th", 1, "y")] },
      { visibleMessageCount: 5, blocks: [{ kind: "upsert", index: 7, blockId: "text:b", block: textBlock("b", "bcdef") }] },
      { visibleMessageCount: 5, blocks: [append(7, "text:b", 5, "g")], streamingToolTextOps: [{ kind: "edit", toolUseId: "c2", edits: [{ kind: "append", path: ["content"], offset: 7, text: " done" }] }] },
      { visibleMessageCount: 4, blocks: [], truncateTo: 8 },
      { visibleMessageCount: 4, blocks: [append(7, "text:b", 6, "h")] },
    ]
    const hydrated = { bodies: ["t1", "t2"], groups: ["g"] }
    const slot = await replayDeltas("slot", seed, sequence, hydrated)
    const copy = await replayDeltas("copy", seed, sequence, hydrated)
    assert.deepEqual(slot, copy)
    assert.deepEqual(slot.view.blocks.map((block) => "content" in block ? block.content : block.kind), ["a", "one more", "agentGroup", "two", "xy", "bcdefgh"])
    assert.deepEqual(Object.keys(slot.view.bodies), ["t2"])
    assert.deepEqual(slot.view.groups.g?.children.map((child) => child.id), ["c0", "c1", "c2"])
    assert.deepEqual(slot.view.streamingToolText, { c2: { content: "partial done" } })
  })

  test("an edit that turns a group row into a tool row drops the fetched children on both paths", async () => {
    const seed = [textBlock("a"), { ...groupBlock("g"), children: [call("c1", "first")] }]
    // A whole-value assign may change a block's kind under the same identity.
    const sequence: Extract<OutputDelta, { visibleMessageCount: number }>[] = [
      { visibleMessageCount: 1, blocks: [{ kind: "edit", index: 3, blockId: "tool:g", edits: [{ kind: "assign", path: [], value: { kind: "tool", id: "g", name: "bash", presentation: { name: "Bash", detail: "printf output" }, timestamp: 0, status: "completed", content: "done" } }] }] },
    ]
    const hydrated = { bodies: [], groups: ["g"] }
    const slot = await replayDeltas("slot", seed, sequence, hydrated)
    const copy = await replayDeltas("copy", seed, sequence, hydrated)
    assert.deepEqual(slot, copy)
    assert.deepEqual(slot.view.blocks[1], call("g", "done"))
    assert.deepEqual(slot.view.groups, {})
  })

  test("bounds an oversized initial window before draining ordered patches", async () => {
    const fake = fakeConnection({ windows: [{ blocks: blocks(0, 650), startBlockIndex: 0, totalBlocks: 650 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, pageBlocks: 650 })
    const sizes: number[] = []
    store.onChange(() => sizes.push(store.view.blocks.length))
    fake.emit({ type: "patch", patch: deltaPatch(102, 101, 651, textBlock("b651")) })
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 650, textBlock("b650")) })
    await settle()
    assert.ok(sizes.every((size) => size <= 600), "no published window exceeds the resident ceiling")
    assert.deepEqual(store.view.blocks, blocks(52, 600))
    assert.equal(store.view.startBlockIndex, 52)
    assert.equal(store.view.totalBlocks, 652)
    assert.equal(store.view.hasBefore, true)
    assert.equal(store.view.atTail, true)
    assert.equal(store.view.hasNewer, false)
    assert.equal(store.view.appliedOutputPosition, 102)
    assert.equal(fake.windowCalls, 1)
    store.dispose()
  })

  test("bounds continuous live growth and keeps absolute indexes and text appends", async () => {
    const fake = fakeConnection({ windows: [{ blocks: blocks(0, 1), startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    let largest = 0
    for (let i = 1; i <= 1200; i++) {
      fake.emit({ type: "patch", patch: deltaPatch(100 + i, 99 + i, i, textBlock(`b${i}`)) })
      largest = Math.max(largest, store.view.blocks.length)
    }
    assert.equal(largest, 600)
    assert.deepEqual(store.view.blocks, blocks(601, 600))
    assert.equal(store.view.startBlockIndex, 601)
    assert.equal(store.view.totalBlocks, 1201)
    assert.equal(store.view.hasBefore, true)
    const running = { content: "streaming" }
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 1301, prevPosition: 1300,
      payload: { kind: "output.delta", delta: {
        visibleMessageCount: 1201,
        blocks: [{ kind: "append-content", index: 601, blockId: "text:b601", contentOffset: 4, text: " appended" }],
        streamingToolTextOps: [{ kind: "set", toolUseId: "running", entry: running }],
      } },
    } })
    assert.deepEqual(store.view.blocks[0], textBlock("b601", "b601 appended"))
    assert.deepEqual(store.view.streamingToolText, { running })
    assert.equal(fake.windowCalls, 1)
    store.dispose()
  })

  test("bounds reconnect merges before seeding and retains the newest suffix", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: blocks(20, 4), startBlockIndex: 20, totalBlocks: 24, hasBefore: true },
      { blocks: blocks(23, 4), startBlockIndex: 23, totalBlocks: 27, hasBefore: true, snapshotPosition: 200 },
    ] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4 })
    await settle()
    fake.reconnect()
    fake.emit({ type: "patch", patch: deltaPatch(201, 200, 27, textBlock("b27")) })
    await settle()
    assert.deepEqual(store.view.blocks, blocks(24, 4))
    assert.equal(store.view.startBlockIndex, 24)
    assert.equal(store.view.totalBlocks, 28)
    assert.equal(store.view.hasBefore, true)
    assert.equal(store.view.atTail, true)
    assert.equal(store.view.hasNewer, false)
    assert.equal(fake.windowCalls, 2)
    store.dispose()
  })

  for (const appended of [1, 2]) {
    test(`an older page pending ${appended} live evictions ${appended === 1 ? "keeps its evicted anchor at the seam" : "rejects a coordinate gap"}`, async () => {
      const response = Promise.withResolvers<{ blocks: FrontendOutputBlock[]; startBlockIndex: number; hasBefore: boolean }>()
      const currentStart = 4 + appended
      const fake = fakeConnection({
        windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: true }],
        ranges: [
          response.promise,
          { blocks: blocks(appended === 1 ? 0 : currentStart - 2, 3), startBlockIndex: appended === 1 ? 0 : currentStart - 2 },
        ],
      })
      const diagnostics: string[] = []
      const store = createTranscriptStore({
        connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4,
        onDiagnostic: (message) => diagnostics.push(message),
      })
      await settle()
      const loading = store.loadOlder()
      await settle()
      assert.deepEqual(fake.anchors, ["text:b4"])
      for (let i = 0; i < appended; i++) {
        fake.emit({ type: "patch", patch: deltaPatch(101 + i, 100 + i, 8 + i, textBlock(`b${8 + i}`)) })
      }
      const current = store.view
      assert.deepEqual(current.blocks, blocks(currentStart, 4))
      assert.equal(current.startBlockIndex, currentStart)
      assert.equal(current.atTail, true, "paging does not detach before its response arrives")
      let publications = 0
      store.onChange(() => publications++)
      response.resolve({ blocks: blocks(2, 3), startBlockIndex: 2, hasBefore: true })
      await loading
      if (appended === 1) {
        assert.deepEqual(store.view.blocks, blocks(2, 4), "the old anchor b4 fills the seam before current b5")
        assert.equal(store.view.startBlockIndex, 2)
        assert.equal(store.view.atTail, false)
        assert.equal(publications, 1)
      } else {
        assert.equal(store.view, current, "a disjoint page must not install any state")
        assert.equal(publications, 0)
        assert.equal(diagnostics.length, 1)
        fake.emit({ type: "patch", patch: {
          cursor: outputCursor(SESSION), position: 103, prevPosition: 102,
          payload: { kind: "output.delta", delta: {
            visibleMessageCount: 8 + appended,
            blocks: [{ kind: "append-content", index: 6, blockId: "text:b6", contentOffset: 2, text: " updated" }],
          } },
        } })
        assert.deepEqual(store.view.blocks[0], textBlock("b6", "b6 updated"), "the rejected page leaves the identity index intact")
      }
      assert.equal(store.view.totalBlocks, 8 + appended)
      assert.equal(store.view.hasBefore, true)
      assert.equal(store.view.hasNewer, appended === 1, "only the spliced page trimmed the live end")
      await store.loadOlder()
      const nextStart = appended === 1 ? 0 : currentStart - 2
      assert.deepEqual(fake.anchors, ["text:b4", `text:b${appended === 1 ? 2 : currentStart}`])
      assert.deepEqual(store.view.blocks.map(blockIdentity), blocks(nextStart, 4).map(blockIdentity))
      assert.equal(store.view.startBlockIndex, nextStart)
      assert.equal(store.view.hasBefore, false)
      assert.equal(store.view.atTail, false)
      assert.equal(store.view.totalBlocks, 8 + appended)
      assert.equal(fake.windowCalls, 1, "neither outcome starts an automatic recovery or retry")
      store.dispose()
    })
  }

  test("coalesces overlapping older-page reads before dispatch and while live output arrives", async () => {
    const response = Promise.withResolvers<{ blocks: FrontendOutputBlock[]; startBlockIndex: number; hasBefore: boolean }>()
    const fake = fakeConnection({
      windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: true }],
      ranges: [response.promise, { blocks: blocks(0, 3), startBlockIndex: 0 }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4 })
    await settle()

    const first = store.loadOlder()
    const beforeDispatch = store.loadOlder()
    assert.equal(beforeDispatch, first)
    await settle()
    assert.equal(fake.anchors.length, 1)

    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 8, textBlock("b8")) })
    const afterLivePatch = store.loadOlder()
    assert.equal(afterLivePatch, first)
    assert.equal(fake.anchors.length, 1)

    response.resolve({ blocks: blocks(2, 3), startBlockIndex: 2, hasBefore: true })
    await first
    await store.loadOlder()
    assert.equal(fake.anchors.length, 2)
    store.dispose()
  })

  for (const outcome of ["rejected", "empty", "no-op"] as const) {
    test(`clears an older-page coalescing promise after a ${outcome} settlement`, async () => {
      const rejected = Promise.withResolvers<{ blocks: FrontendOutputBlock[]; startBlockIndex: number; hasBefore: boolean }>()
      const firstRange = outcome === "rejected"
        ? rejected.promise
        : { blocks: outcome === "empty" ? [] : blocks(2, 3), startBlockIndex: 2, hasBefore: true }
      const fake = fakeConnection({
        windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: outcome !== "no-op" }],
        ranges: [firstRange, { blocks: blocks(2, 3), startBlockIndex: 2 }],
      })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4 })
      await settle()

      const settled = store.loadOlder()
      if (outcome === "rejected") {
        await settle()
        rejected.reject(new Error("read failed"))
      }
      await settled
      if (outcome === "no-op") {
        fake.emit({ type: "patch", patch: deltaPatch(101, 100, 8, textBlock("b8")) })
      }
      const next = store.loadOlder()
      assert.notEqual(next, settled)
      assert.equal(store.loadOlder(), next)
      await next
      store.dispose()
    })
  }

  test("rejects an older page whose overlap identity disagrees with the current boundary", async () => {
    const fake = fakeConnection({
      windows: [{ blocks: blocks(4, 4), startBlockIndex: 4, totalBlocks: 8, hasBefore: true }],
      ranges: [
        { blocks: [...blocks(2, 2), textBlock("wrong")], startBlockIndex: 2 },
        { blocks: blocks(2, 3), startBlockIndex: 2 },
      ],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4 })
    await settle()
    const current = store.view
    await store.loadOlder()
    assert.equal(store.view, current)
    await store.loadOlder()
    assert.deepEqual(fake.anchors, ["text:b4", "text:b4"])
    assert.deepEqual(store.view.blocks, blocks(2, 4))
    assert.equal(store.view.startBlockIndex, 2)
    assert.equal(store.view.atTail, false)
    store.dispose()
  })

  for (const lane of ["live", "older", "reconnect", "install", "truncate"] as const) {
    test(`evicts owned bodies and groups on ${lane}, retaining surviving payloads`, async () => {
      const evicted = { ...groupBlock("evicted"), totalToolCount: 1 }
      const retained = { ...groupBlock("retained"), totalToolCount: 1 }
      const newBlocks = [textBlock("a"), textBlock("b")]
      const initial = lane === "older" || lane === "truncate" ? [retained, evicted] : [evicted, retained]
      const child = toolBlock("completed", "full child")
      const fake = fakeConnection({
        windows: [
          { blocks: initial, startBlockIndex: lane === "older" ? 2 : 0, totalBlocks: lane === "older" ? 4 : 2, hasBefore: lane === "older" },
          { blocks: [retained, ...newBlocks], startBlockIndex: 1, totalBlocks: 4, hasBefore: true, snapshotPosition: 200 },
        ],
        ranges: [{ blocks: [...newBlocks, retained], startBlockIndex: 0 }],
        body: async (blockId) => ({ blockId, content: "full body" }),
        group: async (ids) => ({ groups: ids.map((groupBlockId) => ({ groupBlockId, children: [child], totalChildren: 1, contentBytes: 0 })), contentBytes: 0 }),
      })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 3 })
      await settle()
      await store.hydrateBody("evicted")
      await store.hydrateBody("retained")
      await store.hydrateGroup("evicted")
      await store.hydrateGroup("retained")
      const retainedBody = store.view.bodies.retained
      const retainedGroup = store.view.groups.retained
      assert.ok(retainedBody)
      assert.ok(retainedGroup)
      if (lane === "live") {
        fake.emit({ type: "patch", patch: deltaPatch(101, 100, 2, newBlocks[0]!) })
        fake.emit({ type: "patch", patch: deltaPatch(102, 101, 3, newBlocks[1]!) })
      } else if (lane === "older") {
        await store.loadOlder()
      } else if (lane === "reconnect") {
        fake.reconnect()
        await settle()
      } else if (lane === "install") {
        await store.jumpToLatest()
      } else {
        fake.emit({ type: "patch", patch: {
          cursor: outputCursor(SESSION), position: 101, prevPosition: 100,
          payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [], truncateTo: 1 } },
        } })
      }
      assert.equal(store.view.bodies.evicted, undefined)
      assert.equal(store.view.groups.evicted, undefined)
      assert.equal(store.view.bodies.retained, retainedBody)
      assert.deepEqual(store.view.groups.retained, retainedGroup)
      assert.equal(store.view.startBlockIndex, lane === "older" || lane === "truncate" ? 0 : 1)
      if (lane === "older") {
        assert.deepEqual(store.view.blocks, [...newBlocks, retained])
        assert.equal(store.view.totalBlocks, 4)
        assert.equal(store.view.hasBefore, false)
        assert.equal(store.view.atTail, false)
        assert.equal(store.view.hasNewer, true, "the trimmed live end is newer output")
        const resident = store.view
        fake.emit({ type: "patch", patch: deltaPatch(101, 100, 4, textBlock("live")) })
        assert.equal(store.view.blocks, resident.blocks)
        assert.equal(store.view.bodies, resident.bodies)
        assert.equal(store.view.groups, resident.groups)
        assert.equal(store.view.hasNewer, true)
      }
      store.dispose()
    })
  }

  for (const change of ["evicted", "changed", "unchanged"] as const) {
    test(`admits a late body only for its unchanged resident owner: ${change}`, async () => {
      const owner = toolBlock("completed", "original")
      const response = Promise.withResolvers<HydratedOutputBlockBody>()
      const fake = fakeConnection({
        windows: [{ blocks: [owner], startBlockIndex: 0, totalBlocks: 1 }],
        body: () => response.promise,
      })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 1 })
      await settle()
      const hydration = store.hydrateBody(owner.id)
      await settle()
      fake.emit({ type: "patch", patch: deltaPatch(101, 100, change === "evicted" ? 1 : 0,
        change === "evicted" ? textBlock("next") : { ...owner, content: change === "changed" ? "updated" : owner.content }) })
      const body = { blockId: blockIdentity(owner), content: "full original" }
      response.resolve(body)
      await hydration
      assert.deepEqual(store.view.bodies[owner.id], change === "unchanged" ? body : undefined)
      store.dispose()
    })
  }

  test("discards an in-flight body's result when its owner identity changes", async () => {
    const owner = textBlock("same")
    const response = Promise.withResolvers<HydratedOutputBlockBody>()
    const fake = fakeConnection({ windows: [{ blocks: [owner], startBlockIndex: 0, totalBlocks: 1 }], body: () => response.promise })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const hydration = store.hydrateBody("same")
    await settle()
    const replacement: FrontendOutputBlock = { kind: "thinking", id: "same", content: "different owner", status: "completed", timestamp: 0 }
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 101, prevPosition: 100,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 0, truncateTo: 0, blocks: [{ kind: "upsert", index: 0, blockId: blockIdentity(replacement), block: replacement }] } },
    } })
    response.resolve({ blockId: blockIdentity(owner), content: "old body" })
    await hydration
    assert.deepEqual(store.view.blocks, [replacement])
    assert.deepEqual(store.view.bodies, {})
    store.dispose()
  })

  for (const evict of [true, false]) {
    test(`group pagination ${evict ? "stops after owner eviction" : "acquires every page for a resident owner"}`, async () => {
      const owner = groupBlock("g")
      const first = toolBlock("completed", "first")
      const second = { ...first, id: "second", content: "second" }
      const response = Promise.withResolvers<HydratedOutputGroupChildrenBatch>()
      let calls = 0
      const fake = fakeConnection({
        windows: [{ blocks: [owner], startBlockIndex: 0, totalBlocks: 1 }],
        group: () => ++calls === 1 ? response.promise : Promise.resolve({
          groups: [{ groupBlockId: blockIdentity(owner), children: [second], totalChildren: 2, contentBytes: 0 }], contentBytes: 0,
        }),
      })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 1 })
      await settle()
      const hydration = store.hydrateGroup("g")
      await settle()
      if (evict) fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("next")) })
      const cursor = { groupBlockId: blockIdentity(owner), childIndex: 1 }
      response.resolve({
        groups: [{ groupBlockId: blockIdentity(owner), children: [first], totalChildren: 2, contentBytes: 0 }],
        contentBytes: 0, nextCursor: cursor,
      })
      await hydration
      assert.equal(calls, evict ? 1 : 2)
      assert.deepEqual(fake.groupCursors, evict ? [undefined] : [undefined, cursor])
      assert.deepEqual(store.view.groups.g, evict ? undefined : { children: [first, second], total: 2 })
      store.dispose()
    })
  }

  // A tool row keeps the group's identity, so only its kind says the group is gone.
  for (const [owner, patch] of [
    ["left the window", deltaPatch(101, 100, 1, textBlock("next"))],
    ["became a tool row", { cursor: outputCursor(SESSION), position: 101, prevPosition: 100, payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "upsert", index: 0, blockId: "tool:g", block: call("g", "done") }] } } }],
  ] as const) {
    test(`forgets a failed group read whose owner ${owner}`, async () => {
      const response = Promise.withResolvers<HydratedOutputGroupChildrenBatch>()
      const fake = fakeConnection({ windows: [{ blocks: [groupBlock("g")], startBlockIndex: 0, totalBlocks: 1 }], group: () => response.promise })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 1 })
      await settle()
      const hydration = store.hydrateGroup("g")
      await settle()
      fake.emit({ type: "patch", patch })
      response.reject(new Error("offline"))
      await hydration
      assert.deepEqual(store.view.groupRequests, {})
      store.dispose()
    })
  }
})
