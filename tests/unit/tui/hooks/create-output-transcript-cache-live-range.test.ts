import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { content, fakeRuntimeClient, gen, windowTotal, rangeOk, rangeUnavailable, textBlock } from "./_output-transcript-cache-fixtures.js"

describe("createOutputTranscriptCache (live deltas on historical ranges)", () => {
  it("updates the unseen message count without rebuilding the visible range", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient({ s1: [textBlock("b0", "one")] })
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      cache.retain("s1")
      await cache.open("s1")
      const range = cache.visibleRange("s1")

      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [] })

      expect(cache.visibleMessageCount("s1")).toBe(2)
      expect(cache.visibleRange("s1")).toBe(range)
      expect(cache.visibleRange("s1")?.blocks.map(content)).toEqual(["one"])
      dispose()
    })
  })

  it("appends live deltas to the durable tail window by absolute block index", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      cache.retain("s1")
      const consistencyToken = gen()

      const opening = cache.open("s1")
      fake.settleTotal(0, windowTotal({ startBlockIndex: 452, endBlockIndex: 453, hasBefore: true, hasAfter: false }, consistencyToken, 454))
      await Promise.resolve()
      fake.settleRange(0, rangeOk([textBlock("b452", "tail-a"), textBlock("b453", "tail-b")], { startBlockIndex: 452, endBlockIndex: 453, hasBefore: true, hasAfter: false }, consistencyToken))
      await opening

      fake.liveDelta("s1", { visibleMessageCount: 455, blocks: [{ kind: "upsert", index: 454, blockId: "text:b454", block: textBlock("b454", "live") }] })

      const snap = cache.visibleRange("s1")!
      expect(snap.blocks.map(content)).toEqual(["tail-a", "tail-b", "live"])
      expect(snap.totalBlocks).toBe(455)
      expect(snap.window.startBlockIndex).toBe(452)
      expect(snap.window.endBlockIndex).toBe(454)
      expect(snap.window.hasBefore).toBe(true)
      expect(snap.window.hasAfter).toBe(false)
      expect(fake.outputWindowCalls()).toBe(1)

      const paging = cache.loadPage("s1", "older")
      expect(fake.rangeCalls().at(-1)!.request.anchor).toEqual({ kind: "beforeBlock", blockId: "text:b452" })
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b451", "older")], { startBlockIndex: 451, endBlockIndex: 451, hasBefore: true, hasAfter: true }, consistencyToken))
      await paging

      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["older", "tail-a", "tail-b", "live"])
      dispose()
    })
  })

  it("merges live deltas that arrive while the initial tail page is loading", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      const consistencyToken = gen()

      const opening = cache.open("s1")
      fake.liveDelta("s1", { visibleMessageCount: 455, blocks: [{ kind: "upsert", index: 454, blockId: "text:b454", block: textBlock("b454", "live") }] })
      fake.settleTotal(0, windowTotal({ startBlockIndex: 452, endBlockIndex: 453, hasBefore: true, hasAfter: false }, consistencyToken, 454))
      await Promise.resolve()
      fake.settleRange(0, rangeOk([textBlock("b452", "tail-a"), textBlock("b453", "tail-b")], { startBlockIndex: 452, endBlockIndex: 453, hasBefore: true, hasAfter: false }, consistencyToken))
      await opening

      const snap = cache.visibleRange("s1")!
      expect(snap.blocks.map(content)).toEqual(["tail-a", "tail-b", "live"])
      expect(snap.totalBlocks).toBe(455)
      expect(snap.window.endBlockIndex).toBe(454)
      expect(fake.outputWindowCalls()).toBe(1)
      dispose()
    })
  })

  it("replays a held append idempotently when the fetched range already includes the appended text", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      const consistencyToken = gen()

      const opening = cache.open("s1")
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:b0", contentOffset: 1, text: "ello" }] })
      fake.settleTotal(0, windowTotal({ startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false }, consistencyToken, 1))
      await Promise.resolve()
      fake.settleRange(0, rangeOk([textBlock("b0", "hello")], { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false }, consistencyToken))
      await opening

      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["hello"])
      expect(fake.outputWindowCalls()).toBe(1)
      dispose()
    })
  })

  it("coalesces recovery when an unavailable initial range and held deltas require repair", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      const consistencyToken = gen()

      const opening = cache.open("s1")
      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "upsert", index: 1, blockId: "text:b1", block: textBlock("b1", "staged") }] })
      fake.settleTotal(0, windowTotal({ startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false }, consistencyToken, 1))
      await Promise.resolve()
      fake.settleRange(0, rangeUnavailable())
      await opening

      expect(cache.visibleRange("s1")!.status.kind).toBe("unavailable")
      expect(cache.isCurrent("s1")).toBe(false)
      const recoveryCalls = fake.outputWindowCalls()
      fake.liveDelta("s1", { visibleMessageCount: 3, blocks: [{ kind: "upsert", index: 2, blockId: "text:b2", block: textBlock("b2", "recover") }] })
      expect(fake.outputWindowCalls()).toBe(recoveryCalls)
      dispose()
    })
  })
})
