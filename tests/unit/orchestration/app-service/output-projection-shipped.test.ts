import { describe, expect, test } from "bun:test"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import type { AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { applyOutputDelta, buildBlockIndex, type MutableOutputView } from "../../../../src/protocol/client/transcript-delta.js"
import { projectFrontendOutputBlock } from "../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import type { FrontendOutputBlock, FrontendToolStreamingText } from "../../../../src/protocol/app-service-types.js"
import type { HydratedOutputRange } from "../../../../src/protocol/transcript-protocol-types.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import { chatEntry } from "./app-service-doubles.js"
import type { CommandKeeper } from "../../../../src/orchestration/app-service/command-keeper.js"
import { appendChange, batch, deltas, fakeOutputStore, insertChange, outputProjectionRuntime, sink, textBlock, upsertChange } from "./_output-projection-fixtures.js"

const runtime = outputProjectionRuntime()

/** A tail read that served `blocks` from index 0. */
function servedRange(blocks: readonly FrontendOutputBlock[], streamingToolText: { readonly [toolUseId: string]: FrontendToolStreamingText } = {}, streamingOutputChars = 0): HydratedOutputRange {
  return { kind: "ok", consistencyToken: "read", anchor: { kind: "tail" }, window: { startBlockIndex: 0, endBlockIndex: blocks.length - 1, hasBefore: false, hasAfter: false, contentBytes: 0 }, blocks, streamingToolText, streamingOutputChars }
}

/** A client that takes the cursor position, as the app service does before
 *  it reads, installs what the owner served, and then applies every delta
 *  published after that position. */
async function clientRead(s: ReturnType<typeof sink>, read: () => Promise<HydratedOutputRange>) {
  const position = s.patches.length
  const served = await s.shipped.serve("chat-long", read, (range) => range)
  if (served.kind !== "ok") throw new Error("expected a served range")
  const client: MutableOutputView = { blocks: [...served.blocks], streamingToolText: { ...served.streamingToolText } }
  return {
    client,
    applyLater() {
      const blockIndex = buildBlockIndex(client.blocks)
      for (const delta of deltas(s.patches.slice(position), "chat-long")) expect(applyOutputDelta(client, delta, blockIndex)).toBe(true)
    },
  }
}

/** The output cursor ships each change as the smallest change from the copy
 *  the session's clients last received (`app-service/shipped-output.ts`). */
describe("output projection shipped copies", () => {
  test("a client applying every published delta holds the store's blocks and streaming text", async () => {
    const answer = textBlock("answer")
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    s.patches.length = 0
    const client: MutableOutputView = { blocks: [], streamingToolText: {} }
    const blockIndex = new Map<string, number>()
    const tool = (detail: string, status: "streaming" | "completed" = "streaming"): AnyBlock => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status, timestamp: 1 })
    const steps: Array<() => void> = [
      () => fake.changeBlocks([answer], [insertChange(0, answer)]),
      () => fake.changeBlocks([answer, tool("cat")], [insertChange(1, tool("cat"))]),
      () => fake.changeBlocks([answer, tool("cat <<EOF")], [upsertChange(1, tool("cat <<EOF"))]),
      () => fake.changeStreamingToolText({ w: { content: "ab", filetype: "ts" } }, ["w"]),
      () => fake.changeStreamingToolText({ w: { content: "abcd", filetype: "ts" } }, ["w"]),
      () => fake.changeBlocks([{ ...answer, content: "answer more" }, tool("cat <<EOF\nhello")], [appendChange(0, answer.id, 6, " more"), upsertChange(1, tool("cat <<EOF\nhello"))]),
      () => fake.changeBlocks([{ ...answer, content: "answer more" }, tool("cat <<EOF\nhello", "completed")], [upsertChange(1, tool("cat <<EOF\nhello", "completed"))]),
      () => fake.rewrite([{ ...answer, content: "answer more" }], {}),
    ]
    for (const step of steps) {
      step()
      await projection.flush("chat-long")
    }

    for (const delta of deltas(s.patches, "chat-long")) expect(applyOutputDelta(client, delta, blockIndex)).toBe(true)
    expect(client.blocks).toEqual([{ ...answer, content: "answer more" }])
    expect(client.streamingToolText).toEqual({})
    expect(deltas(s.patches, "chat-long").flatMap((delta) => delta.blocks.map((change) => change.kind))).toEqual(["insert", "insert", "edit", "append-content", "edit", "edit"])
    expect(deltas(s.patches, "chat-long").at(-1)).toEqual({ visibleMessageCount: 0, blocks: [], truncateTo: 1, streamingToolTextOps: [{ toolUseId: "w", kind: "remove" }] })
    projection.dispose()
  })

  test("the streamed character count ships with a change only when it changed, and a count change alone ships with no block coordinates", async () => {
    const fake = fakeOutputStore([textBlock("a")])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.streamChars(1)
    await projection.flush("chat-long")
    s.patches.length = 0

    let content = "a"
    for (let chars = 2; chars <= 6; chars++) {
      content += "b"
      fake.streamChars(chars)
      fake.mutateLast(content)
      await projection.flush("chat-long")
    }
    expect(deltas(s.patches, "chat-long").map((delta) => delta.streamingOutputChars)).toEqual([2, 3, 4, 5, 6])

    s.patches.length = 0
    fake.mutateLast(`${content}c`)
    await projection.flush("chat-long")
    fake.streamChars(7)
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([
      { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:t-a", contentOffset: 6, text: "c" }] },
      { blocks: [], streamingOutputChars: 7 },
    ])
    projection.dispose()
  })

  test("a count change during a read ships though it equals the copy, and the first change after the read restates the count", async () => {
    const fake = fakeOutputStore([textBlock("a")])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.streamChars(4)
    await projection.flush("chat-long")
    s.patches.length = 0

    const read = Promise.withResolvers<HydratedOutputRange>()
    const reading = s.shipped.serve("chat-long", () => read.promise, (range) => range)
    fake.streamChars(4)
    await projection.flush("chat-long")
    read.resolve(servedRange([projectFrontendOutputBlock(textBlock("a"))], {}, 3))
    await reading
    fake.mutateLast("ab")
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long").map((delta) => delta.streamingOutputChars)).toEqual([4, 4])
    projection.dispose()
  })

  test("a streaming bash command ships its growing header as appends, never the whole block", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    const bash = (detail: string): AnyBlock => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status: "streaming", timestamp: 1 })
    fake.changeBlocks([bash("cat")], [insertChange(0, bash("cat"))])
    await projection.flush("chat-long")
    fake.changeBlocks([bash("cat <<EOF")], [upsertChange(0, bash("cat <<EOF"))])
    await projection.flush("chat-long")

    expect(deltas(s.patches, "chat-long").map((delta) => delta.blocks)).toEqual([
      [{ kind: "insert", index: 0, blockId: "tool:call-1", block: bash("cat") }],
      [{ kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "append", path: ["presentation", "detail"], offset: 3, text: " <<EOF" }] }],
    ])
    projection.dispose()
  })

  test("an upsert identical to the copy clients hold is not sent again, for every block kind", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    const blocks: AnyBlock[] = [
      textBlock("said"),
      { kind: "thinking", id: "th-1", content: "pondered", status: "completed", timestamp: 1 },
      { kind: "userMessage", id: "u-1", content: "asked", timestamp: 1, pending: false, injected: false },
      { kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a\nb\n", timestamp: 1 },
      { kind: "agentGroup", containerKind: "subagent", id: "agent-1", toolUseId: "tu-agent-1", label: "Explorer", description: "Searching", status: "active", children: [], totalToolCount: 0, timestamp: 1 },
    ]
    fake.changeBlocks(blocks, blocks.map((block, index) => insertChange(index, block)))
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.changeBlocks(blocks, blocks.map((block, index) => upsertChange(index, structuredClone(block))))
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([])
    projection.dispose()
  })

  test("an agent group change ships whole, never as edits", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    const group = (totalToolCount: number): AnyBlock => ({ kind: "agentGroup", containerKind: "subagent", id: "agent-1", toolUseId: "tu-agent-1", label: "Explorer", description: "Searching", status: "active", children: [], totalToolCount, timestamp: 1 })
    fake.changeBlocks([group(0)], [insertChange(0, group(0))])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.changeBlocks([group(1)], [upsertChange(0, group(1))])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long").map((delta) => delta.blocks)).toEqual([[{ kind: "upsert", index: 0, blockId: "tool:agent-1", block: group(1) }]])
    projection.dispose()
  })

  test("a settled tool a client installed from a read changes whole, so no hybrid fields remain", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    const settled = (resultAction?: "created"): ToolEntry => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a\nb\n", timestamp: 1, ...(resultAction ? { resultAction } : {}) })
    fake.changeBlocks([settled()], [insertChange(0, settled())])
    await projection.flush("chat-long")
    s.patches.length = 0
    // The read omits the inline body and states its line count in its place.
    const { content: _content, ...read } = settled()
    const client: MutableOutputView = { blocks: [{ ...read, contentOmittedLines: 3 }], streamingToolText: {} }

    fake.changeBlocks([settled("created")], [upsertChange(0, settled("created"))])
    await projection.flush("chat-long")
    for (const delta of deltas(s.patches, "chat-long")) expect(applyOutputDelta(client, delta, buildBlockIndex(client.blocks))).toBe(true)
    expect(client.blocks).toEqual([settled("created")])
    projection.dispose()
  })

  test("contiguous appends to one block within one drain ship as one append", async () => {
    const said = textBlock("said")
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([said], [insertChange(0, said)])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.changeBlocks([{ ...said, content: "said a b" }], [appendChange(0, said.id, 4, " a"), appendChange(0, said.id, 6, " b")])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long").map((delta) => delta.blocks)).toEqual([[{ kind: "append-content", index: 0, blockId: "text:t-said", contentOffset: 4, text: " a b" }]])
    projection.dispose()
  })

  test("a settle ships the removal of its streaming entry and its settled block in one delta", async () => {
    const tool = (status: "streaming" | "completed"): AnyBlock => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail: "ls" }, status, timestamp: 1 })
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([tool("streaming")], [insertChange(0, tool("streaming"))])
    fake.changeStreamingToolText({ "call-1": { content: "a\n" } }, ["call-1"])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.changeStreamingToolText({}, ["call-1"])
    fake.changeBlocks([tool("completed")], [upsertChange(0, tool("completed"))])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [
      { kind: "edit", index: 0, blockId: "tool:call-1", edits: [{ kind: "assign", path: ["status"], value: "completed" }] },
    ], streamingToolTextOps: [{ toolUseId: "call-1", kind: "remove" }] }])
    projection.dispose()
  })

  test("a full resync whose tail matches what clients hold, with no read run ahead, sends no blocks and no truncate", async () => {
    const [a, b] = [textBlock("a"), textBlock("b")]
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([a, b], [insertChange(0, a), insertChange(1, b)])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.rewrite([a, b])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([])
    projection.dispose()
  })

  test("a full resync truncates at the first block whose identity differs", async () => {
    const [a, b, c, x] = [textBlock("a"), textBlock("b"), textBlock("c"), textBlock("x")]
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([a, b, c], [insertChange(0, a), insertChange(1, b), insertChange(2, c)])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.rewrite([a, x, c])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, truncateTo: 1, blocks: [
      { kind: "upsert", index: 1, blockId: "text:t-x", block: x },
      { kind: "upsert", index: 2, blockId: "text:t-c", block: c },
    ] }])

    s.patches.length = 0
    fake.rewrite([a])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, truncateTo: 1, blocks: [] }])
    projection.dispose()
  })

  test("a resync over an index with no shipped copy truncates there", async () => {
    // The seed reached clients through their reads, never through a delta.
    const [seed, live] = [textBlock("seed"), textBlock("live")]
    const fake = fakeOutputStore([seed])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([seed, live], [insertChange(1, live)])
    await projection.flush("chat-long")
    s.patches.length = 0

    fake.rewrite([seed, live])
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 1, truncateTo: 0, blocks: [
      { kind: "upsert", index: 0, blockId: "text:t-seed", block: seed },
      { kind: "upsert", index: 1, blockId: "text:t-live", block: live },
    ] }])
    projection.dispose()
  })

  test("a reseed that matches every block but changes the message count still publishes the count", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped })
    store.openSessionRuntime({ sessionId: "chat-reseed", conversationId: "conv-reseed" })
    store.updateChatEntry("chat-reseed", { outputBlocks: [textBlock("a")], visibleMessageCountSuffix: 1, outputChanges: batch([insertChange(0, textBlock("a"))]) })
    await projection.flush("chat-reseed")
    s.patches.length = 0

    store.updateChatEntry("chat-reseed", { outputBlocks: [textBlock("a")], visibleMessageCountSuffix: 3, outputChanges: batch([], true) })
    await projection.flush("chat-reseed")
    expect(deltas(s.patches, "chat-reseed")).toEqual([{ visibleMessageCount: 3, blocks: [] }])
    projection.dispose()
  })

  test("a full resync after a runner replacement removes the old runner's streaming entries", async () => {
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeStreamingToolText({ old: { content: "old runner" } }, ["old"])
    await projection.flush("chat-long")
    s.patches.length = 0

    // The new runner's store never held the old runner's tool, so no drain names it.
    fake.rewrite([], { fresh: { content: "new runner" } })
    await projection.flush("chat-long")
    expect(deltas(s.patches, "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [], streamingToolTextOps: [
      { toolUseId: "old", kind: "remove" },
      { toolUseId: "fresh", kind: "set", entry: { content: "new runner" } },
    ] }])
    projection.dispose()
  })

  test("a resync removes a block a client read before its insert shipped, at the end or mid-list", async () => {
    const [a, b, x] = [textBlock("a"), textBlock("b"), textBlock("x")]
    for (const read of [[a, b, x], [a, x, b]]) {
      const fake = fakeOutputStore([])
      const s = sink()
      const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
      fake.changeBlocks([a, b], [insertChange(0, a), insertChange(1, b)])
      await projection.flush("chat-long")

      // The read served the store while it held `x`, before the projection drained it.
      const reader = await clientRead(s, async () => servedRange(read))
      // One drain holds the insert and the retraction that removes it again.
      fake.changeBlocks(read, [insertChange(read.indexOf(x), x)])
      fake.rewrite([a, b])
      await projection.flush("chat-long")
      reader.applyLater()
      expect(reader.client.blocks).toEqual([a, b])
      projection.dispose()
    }
  })

  test("a resync that ships while a read is in flight still removes what the read ran ahead to", async () => {
    const [a, b, x] = [textBlock("a"), textBlock("b"), textBlock("x")]
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([a, b], [insertChange(0, a), insertChange(1, b)])
    await projection.flush("chat-long")

    const read = Promise.withResolvers<HydratedOutputRange>()
    const reading = clientRead(s, () => read.promise)
    fake.changeBlocks([a, x, b], [insertChange(1, x)])
    fake.rewrite([a, b])
    await projection.flush("chat-long")
    read.resolve(servedRange([a, x, b]))
    const reader = await reading
    reader.applyLater()
    expect(reader.client.blocks).toEqual([a, b])
    projection.dispose()
  })

  test("a change after a read that ran ahead of the shipped copy leaves no field the read added", async () => {
    const tool = (detail: string, linkUri?: string): Extract<FrontendOutputBlock, { kind: "tool" }> => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status: "streaming", timestamp: 1, ...(linkUri ? { linkUri } : {}) })
    for (const inFlight of [false, true]) {
      const fake = fakeOutputStore([])
      const s = sink()
      const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
      fake.changeBlocks([tool("ls")], [insertChange(0, tool("ls"))])
      await projection.flush("chat-long")

      // The read served a version the projection never shipped, and the
      // store moved past it before the next drain.
      const read = Promise.withResolvers<HydratedOutputRange>()
      const reading = clientRead(s, () => read.promise)
      if (!inFlight) read.resolve(servedRange([tool("ls", "flywheel://session/child")]))
      const reader = inFlight ? undefined : await reading
      fake.changeBlocks([tool("ls -la")], [upsertChange(0, tool("ls -la"))])
      await projection.flush("chat-long")
      if (inFlight) read.resolve(servedRange([tool("ls", "flywheel://session/child")]))
      const done = reader ?? await reading
      done.applyLater()
      expect(done.client.blocks).toEqual([tool("ls -la")])
      projection.dispose()
    }
  })

  test("a streaming entry a read ran ahead on changes whole, during the read or after it", async () => {
    for (const inFlight of [false, true]) {
      const fake = fakeOutputStore([])
      const s = sink()
      const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
      fake.changeStreamingToolText({ w: { content: "ab" } }, ["w"])
      await projection.flush("chat-long")

      const read = Promise.withResolvers<HydratedOutputRange>()
      const reading = clientRead(s, () => read.promise)
      if (!inFlight) read.resolve(servedRange([], { w: { content: "ab", filetype: "ts" } }))
      const reader = inFlight ? undefined : await reading
      fake.changeStreamingToolText({ w: { content: "abc" } }, ["w"])
      await projection.flush("chat-long")
      if (inFlight) read.resolve(servedRange([], { w: { content: "ab", filetype: "ts" } }))
      const done = reader ?? await reading
      done.applyLater()
      expect(done.client.streamingToolText).toEqual({ w: { content: "abc" } })
      projection.dispose()
    }
  })

  test("a read that matches what clients hold keeps resyncs and changes small", async () => {
    const [a, b] = [textBlock("a"), textBlock("b")]
    const tool = (detail: string): AnyBlock => ({ kind: "tool", id: "call-1", name: "bash", presentation: { name: "Bash", detail }, status: "streaming", timestamp: 1 })
    const fake = fakeOutputStore([])
    const s = sink()
    const projection = createOutputProjection({ sessionStore: fake.store, shipped: s.shipped })
    fake.changeBlocks([a, b, tool("ls")], [insertChange(0, a), insertChange(1, b), insertChange(2, tool("ls"))])
    await projection.flush("chat-long")

    const reader = await clientRead(s, async () => servedRange([a, b, projectFrontendOutputBlock(tool("ls"))]))
    const position = s.patches.length
    fake.rewrite([a, b, tool("ls")])
    await projection.flush("chat-long")
    fake.changeBlocks([a, b, tool("ls -la")], [upsertChange(2, tool("ls -la"))])
    await projection.flush("chat-long")
    expect(deltas(s.patches.slice(position), "chat-long").map((delta) => delta.blocks.map((change) => change.kind))).toEqual([["edit"]])
    reader.applyLater()
    expect(reader.client.blocks).toEqual([a, b, projectFrontendOutputBlock(tool("ls -la"))])
    projection.dispose()
  })

  test("the session's tail read reports what it served, so a later retraction reaches its client", async () => {
    const [a, b, x] = [textBlock("a"), textBlock("b"), textBlock("x")]
    const s = sink()
    s.shipped.ship("chat-long", { visibleMessageCount: 0, blockCount: 2, blocks: { kind: "changes", changes: [a, b].map((block, index) => ({ kind: "insert", index, blockId: `text:${block.id}`, block })) }, streamingToolText: {}, changedTools: new Set() })
    const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
    const detail = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD,
      // The store holds `x`, which no delta has shipped yet.
      sessionStore: { get: () => chatEntry({ outputBlocks: () => [a, b, x], visibleMessageCountSuffix: 0 }) },
      manager: { read: async () => null },
      reader,
      projectionReader: reader,
      shipped: s.shipped,
    })
    const position = s.patches.length
    const served = await detail.outputWindow("chat-long", { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 * 1024 })
    expect(served.range.kind === "ok" ? served.range.blocks : []).toEqual([a, b, x])

    s.shipped.ship("chat-long", { visibleMessageCount: 0, blockCount: 2, blocks: { kind: "resync", sequenceStart: 0, blocks: [a, b] }, streamingToolText: {}, changedTools: new Set() })
    expect(deltas(s.patches.slice(position), "chat-long")).toEqual([{ visibleMessageCount: 0, blocks: [], truncateTo: 2 }])
    await detail.dispose()
  })

  test("a resync reads the keeper's tails when it ships, so a tail the keeper settled meanwhile stays removed", async () => {
    const said = textBlock("said")
    const fake = fakeOutputStore([])
    const s = sink()
    let kept: ReturnType<CommandKeeper["liveOutput"]> = { k: { content: "tail" } }
    const entered = Promise.withResolvers<void>()
    const projected = Promise.withResolvers<void>()
    const projection = createOutputProjection({
      sessionStore: fake.store,
      shipped: s.shipped,
      keptOutput: { liveOutput: () => kept },
      projectBlock: async (_sessionId, block) => { entered.resolve(); await projected.promise; return block },
    })
    await projection.flush("chat-long")
    const client: MutableOutputView = { blocks: [], streamingToolText: {} }
    s.shipped.ship("chat-long", { streamingToolText: kept, changedTools: new Set(["k"]) })

    fake.rewrite([said])
    const flushed = projection.flush("chat-long")
    await entered.promise
    // The keeper settles the command while the resync projects its blocks.
    kept = {}
    s.shipped.ship("chat-long", { streamingToolText: kept, changedTools: new Set(["k"]) })
    projected.resolve()
    await flushed
    const blockIndex = new Map<string, number>()
    for (const delta of deltas(s.patches, "chat-long")) expect(applyOutputDelta(client, delta, blockIndex)).toBe(true)
    expect(client.streamingToolText).toEqual({})
    projection.dispose()
  })
})
