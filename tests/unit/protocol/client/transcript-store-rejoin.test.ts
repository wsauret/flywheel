import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { createTranscriptStore, type TranscriptChange } from "../../../../src/protocol/client/transcript-store.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { SESSION, textBlock, toolBlock, fakeConnection, deltaPatch, settle, type WindowSpec } from "./_transcript-store-fixtures.js"

// The reader's identities survive recovery; only following or explicit
// navigation chooses the live end.
describe("transcript store rejoin", () => {
  for (const revision of ["rebase", "truncate"] as const) test(`${revision} retains a finite protected span beyond the nominal resident bound`, async () => {
    const original = ["a", "b", "c", "d"].map((id) => textBlock(id))
    const rebased = [textBlock("a"), textBlock("inserted"), ...original.slice(1)]
    const fake = fakeConnection({ windows: [
      { blocks: original, startBlockIndex: 0, totalBlocks: 4 },
      { blocks: rebased, startBlockIndex: 2, totalBlocks: 30, hasBefore: true, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 2 }, { blockId: "text:b", index: 4 }, { blockId: "text:c", index: 5 }, { blockId: "text:d", index: 6 }] },
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 4, reader: () => ({ following, blockIds: original.map(blockIdentity) }) })
    try {
      await settle()
      following = false
      fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 101, prevPosition: 100, payload: revision === "rebase"
        ? { kind: "runtime.invalidate", reason: "rebase" }
        : { kind: "output.delta", delta: { visibleMessageCount: 4, truncateTo: 0, blocks: [] } } } })
      assert.deepEqual(store.view.blocks, original, "a coordinate revision does not clear the held presentation")
      await settle()
      assert.deepEqual(store.view.blocks, rebased)
      assert.equal(store.view.blocks.length, 5)
      assert.equal(store.windowCurrent, true)
    } finally { store.dispose() }
  })

  test("a reader move during recovery never installs the old protected destination", async () => {
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 }, pending.promise,
      { blocks: [textBlock("b")], startBlockIndex: 4, totalBlocks: 30, hasAfter: true, snapshotPosition: 201,
        membership: [{ blockId: "text:b", index: 4 }, { blockId: "text:a", index: 3 }] },
    ] })
    let reader = { following: true, blockIds: ["text:a"] }
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => reader })
    const adopted: string[][] = []
    const stop = store.onChange((change) => { if (change.kind === "window") adopted.push(store.view.blocks.map(blockIdentity)) })
    try {
      await settle()
      reader = { following: false, blockIds: ["text:a"] }
      fake.reconnect()
      await settle()
      reader = { following: false, blockIds: ["text:b"] }
      pending.resolve({ blocks: [textBlock("a")], startBlockIndex: 3, totalBlocks: 30, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 3 }] })
      await settle()
      assert.deepEqual(store.view.blocks, [textBlock("b")])
      assert.equal(fake.windowCalls, 3)
      assert.equal(adopted.length, 2, "the stale a-only response is not presented")
    } finally { stop(); store.dispose() }
  })

  for (const successor of [200, "final"] as const) test(`pending anchored settlement services its ${successor} successor`, async () => {
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 },
      pending.promise,
      { blocks: [textBlock("a", "updated")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 0 }] },
      { blocks: [textBlock("tail")], startBlockIndex: 29, totalBlocks: 30, snapshotPosition: 201 },
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => ({ following, blockIds: ["text:a"] }) })
    try {
      await settle()
      following = false
      store.recoverSettlement(110)
      await settle()
      store.recoverSettlement(successor)
      pending.resolve({ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 110,
        membership: [{ blockId: "text:a", index: 0 }] })
      await settle()
      assert.equal(store.view.appliedOutputPosition, 200)
      assert.deepEqual(store.view.blocks, [textBlock("a", "updated")])
      assert.equal(store.windowCurrent, true)
      assert.equal(store.settledOutputRecovery, typeof successor === "string" ? successor : undefined)
      assert.equal(fake.windowCalls, typeof successor === "string" ? 4 : 3)
    } finally { store.dispose() }
  })

  for (const proof of ["ok", "failed", "unavailable"] as const) test(`opaque settlement ${proof} proof never replaces or invalidates an anchored reading window`, async () => {
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 4, totalBlocks: 30, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 4 }, { blockId: "text:b", index: 5 }] },
      pending.promise,
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, recoveryMaxAttempts: 1, reader: () => ({ following, blockIds: ["text:a", "text:b"] }) })
    try {
      await settle()
      following = false
      store.recoverSettlement("final")
      await settle()
      assert.equal(store.windowCurrent, true, "the protected read has installed before the tail proof completes")
      const resident = store.view.blocks
      if (proof === "failed") pending.reject(new Error("offline"))
      else pending.resolve({ blocks: [textBlock("tail")], startBlockIndex: 29, totalBlocks: 30, snapshotPosition: 201,
        ...(proof === "unavailable" ? { unavailable: { title: "Unavailable", message: "Unavailable", diagnostic: "Unavailable" } } : {}) })
      await settle()
      assert.equal(store.view.blocks, resident)
      assert.deepEqual(store.view.blocks, [textBlock("a"), textBlock("b")])
      assert.equal(store.view.startBlockIndex, 4)
      assert.equal(store.view.atTail, false)
      assert.equal(store.windowCurrent, true)
      assert.equal(store.settledOutputRecovery, proof === "ok" ? "final" : undefined)
      fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 201, prevPosition: 200, payload: { kind: "output.delta", delta: {
        visibleMessageCount: 30, blocks: [{ kind: "append-content", index: 4, blockId: "text:a", contentOffset: 1, text: "!" }],
      } } } })
      assert.deepEqual(store.view.blocks, [textBlock("a", "a!"), textBlock("b")])
      store.recoverSettlement("final")
      await settle()
      assert.equal(store.windowCurrent, true)
      assert.equal(store.settledOutputRecovery, proof === "ok" ? "final" : undefined)
      assert.equal(fake.windowCalls, 3)
    } finally { store.dispose() }
  })

  test("a pending anchored recovery adopts current coordinates before draining retained-row patches", async () => {
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
      pending.promise,
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => ({ following, blockIds: ["text:a", "text:b"] }) })
    try {
      await settle()
      following = false
      fake.reconnect()
      const held = store.view.blocks
      fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 201, prevPosition: 200, payload: { kind: "output.delta", delta: {
        visibleMessageCount: 20, blocks: [{ kind: "append-content", index: 4, blockId: "text:a", contentOffset: 1, text: "!" }],
      } } } })
      assert.equal(store.view.blocks, held)
      assert.equal(store.windowCurrent, false)
      const changes: TranscriptChange[] = []
      const publishedCurrent: boolean[] = []
      store.onChange((change) => {
        changes.push(change)
        if (change.kind === "window") publishedCurrent.push(store.windowCurrent)
      })
      pending.resolve({ blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 4, totalBlocks: 20, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 4 }, { blockId: "text:b", index: 5 }] })
      await settle()
      assert.deepEqual(changes.filter((change) => change.kind === "deltas" || change.kind === "window"), [
        { kind: "window", reason: "merge", adopted: [textBlock("a"), textBlock("b"), textBlock("a", "a!")] },
      ])
      assert.deepEqual(publishedCurrent, [true])
      assert.deepEqual(store.view.blocks, [textBlock("a", "a!"), textBlock("b")])
      assert.equal(store.view.startBlockIndex, 4)
      assert.equal(store.windowCurrent, true)
      assert.equal(fake.windowCalls, 2)
    } finally { store.dispose() }
  })

  for (const failure of ["incomplete", "unavailable", "failed"] as const) test(`a ${failure} protected recovery holds its presentation non-current`, async () => {
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 }, pending.promise,
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, recoveryMaxAttempts: 1, reader: () => ({ following, blockIds: ["text:a", "text:b"] }) })
    try {
      await settle()
      following = false
      const held = store.view.blocks
      fake.reconnect()
      if (failure === "failed") pending.reject(new Error("offline"))
      else pending.resolve({
        blocks: [textBlock("a")], startBlockIndex: 7, totalBlocks: 20, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:a", index: 7 }, { blockId: "text:b", index: 8 }],
        ...(failure === "unavailable" ? { unavailable: { title: "Unavailable", message: "Unavailable", diagnostic: "Unavailable" } } : {}),
      })
      await settle()
      assert.equal(store.view.blocks, held)
      assert.equal(store.view.startBlockIndex, 0)
      assert.equal(store.windowCurrent, false)
    } finally { store.dispose() }
  })

  test("only authoritative absence retires the protected subject and selects its prior neighbour", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
      { blocks: [textBlock("a")], startBlockIndex: 3, totalBlocks: 20, hasAfter: true, snapshotPosition: 200,
        membership: [{ blockId: "text:b", index: null }, { blockId: "text:a", index: 3 }] },
    ] })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => ({ following, blockIds: ["text:b"] }) })
    try {
      await settle()
      following = false
      fake.reconnect()
      await settle()
      assert.deepEqual(store.view.blocks, [textBlock("a")])
      assert.equal(store.view.startBlockIndex, 3)
      assert.equal(store.windowCurrent, true)
    } finally { store.dispose() }
  })

  test("a store made before a lane opens reads nothing until the lane opens, and then reads once", async () => {
    const fake = fakeConnection({ laneOpen: false, windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(fake.windowCalls, 0)
    fake.lanes.open()
    await settle()
    assert.equal(fake.windowCalls, 1)
    assert.deepEqual(store.view.blocks, [textBlock("a")])
    store.dispose()
  })

  test("a tail read lost with its lane shows no failure and reads again when the next lane opens", async () => {
    const diagnostics: string[] = []
    const fake = fakeConnection({
      windowFailures: [new RuntimeLaneLost(new Error("the runtime event lane ended"))],
      windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (message) => diagnostics.push(message) })
    await settle()
    assert.equal(fake.windowCalls, 1)
    assert.notEqual(store.status, "recovery-failed")
    assert.deepEqual(diagnostics, [])
    fake.reconnect()
    await settle()
    assert.equal(fake.windowCalls, 2)
    assert.deepEqual(store.view.blocks, [textBlock("a")])
    store.dispose()
  })

  test("reattaches by merging the live tail into the resident window", async () => {
    const settled = toolBlock("completed", "done")
    const body = { blockId: "tool:call-1", content: "full body" }
    const pending = Promise.withResolvers<WindowSpec>()
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("a"), settled], startBlockIndex: 0, totalBlocks: 2 },
        pending.promise,
      ],
      body,
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    await store.hydrateBody("call-1")
    const installed = store.windowGeneration
    const changes: TranscriptChange[] = []
    const streaming = { content: "partial" }
    const publications: { current: boolean; streaming: unknown }[] = []
    store.onChange((change) => {
      changes.push(change)
      if (change.kind === "window") publications.push({ current: store.windowCurrent, streaming: store.view.streamingToolText })
    })

    fake.reconnect()
    assert.equal(store.view.appliedOutputPosition, null, "reconnect clears coverage while its tail read is pending")
    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 201, prevPosition: 200, payload: { kind: "output.delta", delta: {
      visibleMessageCount: 4, blocks: [{ kind: "insert", index: 3, blockId: "text:d", block: textBlock("d") }],
      streamingToolTextOps: [{ kind: "set", toolUseId: "running", entry: streaming }],
    } } } })
    pending.resolve({ blocks: [{ ...settled }, textBlock("c")], startBlockIndex: 1, totalBlocks: 3, snapshotPosition: 200 })
    await settle()
    assert.equal(store.windowGeneration, installed, "a merge keeps the window")
    assert.deepEqual(changes.filter((change) => change.kind === "deltas" || change.kind === "window"), [
      { kind: "window", reason: "merge", adopted: [settled, textBlock("c"), textBlock("d")] },
    ])
    assert.deepEqual(publications, [{ current: true, streaming: { running: streaming } }])

    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "call-1", "c", "d"], "what was resident before the live window stays, the window lands on top")
    assert.deepEqual(store.view.bodies["call-1"], body, "a body fetched for a block the reattach did not change is kept")
    assert.equal(store.view.totalBlocks, 4)
    assert.equal(store.view.startBlockIndex, 0)
    assert.equal(store.view.appliedOutputPosition, 201)
    store.dispose()
  })

  test("drops a fetched body whose block changed while away", async () => {
    const before = toolBlock("completed", "first")
    const after = toolBlock("completed", "rewritten")
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("a"), before], startBlockIndex: 0, totalBlocks: 2 },
        { blocks: [after], startBlockIndex: 1, totalBlocks: 2, snapshotPosition: 200 },
      ],
      body: { blockId: "tool:call-1", content: "stale body" },
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    await store.hydrateBody("call-1")

    fake.reconnect()
    await settle()

    assert.deepEqual(store.view.blocks, [textBlock("a"), after])
    assert.equal(store.view.bodies["call-1"], undefined)
    store.dispose()
  })

  test("recovers a protected off-tail row instead of installing a disjoint live tail", async () => {
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
        { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 4, totalBlocks: 20, hasBefore: true, hasAfter: true, snapshotPosition: 200,
          membership: [{ blockId: "text:a", index: 4 }, { blockId: "text:b", index: 5 }] },
        { blocks: [textBlock("x"), textBlock("y")], startBlockIndex: 18, totalBlocks: 20, hasBefore: true, snapshotPosition: 201 },
      ],
    })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => ({ following, blockIds: ["text:a", "text:b"] }) })
    await settle()
    following = false
    const generation = store.windowGeneration
    fake.reconnect()
    await settle()

    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "b"])
    assert.deepEqual(fake.windowAnchors[1], { kind: "residentSpan", blockIds: ["text:a", "text:b"], candidates: [] })
    assert.equal(store.view.startBlockIndex, 4)
    assert.equal(store.windowGeneration, generation)
    assert.equal(store.windowCurrent, true)
    assert.equal(store.view.hasNewer, true)
    assert.equal(store.view.hasBefore, true)
    await store.jumpToLatest()
    assert.deepEqual(store.view.blocks, [textBlock("x"), textBlock("y")])
    store.dispose()
  })

  for (const jumpDuringPaging of [false, true]) test(`returns to latest ${jumpDuringPaging ? "during" : "after"} history paging`, async () => {
    const older = Array.from({ length: 40 }, (_, i) => textBlock(`o${i}`))
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("tail")], startBlockIndex: 40, totalBlocks: 41, hasBefore: true },
        { blocks: [textBlock("tail"), textBlock("newer")], startBlockIndex: 40, totalBlocks: 42, hasBefore: true, snapshotPosition: 200 },
      ],
      ranges: [{ blocks: [...older, textBlock("tail")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 10 })
    await settle()
    const installed = store.windowGeneration
    const paging = store.loadOlder()
    const jumping = jumpDuringPaging ? store.jumpToLatest() : undefined
    assert.equal(await paging, true)
    if (jumping) {
      await jumping
      assert.equal(store.view.atTail, true)
      assert.equal(store.view.appliedOutputPosition, 200)
      store.dispose()
      return
    }
    assert.equal(store.view.atTail, false)
    assert.equal(store.windowGeneration, installed, "an older page keeps the window")
    const resident = store.view.blocks

    fake.reconnect()
    await settle()

    assert.equal(store.view.blocks, resident, "history stays exactly as the reader left it")
    assert.equal(store.view.hasNewer, true, "and the reader is told the live end moved on")
    assert.equal(store.view.appliedOutputPosition, null)
    assert.equal(store.windowGeneration, installed, "a detached reattach keeps the window")
    await store.jumpToLatest()
    assert.equal(store.view.appliedOutputPosition, 200, "only returning to an attached tail restores coverage")
    assert.equal(store.windowGeneration, installed + 1, "the latest tail replaces the window even where it overlaps")
    store.dispose()
  })

  for (const invalidation of [
    { cursor: { scope: "workspace", domain: "runtime" }, reason: "overflow" },
    { cursor: outputCursor(SESSION), reason: "overflow" },
  ] as const) {
    test(`merges the live tail after a ${invalidation.cursor.domain} ${invalidation.reason} invalidation instead of repaving`, async () => {
      const fake = fakeConnection({
        windows: [
          { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
          { blocks: [textBlock("b"), textBlock("c")], startBlockIndex: 1, totalBlocks: 3, snapshotPosition: 200 },
        ],
      })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
      await settle()
      const changes: Parameters<Parameters<typeof store.onChange>[0]>[0][] = []
      store.onChange((change) => { changes.push(change) })

      fake.emit({ type: "patch", patch: { cursor: invalidation.cursor, position: 150, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: invalidation.reason } } })
      await settle()

      const windows = changes.filter((change) => change.kind === "window")
      assert.deepEqual(windows.map((change) => change.kind === "window" ? change.reason : ""), ["merge"], "the resident coordinates stayed valid, so the pane keeps its rows and scroll place")
      assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "b", "c"])
      assert.equal(store.view.appliedOutputPosition, 200)
      store.dispose()
    })
  }

  test("a rebase resolves the protected row in current coordinates, not the tail", async () => {
    const fake = fakeConnection({
      windows: [
        { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 },
        { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 7, totalBlocks: 30, hasAfter: true, snapshotPosition: 200,
          membership: [{ blockId: "text:a", index: 7 }, { blockId: "text:b", index: 8 }] },
      ],
    })
    let following = true
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, reader: () => ({ following, blockIds: ["text:a", "text:b"] }) })
    await settle()
    following = false
    const changes: Parameters<Parameters<typeof store.onChange>[0]>[0][] = []
    store.onChange((change) => { changes.push(change) })

    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 150, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "rebase" } } })
    await settle()

    const windows = changes.filter((change) => change.kind === "window")
    assert.deepEqual(windows.map((change) => change.kind === "window" ? change.reason : ""), ["merge"])
    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "b"])
    assert.equal(store.view.startBlockIndex, 7)
    assert.equal(store.windowCurrent, true)
    store.dispose()
  })

  test("does not read while the runtime is unreachable after an invalidation", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(fake.windowCalls, 1)
    assert.notEqual(store.view.appliedOutputPosition, null)

    fake.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } } })
    await settle()

    assert.equal(fake.windowCalls, 1, "the read waits for the next attach")
    assert.equal(store.status, "ready", "what is resident stays readable meanwhile")
    assert.equal(store.view.blocks.length, 1)
    assert.equal(store.view.appliedOutputPosition, null, "a broken lane voids the live coverage the window proved")
    store.dispose()
  })

  test("watches its session before each lane's seed read, and lets the watch go when disposed", async () => {
    for (const knownEmpty of [false, true]) {
      const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
      const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, knownEmpty })
      await settle()
      fake.reconnect()
      await settle()
      assert.deepEqual(fake.calls.filter((call) => call !== "release s1").slice(0, 4), ["watch s1", "read outputWindow", "watch s1", "read outputWindow"], `knownEmpty ${knownEmpty}`)
      assert.equal(fake.lanes.watching(SESSION), true)
      store.dispose()
      assert.equal(fake.lanes.watching(SESSION), false)
    }
  })

  test("follows live output across lanes when the runtime sends deltas only for watched sessions", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 100 },
      { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2, snapshotPosition: 101 },
    ] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    try {
      await settle()
      fake.publish({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
      assert.deepEqual(store.view.blocks.map(blockIdentity), ["text:a", "text:b"])
      fake.reconnect()
      await settle()
      fake.publish({ type: "patch", patch: deltaPatch(102, 101, 2, textBlock("c")) })
      assert.deepEqual(store.view.blocks.map(blockIdentity), ["text:a", "text:b", "text:c"])
      assert.equal(store.windowCurrent, true)
    } finally { store.dispose() }
  })

  test("holds the streamed character count that the read served, each delta states, and a repave serves again", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, streamingOutputChars: 3 },
      { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, streamingOutputChars: 2 },
    ] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(store.view.streamingOutputChars, 3)

    const changes: string[] = []
    store.onChange((change) => changes.push(change.kind))
    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 101, prevPosition: 100, payload: { kind: "output.delta", delta: { blocks: [], streamingOutputChars: 9 } } } })
    assert.equal(store.view.streamingOutputChars, 9)
    assert.deepEqual(store.view.blocks, [textBlock("a")])
    assert.deepEqual(changes, ["deltas"])
    fake.emit({ type: "patch", patch: deltaPatch(102, 101, 1, textBlock("b")) })
    assert.equal(store.view.streamingOutputChars, 9, "a delta that does not state the count keeps it")

    fake.reconnect()
    await settle()
    assert.equal(store.view.streamingOutputChars, 2)
    store.dispose()
  })
})
