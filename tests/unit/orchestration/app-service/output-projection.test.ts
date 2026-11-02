import { describe, expect, test } from "bun:test"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import type { SessionEntry, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import type { OutputChangeBatch } from "../../../../src/infra/output/output-block-delta.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js"
import { applyStreamingToolTextOps } from "../../../../src/protocol/client/streaming-text-edits.js"
import { applyOutputDelta, buildBlockIndex } from "../../../../src/protocol/client/transcript-delta.js"
import { chatEntry, fakeSessionStore } from "./app-service-doubles.js"
import { appendChange, batch, deltas, fakeOutputStore, insertChange, outputProjectionRuntime, sink, textBlock, upsertChange } from "./_output-projection-fixtures.js"
import { createChatSubmissions } from "../../../../src/protocol/client/chat-submissions.js"
import { handleSessionSend } from "../../../../src/orchestration/app-service/session-send.js"
import { runtimeDispatchResultSchema } from "../../../../src/protocol/runtime-dispatch-result-schemas.js"
import { Schema } from "effect"

const runtime = outputProjectionRuntime()

// Solid schedules effects on the microtask/timer queue; a 0ms tick lets the
// observer's per-session effect run after a store mutation.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("output projection", () => {
  test("a message to a workflow agent stays pending until its ordinary transcript confirms the submission", async () => {
    const codec = runtimeDispatchResultSchema("session.send")
    const submissions = createChatSubmissions({
      lanes: { onLane: () => () => {} },
      dispatch: async (sessionId, input) => {
        const result = await handleSessionSend({ type: "session.send", sessionId, input }, {
          supervisor: { sessionKind: async () => "workflow-agent", sendChat: async () => ({ ok: true }) },
          modules: { send: async () => ({ ok: true }) },
        })
        // Both ends use the registered codec, which must preserve the receipt.
        expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual(result)
        return result
      },
    })
    try {
      await submissions.send("flow", { text: "focus" })
      submissions.observe("flow", [], { startBlockIndex: 0 })
      expect(submissions.pending("flow")).toHaveLength(1)
      const submissionIds = submissions.pending("flow")[0]?.input.submissionIds
      submissions.observe("flow", [{ kind: "userMessage", id: "delivered", content: "focus", timestamp: 1, pending: false, injected: false, submissionIds }], { startBlockIndex: 0 })
      expect(submissions.pending("flow")).toHaveLength(0)
    } finally {
      submissions.dispose()
    }
  })
  test.each(["x".repeat(4096), "😀é".repeat(682) + "abcd"])("partitions live execution output losslessly after preview (%#. case)", async (content) => {
    const f = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: f.store, shipped: s.shipped })
    await flush()
    let state: SessionEntry["streamingToolText"] = {}
    const maps: SessionEntry["streamingToolText"][] = [{ tool: { content: "preview" } }, { tool: { content } }, {}, { tool: { content } }]
    for (const next of maps) {
      s.patches.length = 0
      f.changeStreamingToolText(next, ["tool"])
      await flush()
      for (const [index, patch] of s.patches.entries()) {
        expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThan(4096)
        if (patch.payload.kind !== "output.delta") continue
        if (index > 0) {
          expect(patch.payload.delta.blocks).toEqual([])
          expect(patch.payload.delta.visibleMessageCount).toBeUndefined()
        }
        const applied = applyStreamingToolTextOps(state, patch.payload.delta.streamingToolTextOps ?? [])
        expect(applied).not.toBeNull()
        if (!applied) throw new Error("expected applicable streaming text operations")
        state = applied
      }
      expect(state).toEqual(next)
    }
    projection.dispose()
  })
  test("a held session does not block another session and preserves its own delta order", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const projection = createOutputProjection({
      sessionStore: store, shipped: s.shipped,
      projectBlock: async (sessionId, block) => {
        if (sessionId === "a") { entered.resolve(); await held.promise }
        return block
      },
    })
    try {
      store.openSessionRuntime({ sessionId: "a", conversationId: "conv-a" })
      store.openSessionRuntime({ sessionId: "b", conversationId: "conv-b" })
      const first = textBlock("first")
      store.updateChatEntry("a", { outputBlocks: [first], visibleMessageCountSuffix: 0, outputChanges: batch([insertChange(0, first)]) })
      await entered.promise
      store.updateChatEntry("a", { outputBlocks: [{ ...first, content: "first!" }], visibleMessageCountSuffix: 0, outputChanges: batch([appendChange(0, "t-first", 5, "!")]) })
      const second = textBlock("second")
      store.updateChatEntry("b", { outputBlocks: [second], visibleMessageCountSuffix: 0, outputChanges: batch([insertChange(0, second)]) })
      let delivered = false
      const independent = projection.flush("b").then(() => { delivered = true })
      await flush()
      expect(delivered).toBe(true)
      expect(deltas(s.patches, "b")).toHaveLength(1)
      expect(deltas(s.patches, "a")).toHaveLength(0)
      held.resolve()
      await independent
      await projection.flush("a")
      expect(deltas(s.patches, "a").flatMap((delta) => delta.blocks).map((block) => block.kind)).toEqual(["insert", "append-content"])
    } finally {
      held.resolve()
      projection.dispose()
    }
  })

  test("mints an output.delta on the session's output cursor when store output mutates", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-1", conversationId: "conv-1" })
    await flush()
    s.patches.length = 0 // drop the initial empty-view mount publish

    store.updateChatEntry("chat-1", { outputBlocks: [textBlock("hi")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("hi"))]) })
    await flush()

    const outputDeltas = deltas(s.patches, "chat-1")
    expect(outputDeltas).toHaveLength(1)
    expect(outputDeltas[0]!.visibleMessageCount).toBe(1)
    expect(outputDeltas[0]!.blocks).toEqual([{ kind: "upsert", index: 0, blockId: "text:t-hi", block: textBlock("hi") }])
    expect(s.patches[0]!.cursor).toEqual({ scope: "session", domain: "output", sessionId: "chat-1" })
    projection.dispose()
  })


  test("text growth publishes append-content instead of a whole view", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-append", conversationId: "conv-append" })
    store.updateChatEntry("chat-append", { outputBlocks: [textBlock("h")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("h"))]) })
    await flush()
    s.patches.length = 0

    store.updateChatEntry("chat-append", { outputBlocks: [{ ...textBlock("h"), content: "hello" }], visibleMessageCountSuffix: 1, outputChanges: batch([appendChange(0, "t-h", 1, "ello")]) })
    await flush()

    expect(deltas(s.patches, "chat-append")[0]!.blocks).toEqual([{ kind: "append-content", index: 0, blockId: "text:t-h", contentOffset: 1, text: "ello" }])
    expect(deltas(s.patches, "chat-append")[0]!.visibleMessageCount).toBe(1)
    projection.dispose()
  })

  test.each([3, 30])("a burst of stream deltas ships one patch per session that ends at the final text (%i sessions)", async (sessionCount) => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    const ids = Array.from({ length: sessionCount }, (_, index) => `burst-${index}`)
    for (const id of ids) {
      store.openSessionRuntime({ sessionId: id, conversationId: `conv-${id}` })
      store.updateChatEntry(id, { outputBlocks: [textBlock("h")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("h"))]) })
    }
    await flush()
    s.patches.length = 0

    const deltaCount = 20
    for (const id of ids) {
      let content = "h"
      for (let delta = 0; delta < deltaCount; delta += 1) {
        const offset = content.length
        content += `${delta}.`
        store.updateChatEntry(id, { outputBlocks: [{ ...textBlock("h"), content }], visibleMessageCountSuffix: 1, outputChanges: batch([appendChange(0, "t-h", offset, `${delta}.`)]) })
      }
    }
    await flush()

    const expected = "h" + Array.from({ length: deltaCount }, (_, delta) => `${delta}.`).join("")
    for (const id of ids) {
      const shipped = deltas(s.patches, id)
      expect(shipped).toHaveLength(1)
      expect(shipped[0]!.blocks).toEqual([{ kind: "append-content", index: 0, blockId: "text:t-h", contentOffset: 1, text: expected.slice(1) }])
    }
    projection.dispose()
  })

  test("a mid-list insert ships as one insert change, kind and order preserved", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-insert", conversationId: "conv-insert" })
    store.updateChatEntry("chat-insert", { outputBlocks: [textBlock("a"), textBlock("queued")], visibleMessageCountSuffix: 2, outputChanges: batch([upsertChange(0, textBlock("a")), upsertChange(1, textBlock("queued"))]) })
    await flush()
    s.patches.length = 0

    // One drain carrying a replace and a mid-list insert must ship both
    // changes with their kinds and their replay order intact.
    const replaced = { ...textBlock("a"), content: "a!" }
    store.updateChatEntry("chat-insert", { outputBlocks: [replaced, textBlock("ins"), textBlock("queued")], visibleMessageCountSuffix: 3, outputChanges: batch([upsertChange(0, replaced), insertChange(1, textBlock("ins"))]) })
    await flush()

    expect(deltas(s.patches, "chat-insert")[0]!.blocks).toEqual([
      { kind: "edit", index: 0, blockId: "text:t-a", edits: [{ kind: "append", path: ["content"], offset: 1, text: "!" }] },
      { kind: "insert", index: 1, blockId: "text:t-ins", block: textBlock("ins") },
    ])
    projection.dispose()
  })

  test("reactivated durable base seeds without reset/truncate and live changes keep absolute indexes", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    const base = [textBlock("old")]

    store.openSessionRuntime({ sessionId: "chat-reactivated", conversationId: "conv-reactivated", priorBlocks: base, outputSequenceStart: 0 })
    await flush()
    expect(deltas(s.patches, "chat-reactivated")).toHaveLength(0)

    store.updateChatEntry("chat-reactivated", { outputBlocks: [...base, textBlock("h")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(1, textBlock("h"))]) })
    await flush()
    const first = deltas(s.patches, "chat-reactivated").at(-1)!
    expect(first.blocks).toEqual([{ kind: "upsert", index: 1, blockId: "text:t-h", block: textBlock("h") }])
    expect(first).not.toHaveProperty("reset")
    expect(first.truncateTo).toBeUndefined()

    s.patches.length = 0
    store.updateChatEntry("chat-reactivated", { outputBlocks: [...base, { ...textBlock("h"), content: "hi" }], visibleMessageCountSuffix: 1, outputChanges: batch([appendChange(1, "t-h", 1, "i")]) })
    await flush()
    expect(deltas(s.patches, "chat-reactivated")[0]!.blocks).toEqual([{ kind: "append-content", index: 1, blockId: "text:t-h", contentOffset: 1, text: "i" }])
    projection.dispose()
  })

  test("a newly resident session publishes a rebase invalidation before its first delta", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    const base = [textBlock("old")]

    // Reactivation: the shell rebases absolute indexes onto the durable fold,
    // so any client window resident from the prior shell is void.
    store.openSessionRuntime({ sessionId: "chat-rebase", conversationId: "conv-rebase", priorBlocks: base, outputSequenceStart: 40 })
    store.updateChatEntry("chat-rebase", { outputBlocks: [...base, textBlock("h")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(1, textBlock("h"))]) })
    await flush()

    const patches = s.patches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === "chat-rebase")
    expect(patches[0]!.payload).toEqual({ kind: "runtime.invalidate", reason: "rebase" })
    expect(deltas(s.patches, "chat-rebase")).toHaveLength(1)

    // Residency event, not a per-revision one: later mutations publish no
    // further invalidation.
    s.patches.length = 0
    store.updateChatEntry("chat-rebase", { outputBlocks: [...base, { ...textBlock("h"), content: "hi" }], visibleMessageCountSuffix: 1, outputChanges: batch([appendChange(1, "t-h", 1, "i")]) })
    await flush()
    expect(s.patches.filter((patch) => patch.payload.kind === "runtime.invalidate")).toHaveLength(0)
    expect(deltas(s.patches, "chat-rebase")).toHaveLength(1)
    projection.dispose()
  })

  test("a shell reopened within one coalesced sync still publishes a rebase invalidation", async () => {
    // The store coalesces mutations into one microtask notification, so the
    // projection may never observe the session id absent between removal and
    // reopen, and a fresh shell restarts its revision counter. The entryEpoch
    // carries the rebase; id residency and revision cannot.
    const fake = fakeOutputStore([textBlock("old")])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    await projection.flush("chat-long")
    s.patches.length = 0

    // Same id, same revision, new incarnation: only the epoch reveals the swap.
    fake.reopen([upsertChange(0, textBlock("new"))])
    await projection.flush("chat-long")

    const invalidations = s.patches.filter((patch) => patch.payload.kind === "runtime.invalidate")
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]!.payload).toEqual({ kind: "runtime.invalidate", reason: "rebase" })
    expect(s.patches.indexOf(invalidations[0]!)).toBeLessThan(s.patches.findIndex((patch) => patch.payload.kind === "output.delta"))
    expect(deltas(s.patches, "chat-long")).toHaveLength(1)
    projection.dispose()
  })

  test("a metric-only mutation does not republish output", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-2", conversationId: "conv-2" })
    store.updateChatEntry("chat-2", { outputBlocks: [textBlock("a")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("a"))]) })
    await flush()
    s.patches.length = 0

    // tokens/cost carry no outputChanges, so nothing is queued to drain -- no
    // output delta is minted.
    store.updateChatEntry("chat-2", { tokens: 42, cost: 0.01 })
    await flush()

    expect(deltas(s.patches, "chat-2")).toHaveLength(0)
    projection.dispose()
  })

  test("stops publishing after dispose", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-3", conversationId: "conv-3" })
    await flush()
    projection.dispose()
    s.patches.length = 0

    store.updateChatEntry("chat-3", { outputBlocks: [textBlock("after dispose")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("after dispose"))]) })
    await flush()

    expect(deltas(s.patches, "chat-3")).toHaveLength(0)
  })

  test("flush drains only the requested session and forgets a requested missing entry", async () => {
    const first = chatEntry({ entryEpoch: 1, outputBlocks: () => [textBlock("first")], streamingToolText: {}, outputSequenceStart: 0 })
    const second = chatEntry({ entryEpoch: 1, outputBlocks: () => [textBlock("second")], streamingToolText: {}, outputSequenceStart: 0 })
    const entries = new Map<string, SessionEntry>([["first", first], ["second", second]])
    const revisions = new Map([["first", 1], ["second", 1]])
    const pending = new Map<string, OutputChangeBatch>([
      ["first", batch([upsertChange(0, textBlock("first"))])],
      ["second", batch([upsertChange(0, textBlock("second"))])],
    ])
    const calls = { allIds: 0, get: new Array<string>(), revision: new Array<string>(), drain: new Array<string>() }
    const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
    const base = fakeSessionStore(entries)
    const store: SessionStore = {
      ...base,
      allIds: () => {
        calls.allIds += 1
        return [...entries.keys()]
      },
      get: (id) => {
        calls.get.push(id)
        return entries.get(id)
      },
      revision: (id) => {
        calls.revision.push(id)
        return revisions.get(id) ?? 0
      },
      drainOutputChanges: (id) => {
        calls.drain.push(id)
        const changes = pending.get(id) ?? batch([])
        pending.set(id, batch([]))
        return changes
      },
      onChange(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    await projection.flush("first")
    s.patches.length = 0
    calls.allIds = 0
    calls.get.length = 0
    calls.revision.length = 0
    calls.drain.length = 0
    revisions.set("first", 2)
    revisions.set("second", 2)
    pending.set("first", batch([upsertChange(0, { ...textBlock("first"), content: "first!" })]))
    pending.set("second", batch([upsertChange(0, { ...textBlock("second"), content: "second!" })]))

    await projection.flush("first")

    expect(calls).toEqual({ allIds: 0, get: ["first"], revision: ["first"], drain: ["first"] })
    expect(deltas(s.patches, "first")).toHaveLength(1)
    expect(deltas(s.patches, "second")).toHaveLength(0)

    for (const listener of listeners) listener(undefined)
    await projection.flush("second")
    expect(deltas(s.patches, "second")).toHaveLength(1)

    entries.delete("first")
    await projection.flush("first")
    entries.set("first", first)
    revisions.set("first", 1)
    pending.set("first", batch([upsertChange(0, textBlock("first"))]))
    await projection.flush("first")
    expect(s.patches.at(-2)?.payload).toEqual({ kind: "runtime.invalidate", reason: "rebase" })
    expect(s.patches.at(-1)?.payload.kind).toBe("output.delta")

    projection.dispose()
    const patchCount = s.patches.length
    await projection.flush("first")
    expect(s.patches).toHaveLength(patchCount)
  })

  test("long-transcript streaming append reads the changed block once, not the whole array", async () => {
    const blocks = Array.from({ length: 5_000 }, (_, index) => textBlock(`block-${index}`))
    const fake = fakeOutputStore(blocks)
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    await projection.flush("chat-long")
    s.patches.length = 0
    fake.resetReads()

    fake.mutateLast("block-4999 plus")
    await projection.flush("chat-long")

    expect(deltas(s.patches, "chat-long")[0]!.blocks).toEqual([{ kind: "append-content", index: 4_999, blockId: "text:t-block-4999", contentOffset: 10, text: " plus" }])
    expect(fake.indexReads()).toBeLessThan(10)
    projection.dispose()
  })

  test("writes during asynchronous projection publish as the next batch in order", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const projected: string[] = []
    const projection = createOutputProjection({
      sessionStore: fake.store,
      shipped: s.shipped,
      projectBlock: async (_sessionId, block) => {
        if (block.kind !== "text") throw new Error("Expected text")
        projected.push(block.content)
        if (block.content === "first") {
          started.resolve()
          await release.promise
        }
        return block
      },
    })
    await projection.flush("chat-long")
    s.patches.length = 0
    const first = textBlock("first")
    fake.changeBlocks([first], [upsertChange(0, first)])
    await started.promise
    const second = { ...first, content: "second" }
    fake.changeBlocks([second], [upsertChange(0, second)])
    const pending = projection.flush("chat-long")
    expect(projected).toEqual(["first"])
    expect(deltas(s.patches, "chat-long")).toEqual([])
    release.resolve()
    await pending
    expect(projected).toEqual(["first", "second"])
    expect(deltas(s.patches, "chat-long").map((delta) => delta.blocks)).toEqual([
      [{ kind: "upsert", index: 0, blockId: "text:t-first", block: first }],
      [{ kind: "edit", index: 0, blockId: "text:t-first", edits: [{ kind: "assign", path: ["content"], value: "second" }] }],
    ])
    projection.dispose()
  })

  test("a failed projection resolves flush, invalidates the session's output, and later changes still publish", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({
      sessionStore: fake.store,
      shipped: s.shipped,
      projectBlock: async (_sessionId, block) => {
        if (block.kind === "text" && block.content === "unreadable") throw new Error("state read refused")
        return block
      },
    })
    await projection.flush("chat-long")
    s.patches.length = 0
    const unreadable = textBlock("unreadable")
    fake.changeBlocks([unreadable], [upsertChange(0, unreadable)])

    await projection.flush("chat-long")
    expect(s.patches.map((patch) => [patch.cursor, patch.payload])).toEqual([[outputCursor("chat-long"), { kind: "runtime.invalidate", reason: "rebase" }]])

    const readable = textBlock("readable")
    fake.changeBlocks([readable], [upsertChange(0, readable)])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long").map((delta) => delta.blocks)).toEqual([[{ kind: "upsert", index: 0, blockId: "text:t-readable", block: readable }]])
    projection.dispose()
  })

  test("a structural rewrite (fullResync) truncates to the base offset and re-upserts the tail", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-rewrite", conversationId: "conv-rewrite" })
    store.updateChatEntry("chat-rewrite", { outputBlocks: [textBlock("a"), textBlock("b")], visibleMessageCountSuffix: 2, outputChanges: batch([upsertChange(0, textBlock("a")), upsertChange(1, textBlock("b"))]) })
    await flush()
    s.patches.length = 0

    // Cap eviction / retraction / recall all degrade to fullResync: the write
    // site clears its pending changes and the projection re-sends the whole
    // current tail from the session's base offset instead of reindexing.
    store.updateChatEntry("chat-rewrite", { outputBlocks: [textBlock("replacement")], visibleMessageCountSuffix: 1, outputChanges: batch([], true) })
    await flush()

    const delta = deltas(s.patches, "chat-rewrite")[0]!
    expect(delta.truncateTo).toBe(0)
    expect(delta.visibleMessageCount).toBe(1)
    expect(delta.blocks).toEqual([{ kind: "upsert", index: 0, blockId: "text:t-replacement", block: textBlock("replacement") }])
    projection.dispose()
  })

  test("queued text append keeps its identity when context inserts before the ask row", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    const builder = new StructuredOutputBuilder()
    builder.onChange = () => {}
    store.openSessionRuntime({ sessionId: "chat-ask-context", conversationId: "conv-ask-context" })

    builder.pushStandaloneToolEntry({
      kind: "tool",
      id: "ask-1",
      name: "ask_user",
      presentation: { name: "Ask", detail: "Question" },
      timestamp: 1,
      status: "pending",
    })
    builder.pushText("Answer", 2, "answer-1")
    store.updateChatEntry("chat-ask-context", {
      outputBlocks: [...builder.getBlocks()],
      visibleMessageCountSuffix: builder.visibleMessageCountSuffix,
      outputChanges: builder.drainChanges(),
    })
    await flush()
    const client = {
      blocks: deltas(s.patches, "chat-ask-context")[0]!.blocks.map((change) => {
        if (change.kind === "append-content" || change.kind === "edit") throw new Error("Expected initial blocks")
        return change.block
      }),
      streamingToolText: {},
    }
    s.patches.length = 0

    builder.pushText(" text", 3, "answer-1")
    builder.insertTextBeforeTool("ask-1", "Context", 4, "context-1")
    store.updateChatEntry("chat-ask-context", {
      outputBlocks: [...builder.getBlocks()],
      visibleMessageCountSuffix: builder.visibleMessageCountSuffix,
      outputChanges: builder.drainChanges(),
    })
    await flush()

    const applied = applyOutputDelta(client, deltas(s.patches, "chat-ask-context")[0]!, buildBlockIndex(client.blocks))
    expect(applied).toBe(true)
    expect(client.blocks.map((block) => block.kind === "text" ? block.content : block.kind)).toEqual([
      "Context",
      "tool",
      "Answer text",
    ])
    projection.dispose()
  })

  test("does not reconstruct an initial delta without write-site changes", async () => {
    const fake = fakeOutputStore([textBlock("hi")])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    await projection.flush("chat-long")

    expect(deltas(s.patches, "chat-long")).toEqual([])
    projection.dispose()
  })

  test("publishes streaming tool text as the changes from the entry clients hold", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    s.patches.length = 0

    fake.changeStreamingToolText({ "tool-call-1": { content: "partial" } }, ["tool-call-1"])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [], streamingToolTextOps: [{ toolUseId: "tool-call-1", kind: "set", entry: { content: "partial" } }] }])

    s.patches.length = 0
    fake.changeStreamingToolText({ "tool-call-1": { content: "partial body" } }, ["tool-call-1"])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [], streamingToolTextOps: [{ toolUseId: "tool-call-1", kind: "edit", edits: [{ kind: "append", path: ["content"], offset: 7, text: " body" }] }] }])

    s.patches.length = 0
    fake.changeStreamingToolText({}, ["tool-call-1", "came-and-went"])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [], streamingToolTextOps: [{ toolUseId: "tool-call-1", kind: "remove" }, { toolUseId: "came-and-went", kind: "remove" }] }])
    projection.dispose()
  })

  test("one drain ships each block once, as the last copy it wrote", async () => {
    const first = { kind: "text", id: "t-first", content: "first", timestamp: 1 } as const satisfies AnyBlock
    const fake = fakeOutputStore([first])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    s.patches.length = 0
    const tool = (detail: string): AnyBlock => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status: "streaming", timestamp: 1 })
    const grown = { ...first, content: "first and more" }
    fake.changeBlocks([grown, tool("c")], [
      insertChange(1, tool("a")),
      upsertChange(1, tool("ab")),
      appendChange(0, first.id, 5, " and"),
      upsertChange(1, tool("abc")),
      upsertChange(0, { ...first, content: "first and" }),
      appendChange(0, first.id, 9, " more"),
    ])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")[0]?.blocks).toEqual([
      { kind: "insert", index: 1, blockId: "tool:call-1", block: tool("a") },
      { kind: "edit", index: 1, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 1, text: "bc" }] },
      { kind: "upsert", index: 0, blockId: "text:t-first", block: { ...first, content: "first and" } },
      { kind: "append-content", index: 0, blockId: "text:t-first", contentOffset: 9, text: " more" },
    ])
    projection.dispose()
  })

  test("bounded structural resync keeps absolute transcript coordinates", async () => {
    const seed = textBlock("seed")
    const live = textBlock("live")
    const fake = fakeOutputStore([seed, live], { sequenceStart: 40 })
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    await projection.flush("chat-long")

    expect(deltas(s.patches, "chat-long")).toEqual([])
    s.patches.length = 0

    const replacement = textBlock("replacement")
    fake.rewrite([seed, replacement])
    await projection.flush("chat-long")

    expect(deltas(s.patches, "chat-long")).toEqual([{
      visibleMessageCount: 2,
      blocks: [
        { kind: "upsert", index: 40, blockId: "text:t-seed", block: seed },
        { kind: "upsert", index: 41, blockId: "text:t-replacement", block: replacement },
      ],
      truncateTo: 40,
    }])
    projection.dispose()
  })
})
