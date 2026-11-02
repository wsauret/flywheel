import { describe, expect, test } from "bun:test"
import type { StreamingToolTextOp } from "../../../../src/infra/output/output-block-delta.js"
import type { ToolEntry, ToolStreamingText } from "../../../../src/infra/output-blocks.js"
import type { CommandKeeper, KeptOutputChange } from "../../../../src/orchestration/app-service/command-keeper.js"
import { createKeptOutputProjection } from "../../../../src/orchestration/app-service/kept-output-projection.js"
import { readOutputSequence, type OutputSequence } from "../../../../src/orchestration/app-service/output-sequence.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { applyStreamingToolTextOps } from "../../../../src/protocol/client/streaming-text-edits.js"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import { chatEntry, fakeSessionStore } from "./app-service-doubles.js"
import { sink } from "./_output-projection-fixtures.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"

const TAIL = { content: "listening\n" }
const APPEND: StreamingToolTextOp = { toolUseId: "toolu_kept", kind: "set", entry: TAIL }
const REMOVE: StreamingToolTextOp = { toolUseId: "toolu_kept", kind: "remove" }
const FINAL: ToolEntry = { kind: "tool", id: "toolu_kept", name: "bash", presentation: { name: "Bash", detail: "serve" }, status: "completed", timestamp: 1, content: "finished\n" }

function sequence(visibleMessageCount = 2): OutputSequence {
  return { ...indexOutputBlocks([FINAL]), visibleMessageCount, consistencyToken: "durable", streamingToolText: {}, streamingOutputChars: 0, groupChildren: async () => { throw new Error("no groups") } }
}

function settled(toolUseId = FINAL.id): Extract<KeptOutputChange, { kind: "settled" }> {
  return { kind: "settled", toolUseId, event: { type: "tool-execution-output-recorded", toolUseId, output: "finished\n" } }
}

