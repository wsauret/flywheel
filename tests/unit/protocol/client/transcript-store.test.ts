import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Schema } from "effect"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import type { HydratedOutputGroupChildrenBatch } from "../../../../src/protocol/transcript-protocol-types.js"
import { SESSION, textBlock, toolBlock, fakeConnection, deltaPatch, settle } from "./_transcript-store-fixtures.js"


function firstBlock(items: readonly FrontendOutputBlock[]): FrontendOutputBlock {
  const block = items[0]
  assert.ok(block)
  return block
}

describe("transcript store", () => {
  test("starts known-empty without seeding the cursor and applies held output after the first read", async () => {
    const gate = Promise.withResolvers<void>()
    const fake = fakeConnection({ windows: [{ blocks: [], startBlockIndex: 0, totalBlocks: 0 }] })
    const query = fake.connection.query
    fake.connection.query = async (request) => {
      const result = await query(request)
      if (request.type === "outputWindow") await gate.promise
      return result
    }
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, knownEmpty: true })

    assert.equal(store.status, "ready")
    assert.deepEqual(store.view.blocks, [])
    assert.equal(store.view.totalBlocks, 0)
    assert.equal(store.view.appliedOutputPosition, null)
    await settle()
    assert.equal(store.status, "ready", "the in-flight first read does not reopen loading")
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 0, textBlock("live")) })
    assert.deepEqual(store.view.blocks, [], "the unseeded intake holds live output")

    gate.resolve()
    await settle()

    assert.deepEqual(store.view.blocks, [textBlock("live")])
    assert.equal(store.view.appliedOutputPosition, 101)
    store.dispose()
  })

  test("hydrates user image bodies once without delaying transcript recovery", async () => {
    const block = { kind: "userMessage" as const, id: "u1", content: "[Image #1]", timestamp: 0, pending: false, injected: false, imageCount: 1 }
    const body = { blockId: "userMessage:u1", images: [{ mediaType: "image/png", data: "aGk=" }] }
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<typeof body>()
    const requested: string[] = []
    const fake = fakeConnection({ windows: [{ blocks: [block], startBlockIndex: 0, totalBlocks: 1 }], body: async (id) => {
      requested.push(id)
      entered.resolve()
      return response.promise
    } })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.deepEqual(requested, [])
    const first = store.hydrateBody("u1")
    await entered.promise
    const second = store.hydrateBody("u1")
    fake.reconnect()
    const recovery = store.refresh()
    try {
      assert.equal(fake.windowCalls, 2, "recovery must start before the image body returns")
      await recovery
      assert.deepEqual(store.view.bodies, {})
      response.resolve(body)
      await Promise.all([first, second])
      assert.deepEqual(requested, ["userMessage:u1"])
      assert.deepEqual(store.view.bodies["u1"], body)
      await store.hydrateBody("u1")
      assert.deepEqual(requested, ["userMessage:u1"])
    } finally {
      response.resolve(body)
      await Promise.all([first, second, recovery])
      store.dispose()
    }
  })
  test("refreshes a missing image row without caching a missing body", async () => {
    const old = { kind: "userMessage" as const, id: "temporary", content: "[Image #1]", timestamp: 0, pending: false, injected: false, imageCount: 1 }
    const current = { ...old, id: "committed" }
    const body = { blockId: "userMessage:committed", images: [{ mediaType: "image/png", data: "aGk=" }] }
    const requested: string[] = []
    const diagnostics: string[] = []
    const fake = fakeConnection({ windows: [
      { blocks: [old], startBlockIndex: 0, totalBlocks: 1 },
      { blocks: [current], startBlockIndex: 0, totalBlocks: 1 },
    ], body: async (id) => {
      requested.push(id)
      return id === "userMessage:temporary" ? { blockId: id, missing: true as const } : body
    } })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (message) => diagnostics.push(message) })
    try {
      await settle()
      await store.hydrateBody(old.id)
      assert.deepEqual(store.view.blocks, [current])
      assert.deepEqual(store.view.bodies, {})
      await store.hydrateBody(current.id)
      assert.deepEqual(store.view.bodies[current.id], body)
      assert.deepEqual(requested, ["userMessage:temporary", "userMessage:committed"])
      assert.deepEqual(diagnostics, [])
    } finally { store.dispose() }
  })

  test("global recovery keeps old content and does not duplicate delayed text already in the snapshot", async () => {
    const fake = fakeConnection({ windows: [
      { blocks: [textBlock("a", "a")], startBlockIndex: 0, totalBlocks: 1 },
      { blocks: [textBlock("a", "abc")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 101 },
    ] })
    const gate = Promise.withResolvers<void>()
    const captured = Promise.withResolvers<void>()
    const query = fake.connection.query
    fake.connection.query = async (request) => {
      const result = await query(request)
      if (fake.windowCalls === 2) { captured.resolve(); await gate.promise }
      return result
    }
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    fake.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 101, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
    await captured.promise
    assert.deepEqual(store.view.blocks, [textBlock("a", "a")])
    for (const [position, contentOffset, text] of [[102, 1, "b"], [103, 2, "c"]] as const) {
      fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position, prevPosition: position - 1, payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset, text }] } } } })
    }
    gate.resolve()
    await settle()
    assert.deepEqual(store.view.blocks, [textBlock("a", "abc")])
    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 104, prevPosition: 103, payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 3, text: "d" }] } } } })
    assert.deepEqual(store.view.blocks, [textBlock("a", "abcd")])
    store.dispose()
  })

  test("installs authoritative replacement blocks and hydrated bodies", async () => {
    const resident = { ...toolBlock("completed"), mutation: { version: 1 as const, files: [], omissions: [] } }
    const incoming = { ...toolBlock("completed", "authoritative"), presentation: { name: "Updated", detail: "authoritative" } }
    const body = { blockId: "tool:call-1", content: "full body" }
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<typeof body>()
    const diagnostics: string[] = []
    let reads = 0
    const fake = fakeConnection({ windows: [
      { blocks: [resident], startBlockIndex: 0, totalBlocks: 1 },
      { blocks: [incoming], startBlockIndex: 0, totalBlocks: 1 },
    ], body: async () => {
      if (++reads !== 2) return body
      entered.resolve()
      return response.promise
    } })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (message) => diagnostics.push(message) })
    await settle()
    await store.hydrateBody("call-1")
    assert.deepEqual(store.view.bodies["call-1"], body)
    await store.jumpToLatest()
    assert.deepEqual(store.view.blocks, [incoming])
    const hydration = store.hydrateBody("call-1")
    await entered.promise
    const latest = { ...incoming, content: "latest" }
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 0, latest) })
    response.reject(new Error("the requested owner was replaced"))
    try {
      await hydration
      assert.deepEqual(diagnostics, [])
      assert.equal(store.view.bodies["call-1"], undefined)
      await store.hydrateBody("call-1")
      assert.deepEqual(store.view.bodies["call-1"], body)
    } finally {
      response.resolve(body)
      await hydration
      store.dispose()
    }
  })

  test("reconciles hydrated prefixes with live group children and proposal updates", async () => {
    const prefix = { ...toolBlock("completed"), id: "prefix" }
    const pending = toolBlock("streaming")
    const completed = toolBlock("completed", "done")
    const added = { ...toolBlock("streaming"), id: "added" }
    const group: Extract<FrontendOutputBlock, { kind: "agentGroup" }> = { kind: "agentGroup", containerKind: "subagent", id: "g", toolUseId: "g", description: "Test agent", children: [pending], totalToolCount: 2, status: "active", timestamp: 0, label: "Agent" }
    let resolve!: (batch: HydratedOutputGroupChildrenBatch) => void
    const fake = fakeConnection({ windows: [{ blocks: [group], startBlockIndex: 0, totalBlocks: 1 }], group: () => new Promise((done) => { resolve = done }) })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const hydration = store.hydrateGroup("g")
    await settle()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 0, { ...group, children: [completed, added], totalToolCount: 3 }) })
    resolve({ groups: [{ groupBlockId: blockIdentity(group), children: [prefix, pending], totalChildren: 2, contentBytes: 0 }], contentBytes: 0 })
    await hydration
    assert.deepEqual(store.view.groups["g"], { children: [prefix, completed, added], total: 3 })
    const proposal = { proposedDiff: { files: [], unavailable: "malformed" as const } }
    fake.emit({ type: "patch", patch: { cursor: outputCursor(SESSION), position: 102, prevPosition: 101, payload: { kind: "output.delta", delta: {
      visibleMessageCount: 0,
      blocks: [{ kind: "upsert", index: 0, blockId: blockIdentity(group), block: { ...group, children: [{ ...added, status: "completed" }], totalToolCount: 3 } }],
      streamingToolTextOps: [{ kind: "set", toolUseId: "added", entry: proposal }],
    } } } })
    assert.deepEqual(store.view.groups["g"]?.children.map((child) => [child.id, child.status]), [["prefix", "completed"], ["call-1", "completed"], ["added", "completed"]])
    assert.deepEqual(store.view.streamingToolText.added, proposal)
    store.dispose()
  })
  test("keeps the groups map by reference across deltas that fold no group", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const groups = store.view.groups
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
    assert.equal(store.view.blocks.length, 2)
    assert.equal(store.view.groups, groups)
    store.dispose()
  })
  test("keeps ordered tail inserts incremental and repaves when a later insert displaces one", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const changes: Parameters<Parameters<typeof store.onChange>[0]>[0][] = []
    store.onChange((change) => { changes.push(change) })

    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 101, prevPosition: 100,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 3, blocks: [
        { kind: "insert", index: 1, blockId: "text:b", block: textBlock("b") },
        { kind: "insert", index: 2, blockId: "text:c", block: textBlock("c") },
      ] } },
    } })
    const appended = changes.at(-1)
    assert.equal(appended?.kind, "deltas")
    if (appended?.kind !== "deltas") throw new Error("expected delta change")
    assert.equal(appended.structural, false)
    assert.deepEqual(appended.replaced.map(({ localIndex }) => localIndex), [1, 2])

    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 102, prevPosition: 101,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 5, blocks: [
        { kind: "insert", index: 3, blockId: "text:d", block: textBlock("d") },
        { kind: "insert", index: 3, blockId: "text:e", block: textBlock("e") },
      ] } },
    } })
    const displaced = changes.at(-1)
    assert.equal(displaced?.kind, "deltas")
    if (displaced?.kind !== "deltas") throw new Error("expected delta change")
    assert.equal(displaced.structural, true)
    assert.deepEqual(store.view.blocks.map((block) => "id" in block ? block.id : ""), ["a", "b", "c", "e", "d"])
    store.dispose()
  })
  test("keeps insert redelivery incremental without growing the total", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    const changes: Parameters<Parameters<typeof store.onChange>[0]>[0][] = []
    store.onChange((change) => { changes.push(change) })

    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 0, textBlock("a", "refreshed")) })

    const change = changes.at(-1)
    assert.equal(change?.kind, "deltas")
    if (change?.kind !== "deltas") throw new Error("expected delta change")
    assert.equal(change.structural, false)
    assert.equal(change.replaced[0]?.prior?.kind, "text")
    assert.equal(store.view.totalBlocks, 1)
    assert.deepEqual(store.view.blocks, [textBlock("a", "refreshed")])
    store.dispose()
  })
  test("keeps truncation and resident head drops structural", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 2 })
    await settle()
    const changes: Parameters<Parameters<typeof store.onChange>[0]>[0][] = []
    store.onChange((change) => { changes.push(change) })

    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 2, textBlock("c")) })
    const dropped = changes.at(-1)
    assert.equal(dropped?.kind, "deltas")
    if (dropped?.kind !== "deltas") throw new Error("expected delta change")
    assert.equal(dropped.structural, true)
    assert.equal(store.view.startBlockIndex, 1)
    assert.deepEqual(store.view.blocks, [textBlock("b"), textBlock("c")])

    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 102, prevPosition: 101,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 1, truncateTo: 1, blocks: [] } },
    } })
    const truncated = changes.at(-1)
    assert.equal(truncated?.kind, "deltas")
    if (truncated?.kind !== "deltas") throw new Error("expected delta change")
    assert.equal(truncated.structural, true)
    store.dispose()
  })

  test("applies a live delta onto the seeded window", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()

    assert.equal(store.view.appliedOutputPosition, 100)
    const publications: Array<{ ids: string[]; position: number | null }> = []
    store.onChange(() => publications.push({
      ids: store.view.blocks.map((block) => ("id" in block ? block.id : "")),
      position: store.view.appliedOutputPosition,
    }))
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "b"])
    assert.equal(store.view.totalBlocks, 2)
    assert.equal(store.view.appliedOutputPosition, 101)
    assert.deepEqual(publications, [{ ids: ["a", "b"], position: 101 }], "bytes and their covered position publish together")
    store.dispose()
  })

  for (const detached of [false, true]) test(`keeps one tool row through incremental output, settlement, echo, and reload (${detached ? "detached" : "following"})`, async () => {
    const pending = toolBlock("streaming")
    const completed = toolBlock("completed", "settled output")
    const fake = fakeConnection({
      windows: [
        {
          blocks: [pending],
          startBlockIndex: 0,
          totalBlocks: 1,
          streamingToolText: { "call-1": { content: "first chunk", filetype: "text" } },
        },
        { blocks: [completed], startBlockIndex: 0, totalBlocks: detached ? 2 : 1, hasAfter: detached, snapshotPosition: 104,
          membership: [{ blockId: "tool:call-1", index: 0 }] },
      ],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 1,
      reader: () => ({ following: !detached, blockIds: ["tool:call-1"] }) })
    await settle()
    if (detached) fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("unseen")) })
    const position = detached ? 102 : 101

    const identity = blockIdentity(firstBlock(store.view.blocks))
    const messageCount = store.view.visibleMessageCount
    assert.equal(identity, "tool:call-1")
    assert.equal(store.view.streamingToolText["call-1"]?.content, "first chunk")

    fake.emit({
      type: "patch",
      patch: {
        cursor: outputCursor(SESSION),
        position,
        prevPosition: position - 1,
        payload: {
          kind: "output.delta",
          delta: { blocks: [], streamingToolTextOps: [{ kind: "edit", toolUseId: "call-1", edits: [{ kind: "append", path: ["content"], offset: 11, text: "\nsecond chunk" }] }] },
        },
      },
    })
    assert.equal(store.view.blocks.length, 1)
    assert.equal(blockIdentity(firstBlock(store.view.blocks)), identity)
    assert.equal(store.view.streamingToolText["call-1"]?.content, "first chunk\nsecond chunk")
    assert.equal(store.view.visibleMessageCount, messageCount)

    fake.emit({
      type: "patch",
      patch: {
        cursor: outputCursor(SESSION),
        position: position + 1,
        prevPosition: position,
        payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{ kind: "upsert", index: 0, blockId: "tool:call-1", block: completed }], streamingToolTextOps: [{ kind: "remove", toolUseId: "call-1" }] } },
      },
    })
    assert.deepEqual(store.view.blocks, [completed])
    assert.equal(blockIdentity(firstBlock(store.view.blocks)), identity)
    assert.deepEqual(store.view.streamingToolText, {})
    assert.equal(fake.windowCalls, 1, "ordinary output deltas need no client reconciliation read")

    fake.emit({ type: "patch", patch: deltaPatch(position + 2, position + 1, 0, completed) })
    assert.deepEqual(store.view.blocks, [completed])
    assert.equal(store.view.blocks.length, 1, "the echoed insert refreshes its stable row instead of duplicating it")
    assert.equal(fake.windowCalls, 1)

    fake.reconnect()
    await settle()
    assert.deepEqual(store.view.blocks, [completed])
    assert.equal(blockIdentity(firstBlock(store.view.blocks)), identity)
    assert.equal(fake.windowCalls, 2, "reload reads the authoritative destination once")
    store.dispose()
  })

  test("ignores a delta already covered by the seed rather than double applying", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 100 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()

    // Position 100 is the position the window was answered from.
    fake.emit({ type: "patch", patch: deltaPatch(100, 99, 1, textBlock("b")) })
    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a"])
    store.dispose()
  })

  test("installs the authoritative reconnect status and proposal", async () => {
    const mutationEvidence = await (await import("../../../../src/infra/mutation-evidence.js")).buildMutationEvidence([], async () => {})
    const canonical: FrontendToolEntry = {
      kind: "tool", id: "write-1", name: "write", presentation: { name: "Write", detail: "a.ts" },
      status: "completed", timestamp: 1, fileChangeKind: "create", mutationEvidence,
    }
    const proposal: FrontendToolEntry = {
      kind: "tool", id: "write-1", name: "write", presentation: { name: "Write", detail: "a.ts" },
      status: "interrupted", timestamp: 1, fileChangeKind: "create",
      proposedDiff: { files: [{ id: "file", path: "a.ts", action: "add", hunks: [] }] },
    }
    const fake = fakeConnection({
      windows: [
        { blocks: [canonical], startBlockIndex: 0, totalBlocks: 1 },
        { blocks: [proposal], startBlockIndex: 0, totalBlocks: 1, snapshotPosition: 200 },
      ],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()

    fake.reconnect()
    await settle()

    assert.deepEqual(store.view.blocks, [proposal])
    store.dispose()
  })

  test("pages older blocks in front of the resident window", async () => {
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("c")], startBlockIndex: 2, totalBlocks: 3, hasBefore: true }],
      ranges: [{ blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(store.view.hasBefore, true)

    assert.equal(await store.loadOlder(), true)
    assert.deepEqual(store.view.blocks.map((b) => ("id" in b ? b.id : "")), ["a", "b", "c"])
    assert.equal(store.view.startBlockIndex, 0)
    assert.equal(store.view.hasBefore, false)
    store.dispose()
  })

  test("does not read again when nothing is older", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1, hasBefore: false }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(await store.loadOlder(), false)
    assert.equal(store.view.blocks.length, 1)
    store.dispose()
  })

  test("reports a transcript it could not read, after its bounded retries, instead of rendering an empty one", async () => {
    const fake = fakeConnection({})
    let reads = 0
    // A window the client cannot decode: its diagnostic names the block, never its content.
    fake.connection.query = async () => {
      reads += 1
      Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.Literal("text") }))({ kind: "workflowRoster", said: "model-written" })
      throw new Error("the window decoded")
    }
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, recoveryBackoff: { baseMs: 0, maxMs: 0, factor: 1 }, recoveryMaxAttempts: 3 })
    // The retries wait on zero-length timers, which settle behind the immediate queue.
    for (let turn = 0; turn < 10 && store.status !== "recovery-failed"; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 5) })
    assert.equal(store.status, "recovery-failed")
    assert.equal(store.unavailable?.message, "Could not read this session's transcript.")
    assert.equal(store.unavailable?.diagnostic, 'Expected "text"\n  at ["kind"]')
    assert.equal(reads, 3)
    store.dispose()
  })

  // A client keeps a store resident across opens, so an open is the one
  // moment that reads a transcript the store could not show again.
  for (const { first, reads } of [
    { first: { blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }, reads: 1 },
    { first: { blocks: [], startBlockIndex: 0, totalBlocks: 0 }, reads: 1 },
    { first: { blocks: [], startBlockIndex: 0, totalBlocks: 2 }, reads: 2 },
    { first: { blocks: [], startBlockIndex: 0, totalBlocks: 0, visibleMessageCount: 1 }, reads: 2 },
    { first: { blocks: [], startBlockIndex: 0, totalBlocks: 0, unavailable: { title: "Unavailable", message: "Unavailable", diagnostic: "Unavailable" } }, reads: 2 },
  ]) test(`an open after a read of ${first.blocks.length} blocks, ${first.totalBlocks} total, ${first.visibleMessageCount ?? first.totalBlocks} messages, ${first.unavailable ? "unavailable" : "ok"} reads ${reads - 1} more`, async () => {
    const fake = fakeConnection({ windows: [first, { blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, totalBlocks: 2 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    try {
      await settle()
      const shown = store.view.blocks
      await store.open()
      assert.equal(fake.windowCalls, reads)
      assert.equal(store.status, "ready")
      if (reads === 1) assert.equal(store.view.blocks, shown)
      else assert.deepEqual(store.view.blocks, [textBlock("a"), textBlock("b")])
    } finally { store.dispose() }
  })


  test("shrinks the total when a delta truncates the transcript", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a"), textBlock("b"), textBlock("c")], startBlockIndex: 0, totalBlocks: 3 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    assert.equal(store.view.totalBlocks, 3)

    // A repave: the runtime rewound the transcript. Taking the max of the old
    // and new totals would leave the count permanently too high.
    fake.emit({
      type: "patch",
      patch: {
        cursor: outputCursor(SESSION),
        position: 101,
        prevPosition: 100,
        payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [], truncateTo: 1 } },
      },
    })
    assert.equal(store.view.blocks.length, 1)
    assert.equal(store.view.totalBlocks, 1)
    assert.equal(store.view.visibleMessageCount, 1, "the authority can replace the scalar downward")
    store.dispose()
  })

  test("keeps the total stable when an older page is prepended", async () => {
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("c")], startBlockIndex: 2, totalBlocks: 3, hasBefore: true }],
      ranges: [{ blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    await store.loadOlder()
    assert.equal(store.view.totalBlocks, 3, "paging backwards reveals blocks, it does not add any")

    // And a later insert still lands at the true end rather than past it.
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 3, textBlock("d")) })
    assert.equal(store.view.totalBlocks, 4)
    store.dispose()
  })


  test("anchors an older page on the block's durable identity, not its raw id", async () => {
    // The runtime resolves a block anchor through `blockIdentity`, which is the
    // kind-prefixed form. A raw id matches nothing, the server answers ok with
    // zero blocks, and paging backwards silently never works.
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("c")], startBlockIndex: 2, totalBlocks: 3, hasBefore: true }],
      ranges: [{ blocks: [textBlock("a"), textBlock("b")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    await store.loadOlder()
    assert.deepEqual(fake.anchors, ["text:c"])
    store.dispose()
  })

  test("says so when an older page comes back empty instead of staying silent", async () => {
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("c")], startBlockIndex: 2, totalBlocks: 3, hasBefore: true }],
      ranges: [{ blocks: [], startBlockIndex: 0, hasBefore: true }],
    })
    const diagnostics: string[] = []
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, onDiagnostic: (m) => diagnostics.push(m) })
    await settle()
    await store.loadOlder()
    assert.ok(diagnostics.some((m) => m.includes("empty")), "an anchor that matched nothing is reported")
    store.dispose()
  })

  test("keeps the page it just fetched when the window is full, and detaches from the tail", async () => {
    const older = Array.from({ length: 40 }, (_, i) => textBlock(`o${i}`))
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("tail")], startBlockIndex: 40, totalBlocks: 41, hasBefore: true }],
      ranges: [{ blocks: [...older, textBlock("tail")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 10 })
    await settle()
    assert.equal(store.view.atTail, true)

    await store.loadOlder()

    assert.equal(store.view.blocks.length, 10, "the window stays bounded")
    // Trimming the head would discard the page just fetched, which is what made
    // paging a no-op the moment the window filled.
    const first = store.view.blocks[0]
    assert.equal(first && "id" in first ? first.id : "", "o0", "the fetched page is what is resident")
    assert.equal(store.view.atTail, false, "the window no longer reaches the live end")
    assert.equal(store.view.appliedOutputPosition, null, "a detached window does not claim live output coverage")
    assert.equal(store.view.hasNewer, true, "the trimmed live end is newer output the reader can page to")
    store.dispose()
  })

  test("does not splice live output into a window that is reading history", async () => {
    const older = Array.from({ length: 40 }, (_, i) => textBlock(`o${i}`))
    const fake = fakeConnection({
      windows: [{ blocks: [textBlock("tail")], startBlockIndex: 40, totalBlocks: 41, hasBefore: true }],
      ranges: [{ blocks: [...older, textBlock("tail")], startBlockIndex: 0, hasBefore: false }],
    })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION, maxResidentBlocks: 10 })
    await settle()
    await store.loadOlder()
    const residentBlocks = store.view.blocks
    const residentBodies = store.view.bodies
    const residentGroups = store.view.groups
    const changes: string[] = []
    store.onChange((change) => changes.push(change.kind))

    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 41, textBlock("live")) })
    fake.emit({ type: "patch", patch: {
      cursor: outputCursor(SESSION), position: 102, prevPosition: 101,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 43, blocks: [], streamingOutputChars: 12 } },
    } })

    assert.equal(store.view.blocks, residentBlocks, "the present is not spliced into the past")
    assert.equal(store.view.bodies, residentBodies)
    assert.equal(store.view.groups, residentGroups)
    assert.equal(store.view.hasNewer, true, "but the reader is told there is more")
    assert.equal(store.view.visibleMessageCount, 43)
    assert.equal(store.view.streamingOutputChars, 12, "the live count moves while the reader reads history")
    assert.deepEqual(changes, ["status", "status"], "each changed authoritative count notifies while detached")
    store.dispose()
  })

  test("stops applying after dispose", async () => {
    const fake = fakeConnection({ windows: [{ blocks: [textBlock("a")], startBlockIndex: 0, totalBlocks: 1 }] })
    const store = createTranscriptStore({ connection: fake.connection, sessionId: SESSION })
    await settle()
    store.dispose()
    fake.emit({ type: "patch", patch: deltaPatch(101, 100, 1, textBlock("b")) })
    assert.equal(store.view.blocks.length, 1)
  })

})
