import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { fakeRuntimeClient, flushRecovery, liveView, textBlock } from "./_output-transcript-cache-fixtures.js"
import { asScrollBox, fakeScrollBox, mountController } from "../../../fixtures/output-scroll-harness.js"
import type { TranscriptLayoutSlot } from "../../../../src/tui/output-window/output-window-scroll.js"

/** Item 18a: the 16ms delta path maintains the window incrementally -- the
 *  estimate array is never rebuilt (its identity is the height-index seeding
 *  key), the window's estimated rows move by per-block deltas, and changed
 *  blocks surface as point updates for the height index. */
describe("incremental window recompute (live delta path)", () => {
  it("keeps the off-tail block and unseen baseline through identical and moved recovery", async () => {
    await createRoot(async (dispose) => {
      try {
        const blocks = Array.from({ length: 20 }, (_, i) => textBlock(`b${i}`, `line ${i}`))
        const fake = fakeRuntimeClient({ s1: blocks })
        const cache = createOutputTranscriptCache({ appService: fake.client })
        cache.retain("s1")
        await cache.open("s1")
        const slot: TranscriptLayoutSlot = {}
        const controller = mountController(slot, () => cache.visibleRange("s1"), { visibleMessageCount: () => cache.visibleMessageCount("s1") })
        const box = fakeScrollBox()
        controller.attach(asScrollBox(box))
        box.scrollHeight = 60
        box.onUpdate?.(16)
        controller.page("page-up")
        box.onUpdate?.(16)
        const anchor = slot.scroll?.anchorIdentity
        const baseline = controller.returnToLatestBaseline()
        const top = box.scrollTop
        if (!anchor) throw new Error("expected a protected reading identity")
        cache.protectReader("s1", { following: false, blockIds: [anchor] })
        fake.invalidate("s1", "rebase")
        await flushRecovery()
        box.onUpdate?.(16)
        expect(slot.scroll?.anchorIdentity).toBe(anchor)
        expect(box.scrollTop).toBe(top)
        fake.setOutputWindow("s1", [textBlock("inserted", "older"), ...blocks])
        fake.invalidate("s1", "rebase")
        await flushRecovery()
        box.scrollHeight = 63
        box.onUpdate?.(16)
        expect(slot.scroll?.anchorIdentity).toBe(anchor)
        expect(box.scrollTop).toBe(top + 3)
        expect(controller.returnToLatestBaseline()).toBe(baseline)
      } finally { dispose() }
    })
  })

  it("keeps the heightEstimates array identity across streaming flushes and moves estimatedRows by the delta", async () => {
    await createRoot(async (dispose) => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")

      await fake.live(cache, "s1", liveView([textBlock("a", "one line")]))
      const seeded = cache.visibleRange("s1")
      if (!seeded) throw new Error("expected a seeded snapshot")
      // Scalars captured by value: the snapshot is a live store proxy.
      const estimatesBefore = seeded.heightEstimates
      const epochBefore = seeded.seedEpoch
      const rowsBefore = seeded.window.estimatedRows
      expect(rowsBefore).toBe(3)
      cache.takeEstimateUpdates("s1")

      // Append enough text to cross the low-bias content-size threshold: +2 rows, same estimate array.
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 8, text: `\n${"x".repeat(3200)}` }] })
      const grown = cache.visibleRange("s1")
      if (!grown) throw new Error("expected the grown snapshot")
      expect(grown.window.estimatedRows).toBe(rowsBefore + 2)
      expect(grown.heightEstimates).toBe(estimatesBefore)
      expect(grown.seedEpoch).toBe(epochBefore)

      // The changed block surfaced as one point update at its absolute index.
      expect(cache.takeEstimateUpdates("s1")).toEqual([[0, 5]])
      // Drained: a second take is empty until the next change.
      expect(cache.takeEstimateUpdates("s1")).toEqual([])

      // A new tail block extends the window and sums in its own estimate.
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "insert", index: 1, blockId: "text:b", block: textBlock("b", "x\ny") }] })
      const extended = cache.visibleRange("s1")
      if (!extended) throw new Error("expected the extended snapshot")
      expect(extended.window.estimatedRows).toBe(rowsBefore + 2 + 3)
      expect(extended.window.endBlockIndex).toBe(1)
      expect(extended.totalBlocks).toBe(2)
      expect(extended.heightEstimates).toBe(estimatesBefore)
      expect(cache.takeEstimateUpdates("s1")).toEqual([[1, 3]])

      dispose()
    })
  })

  it("evictBefore drops far pages: residency shrinks, absolute indices stand, older paging re-arms", async () => {
    await createRoot(async (dispose) => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")

      const blocks = Array.from({ length: 10 }, (_, i) => textBlock(`b${i}`, `line ${i}`))
      await fake.live(cache, "s1", liveView(blocks))
      const before = cache.visibleRange("s1")
      if (!before) throw new Error("expected a snapshot")
      const epochBefore = before.seedEpoch

      cache.evictBefore("s1", 6)
      const after = cache.visibleRange("s1")
      if (!after) throw new Error("expected the evicted snapshot")
      expect(after.window.startBlockIndex).toBe(6)
      expect(after.window.hasBefore).toBe(true)
      expect(after.blocks.map((b) => ("id" in b ? b.id : undefined))).toEqual(["b6", "b7", "b8", "b9"])
      expect(after.totalBlocks).toBe(10)
      expect(after.window.estimatedRows).toBe(12)
      expect(after.heightEstimates.every((estimate) => estimate.blockIndex >= 6)).toBe(true)
      // A structural write: derivation caches keyed on seedEpoch must drop.
      expect(after.seedEpoch).toBeGreaterThan(epochBefore)

      // Live deltas keep applying against the raised window origin.
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 10, blocks: [{ kind: "append-content", index: 9, blockId: "text:b9", contentOffset: 6, text: " grown" }] })
      const grown = cache.visibleRange("s1")
      const tail = grown?.blocks.at(-1)
      if (!tail || !("content" in tail)) throw new Error("expected the tail block")
      expect(tail.content).toBe("line 9 grown")

      // The cut can never consume the whole window.
      cache.evictBefore("s1", 99)
      expect(cache.visibleRange("s1")?.blocks.length).toBe(4)

      dispose()
    })
  })

  it("a reset delta repaves the window: fresh estimates, bumped seedEpoch, cleared point updates", async () => {
    await createRoot(async (dispose) => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")

      await fake.live(cache, "s1", liveView([textBlock("a", "one")]))
      const before = cache.visibleRange("s1")
      if (!before) throw new Error("expected a snapshot")
      // Scalars captured by value: the snapshot is a live store proxy.
      const epochBefore = before.seedEpoch
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 3, text: "\nmore" }] })

      clock += 20
      await fake.live(cache, "s1", liveView([textBlock("z", "fresh\nstart")]))
      const after = cache.visibleRange("s1")
      if (!after) throw new Error("expected the reset snapshot")
      expect(after.seedEpoch).toBeGreaterThan(epochBefore)
      // Fresh estimates over the repaved window, not the grown one.
      expect(after.heightEstimates).toEqual([{ blockIndex: 0, rows: 3 }])
      expect(after.window.estimatedRows).toBe(3)
      // The pre-reset point update was superseded by the repave.
      expect(cache.takeEstimateUpdates("s1")).toEqual([])

      dispose()
    })
  })
})