describe("the output of commands a keeper holds for a session no host holds", () => {
  test("a snapshot of the session's output carries the keeper's live tail", async () => {
    const history = { ...indexOutputBlocks([]), consistencyToken: "durable", tipEntryId: null, visibleUserFilteredIndices: [], openCallIds: new Set<string>(), groupChildren: () => { throw new Error("no groups") } }
    const snapshot = await readOutputSequence("paused", { kind: "chat", command: "chat", conversationId: "conversation", label: "Chat", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive", executionCwd: FIXTURE_EXECUTION_CWD, name: "Chat", createdAt: "2026-01-01T00:00:00.000Z" }, {
      sessionStore: { get: () => undefined },
      keptOutput: { liveOutput: (sessionId): ReturnType<CommandKeeper["liveOutput"]> => sessionId === "paused" ? { toolu_kept: TAIL } : {} },
      get reader(): never { throw new Error("no event reads") },
      // A chat reads no workflow: any member of the surface it holds throws.
      projectionReader: new Proxy(asAsyncEventReadSurface(inMemoryEventReader([])), { get: () => { throw new Error("no workflow reads") } }),
      projectRoot: FIXTURE_EXECUTION_CWD,
      transcriptCache: { projectBlock: async (_sessionId, block) => block, read: async () => history, createSessionReader: () => { throw new Error("no workflow") }, children: async () => { throw new Error("no groups") }, projectGroupChildren: (indexed) => indexed },
    })

    expect(snapshot?.streamingToolText).toEqual({ toolu_kept: TAIL })
  })

  function projected(readSequence: (sessionId: string) => Promise<OutputSequence | null> = async () => sequence()) {
    let notify: (sessionId: string, change: KeptOutputChange) => void = () => {}
    const published: RuntimeUiPatchInput[] = []
    let live: { [toolUseId: string]: ToolStreamingText } = {}
    let changed = new Set<string>()
    const deps = {
      keeper: {
        onLiveOutput: (listener: typeof notify) => { notify = listener; return () => {} },
        drainLiveOutput: () => { const drained = changed; changed = new Set(); return drained },
        liveOutput: () => live,
      },
      readSequence,
      projectSettled: () => {},
      shipped: createShippedOutput({ publish: (input: RuntimeUiPatchInput) => { published.push(input); return { ...input, position: published.length, prevPosition: published.length - 1 } } }),
    }
    const forgotten: string[] = []
    const projection = createKeptOutputProjection({ ...deps, shipped: { ship: deps.shipped.ship, watches: deps.shipped.watches, forget: (sessionId) => { forgotten.push(sessionId); deps.shipped.forget(sessionId) } } })
    /** The keeper's tails change to `next`, and it names the tools that changed. */
    const notifyChange = (change: KeptOutputChange, next: { [toolUseId: string]: ToolStreamingText } = live) => {
      for (const toolUseId of new Set([...Object.keys(live), ...Object.keys(next)])) if (live[toolUseId] !== next[toolUseId]) changed.add(toolUseId)
      live = next
      notify("paused", change)
    }
    return { projection, published, forgotten, shipped: deps.shipped, notify: notifyChange }
  }

  test("publishes a tail's growth as streaming changes on the session's output cursor, in arrival order", async () => {
    const { projection, published, notify } = projected(async () => { throw new Error("growth must not read history") })
    notify({ kind: "grew" }, { toolu_kept: TAIL })
    notify({ kind: "grew" }, { toolu_kept: TAIL, other: { content: "more\n" } })
    await Bun.sleep(5)
    notify({ kind: "grew" }, { toolu_kept: { content: `${TAIL.content}ready\n` }, other: { content: "more\n" } })
    await Bun.sleep(5)

    expect(published).toEqual([
      { cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [APPEND, { toolUseId: "other", kind: "set", entry: { content: "more\n" } }] } } },
      { cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [{ toolUseId: "toolu_kept", kind: "edit", edits: [{ kind: "append", path: ["content"], offset: TAIL.content.length, text: "ready\n" }] }] } } },
    ])
    projection.dispose()
  })

  test.each(["x".repeat(4096), "😀é".repeat(682) + "abcd"])("partitions kept output without loss (%#. case)", async (content) => {
    const { projection, published, notify } = projected()
    notify({ kind: "grew" }, { toolu_kept: TAIL })
    await Bun.sleep(5)
    published.length = 0
    notify({ kind: "grew" }, { toolu_kept: { content: TAIL.content + content } })
    await Bun.sleep(5)
    const bus = sink()
    let state: Parameters<typeof applyStreamingToolTextOps>[0] = { toolu_kept: TAIL }
    for (const input of published) {
      expect(Buffer.byteLength(JSON.stringify(bus.publish(input)))).toBeLessThan(4096)
      if (input.payload.kind === "output.delta") {
        const updated = applyStreamingToolTextOps(state, input.payload.delta.streamingToolTextOps ?? [])
        if (updated === null) throw new Error("streaming delta cannot be applied")
        state = updated
      }
    }
    expect(state).toEqual({ toolu_kept: { content: TAIL.content + content } })
    projection.dispose()
  })

  test.each(["toolu_kept", "code#1"])("publishes %s's final body and removes its live tail in one delta", async (toolUseId) => {
    const final = { ...FINAL, id: toolUseId }
    const remove: StreamingToolTextOp = { kind: "remove", toolUseId }
    const { projection, published, notify } = projected(async () => ({ ...sequence(), ...indexOutputBlocks([final]) }))

    notify({ kind: "grew" }, { [toolUseId]: TAIL })
    await Bun.sleep(5)
    published.length = 0
    notify(settled(toolUseId), {})
    await Bun.sleep(5)

    expect(published).toEqual([{ cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{ kind: "upsert", index: 0, blockId: `tool:${toolUseId}`, block: final }], streamingToolTextOps: [remove] } } }])
    projection.dispose()
  })

  test("forgets what the session's clients hold once the keeper holds no tail for it", async () => {
    const { projection, forgotten, notify } = projected(async () => ({ ...sequence(), ...indexOutputBlocks([FINAL, { ...FINAL, id: "other" }]) }))
    notify({ kind: "grew" }, { toolu_kept: TAIL, other: TAIL })
    await Bun.sleep(5)
    notify(settled("other"), { toolu_kept: TAIL })
    await Bun.sleep(5)
    expect(forgotten).toEqual([])
    notify(settled(), {})
    await Bun.sleep(5)
    expect(forgotten).toEqual(["paused"])
    projection.dispose()
  })

  test("a session no client watches drains its tails and settlements without reading or publishing", async () => {
    let reads = 0
    const { projection, published, shipped, notify } = projected(async () => { reads++; return sequence() })
    shipped.watch(["other"])
    notify({ kind: "grew" }, { toolu_kept: TAIL })
    await Bun.sleep(5)
    notify(settled(), {})
    await Bun.sleep(5)
    expect(reads).toBe(0)
    expect(published).toEqual([])
    projection.dispose()
  })

  test("drains growth with a pending settlement's final body", async () => {
    const entered = Promise.withResolvers<void>()
    const first = Promise.withResolvers<OutputSequence>()
    let reads = 0
    const { projection, published, notify } = projected(async () => {
      if (++reads === 1) { entered.resolve(); return first.promise }
      return sequence(4)
    })
    notify({ kind: "grew" }, { toolu_kept: TAIL })
    await Bun.sleep(5)
    published.length = 0
    notify(settled(), {})
    await entered.promise
    const more = { content: "more\n" }
    notify({ kind: "grew" }, { other: more })
    first.resolve(sequence(3))
    await Bun.sleep(5)
    expect(published[0]?.payload).toEqual({ kind: "output.delta", delta: { visibleMessageCount: 3, blocks: [{ kind: "upsert", index: 0, blockId: "tool:toolu_kept", block: FINAL }], streamingToolTextOps: [REMOVE, { kind: "set", toolUseId: "other", entry: more }] } })
    notify({ kind: "grew" }, { other: { content: "more\nstill\n" } })
    await Bun.sleep(5)
    expect(published[1]?.payload).toEqual({ kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [{ kind: "edit", toolUseId: "other", edits: [{ kind: "append", path: ["content"], offset: 5, text: "still\n" }] }] } })
    expect(reads).toBe(1)
    projection.dispose()
  })

  test("re-reads when another command settles during the final-body read", async () => {
    const entered = Promise.withResolvers<void>()
    const first = Promise.withResolvers<OutputSequence>()
    let reads = 0
    const { projection, published, notify } = projected(async () => {
      if (++reads === 1) { entered.resolve(); return first.promise }
      return { ...sequence(4), ...indexOutputBlocks([FINAL, { ...FINAL, id: "other" }]) }
    })
    notify({ kind: "grew" }, { toolu_kept: TAIL, other: TAIL })
    await Bun.sleep(5)
    published.length = 0
    notify(settled("other"), { toolu_kept: TAIL })
    await entered.promise
    notify(settled(), {})
    first.resolve({ ...sequence(), readBlock: () => ({ ...FINAL, status: "pending", content: "old" }) })
    await Bun.sleep(5)
    expect(reads).toBe(2)
    expect(published).toEqual([{ cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [
      { kind: "upsert", index: 1, blockId: "tool:other", block: { ...FINAL, id: "other" } },
      { kind: "upsert", index: 0, blockId: "tool:toolu_kept", block: FINAL },
    ], streamingToolTextOps: [{ kind: "remove", toolUseId: "other" }, REMOVE] } } }])
    projection.dispose()
  })

  test("re-reads when another command settles during a final-block read", async () => {
    const entered = Promise.withResolvers<void>()
    const hydrated = Promise.withResolvers<void>()
    let reads = 0
    const { projection, published, notify } = projected(async () => {
      const current = { ...sequence(), ...indexOutputBlocks([FINAL, { ...FINAL, id: "other" }]) }
      if (++reads > 1) return current
      return { ...current, readBlock: async (index: number) => {
        entered.resolve()
        await hydrated.promise
        return current.readBlock(index)
      } }
    })
    notify({ kind: "grew" }, { toolu_kept: TAIL, other: TAIL })
    await Bun.sleep(5)
    published.length = 0
    notify(settled("other"), { toolu_kept: TAIL })
    await entered.promise
    notify(settled(), {})
    hydrated.resolve()
    await Bun.sleep(5)
    expect(reads).toBe(2)
    expect(published).toEqual([{ cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [
      { kind: "upsert", index: 1, blockId: "tool:other", block: { ...FINAL, id: "other" } },
      { kind: "upsert", index: 0, blockId: "tool:toolu_kept", block: FINAL },
    ], streamingToolTextOps: [{ kind: "remove", toolUseId: "other" }, REMOVE] } } }])
    projection.dispose()
  })

  test("publishes nothing when disposed during a final-block read", async () => {
    const entered = Promise.withResolvers<void>()
    const hydrated = Promise.withResolvers<void>()
    const { projection, published, notify } = projected(async () => {
      const current = sequence()
      return { ...current, readBlock: async (index: number) => {
        entered.resolve()
        await hydrated.promise
        return current.readBlock(index)
      } }
    })
    notify(settled(), {})
    await entered.promise
    projection.dispose()
    hydrated.resolve()
    await Bun.sleep(5)
    expect(published).toEqual([])
  })

  test("a command handed from the turn to the keeper continues its tail as edits", async () => {
    const { projection, published, shipped, notify } = projected()
    const store = fakeSessionStore(new Map([["paused", chatEntry({ outputBlocks: () => [], streamingToolText: { toolu_kept: TAIL }, visibleMessageCountSuffix: 0 })]]))
    let pending = { changes: [], fullResync: false, changedTools: new Set(["toolu_kept"]) }
    const output = createOutputProjection({
      sessionStore: { ...store, allIds: () => ["paused"], revision: () => 1 + pending.changedTools.size, drainOutputChanges: () => { const drained = pending; pending = { ...drained, changedTools: new Set() }; return drained } },
      keptOutput: { liveOutput: () => ({}) },
      shipped,
    })
    await output.flush("paused")
    published.length = 0

    // The runner's turn ends; the keeper holds the command and its tail grows.
    notify({ kind: "grew" }, { toolu_kept: { content: `${TAIL.content}ready\n` } })
    await Bun.sleep(5)
    expect(published).toEqual([{ cursor: outputCursor("paused"), payload: { kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [
      { toolUseId: "toolu_kept", kind: "edit", edits: [{ kind: "append", path: ["content"], offset: TAIL.content.length, text: "ready\n" }] },
    ] } } }])
    output.dispose()
    projection.dispose()
  })
})
