import { describe, expect, it, spyOn } from "bun:test"
import { createEffect, createMemo, createRoot } from "solid-js"
import { unwrap } from "solid-js/store"
import { Log } from "../../../../src/infra/log.js"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { atTranscriptHead } from "../../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { createTranscriptWindowProjector } from "../../../../src/tui/output-window/output-window-projection.js"
import { INSTANT_BACKOFF, content, fakeRuntimeClient, flushRecovery, gen, liveView, rangeOk, rangeUnavailable, seedComplete, seedTail, textBlock, toolEntry, userMessageBlock, windowTotal } from "./_output-transcript-cache-fixtures.js"

const run = (scenario: (dispose: () => void) => Promise<void>): Promise<void> => createRoot(async (dispose) => { try { await scenario(dispose) } finally { dispose() } })

describe("createOutputTranscriptCache (one shared store per resident session)", () => {
  it.each(["tail", "history", "empty"] as const)("publishes lane readiness without treating the retained %s as a fresh view", async (place) => {
    const fake = fakeRuntimeClient()
    const readings: boolean[] = []
    const { cache, stop } = createRoot((disposeRoot) => {
      const transcripts = createOutputTranscriptCache({ appService: fake.client })
      createEffect(() => { readings.push(transcripts.isCurrent("s1")) })
      return { cache: transcripts, stop: disposeRoot }
    })
    try {
      expect(readings.at(-1)).toBe(false)
      if (place === "empty") {
        const opening = cache.open("s1")
        fake.settleTotal(0, 0)
        fake.settleRange(0, rangeOk([], { startBlockIndex: null, endBlockIndex: null }))
        await opening
      } else await seedComplete(cache, fake, "s1")
      expect(readings.at(-1)).toBe(true)
      if (place === "history") {
        const opening = cache.loadAround("s1", "target")
        fake.settleTotal(1, 100)
        fake.settleRange(1, {
          ...rangeOk([toolEntry("target")], { startBlockIndex: 40, endBlockIndex: 40, hasBefore: true, hasAfter: true }),
          anchor: { kind: "around", entryId: "target" },
        })
        await opening
        expect(readings.at(-1)).toBe(true)
      }
      const read = fake.totalCalls().length
      fake.reconnect()
      expect(cache.visibleRange("s1")?.status.kind).toBe(place === "history" ? "partial" : "complete")
      expect(readings.at(-1)).toBe(false)
      fake.settleTotal(read, place === "empty" ? 0 : 1)
      await Promise.resolve()
      fake.settleRange(read, place === "empty"
        ? rangeOk([], { startBlockIndex: null, endBlockIndex: null })
        : rangeOk([textBlock("b0", "fresh")]))
      await flushRecovery()
      expect(readings.at(-1)).toBe(true)
      if (place === "history") expect(cache.visibleRange("s1")?.blocks).toEqual([toolEntry("target")])
    } finally { stop() }
  })

  it("seeds the tail and reads loading -> partial with the head still to page", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      const opening = cache.open("s1")
      expect(cache.visibleRange("s1")?.status.kind).toBe("loading")
      fake.settleTotal(0, windowTotal({ startBlockIndex: 99, endBlockIndex: 99, hasBefore: true, hasAfter: false }))
      await Promise.resolve()
      fake.settleRange(0, rangeOk([textBlock("b99", "tail")], { startBlockIndex: 99, endBlockIndex: 99, hasBefore: true, hasAfter: false }))
      await opening
      const snap = cache.visibleRange("s1")!
      expect(snap.status.kind).toBe("partial")
      expect(snap.window).toMatchObject({ startBlockIndex: 99, endBlockIndex: 99, hasBefore: true, hasAfter: false })
      expect(snap.totalBlocks).toBe(100)
      expect(snap.source).toEqual({ kind: "historical", consistencyToken: gen() })
      expect(snap.historicalThroughIndex).toBe(99)
      expect(cache.historyMetadata("s1")).toEqual({ consistencyToken: gen(), totalBlocks: 100, window: snap.window })
      expect(fake.outputWindowCalls()).toBe(1)
    })
  })

  it("starts a new session as known-empty while holding live output for the first read seed", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })

      cache.startKnownEmpty("s1")

      const started = cache.visibleRange("s1")
      expect(started?.status.kind).toBe("complete")
      expect(started?.source.kind).toBe("live")
      expect(started?.totalBlocks).toBe(0)
      expect(started?.blocks.length).toBe(0)
      expect(atTranscriptHead(cache.visibleRange("s1"))).toBe(true)
      expect(fake.outputWindowCalls()).toBe(1)

      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "insert", index: 1, blockId: "text:live", block: textBlock("live", "after create") }] })
      expect(cache.visibleRange("s1")?.blocks).toEqual([])

      fake.settleTotal(0, 1)
      await Promise.resolve()
      fake.settleRange(0, rangeOk([textBlock("read", "authoritative")], { startBlockIndex: 0, endBlockIndex: 0 }))
      await flushRecovery()

      expect(cache.visibleRange("s1")?.blocks.map(content)).toEqual(["authoritative", "after create"])
    })
  })

  it("open is idempotent for a resident session and refresh reads the tail again", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedComplete(cache, fake, "s1")
      await cache.open("s1")
      expect(fake.outputWindowCalls()).toBe(1)
      const refreshing = cache.refresh("s1")
      fake.settleTotal(1, windowTotal({ hasBefore: false, hasAfter: false }, gen("g2"), 1))
      await Promise.resolve()
      fake.settleRange(1, rangeOk([textBlock("b0", "fresh")], { hasBefore: false, hasAfter: false }, gen("g2")))
      await refreshing
      expect(fake.outputWindowCalls()).toBe(2)
      expect(content(cache.visibleRange("s1")!.blocks[0])).toBe("fresh")
      expect(cache.visibleRange("s1")!.status.kind).toBe("complete")
    })
  })

  it.each(["recovery-failed", "unavailable"] as const)("open reads a resident again whose last read was %s", async (outcome) => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, recoveryBackoff: INSTANT_BACKOFF })
      if (outcome === "recovery-failed") {
        fake.setOutputWindow("s1", [])
        fake.failOutputWindow(4)
        await expect(cache.open("s1")).rejects.toThrow()
      } else {
        const opening = cache.open("s1")
        fake.settleTotal(0, 0)
        await Promise.resolve()
        fake.settleRange(0, rangeUnavailable())
        await opening
      }
      expect(cache.visibleRange("s1")?.status.kind).toBe(outcome)
      fake.setOutputWindow("s1", [textBlock("b0", "answer")])
      const reads = fake.outputWindowCalls()
      await cache.open("s1")
      expect(fake.outputWindowCalls()).toBe(reads + 1)
      expect(cache.visibleRange("s1")?.blocks.map(content)).toEqual(["answer"])
      expect(cache.visibleRange("s1")?.status.kind).toBe("complete")
    })
  })

  it.each(["refresh", "jumpToLatest"] as const)("keeps the resident window and coordinates through %s", async (action) => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedTail(cache, fake, "s1")
      const before = cache.visibleRange("s1")!
      const generation = before.generation
      const block = before.blocks[0]
      const refreshing = cache[action]("s1")
      expect(cache.visibleRange("s1")!.blocks).toEqual(before.blocks)
      fake.settleTotal(fake.totalCalls().length - 1, windowTotal({ startBlockIndex: 99, hasBefore: true }))
      await Promise.resolve()
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b99", "refreshed")], { startBlockIndex: 99, endBlockIndex: 99, hasBefore: true }))
      await refreshing
      expect(content(cache.visibleRange("s1")!.blocks[0])).toBe("refreshed")
      expect(cache.visibleRange("s1")!.blocks[0]).toBe(block)
      // A merge that proved continuity keeps the coordinate space.
      expect(cache.visibleRange("s1")!.generation).toBe(generation)
    })
  })

  it("loadPage('older') asks before the first block, prepends, and reports skipped at the head", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedTail(cache, fake, "s1")
      const paging = cache.loadPage("s1", "older")
      expect(fake.rangeCalls().at(-1)!.request.anchor).toEqual({ kind: "beforeBlock", blockId: "text:b99" })
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b98", "older")], { startBlockIndex: 98, endBlockIndex: 98, hasBefore: false, hasAfter: true }))
      await expect(paging).resolves.toBe("loaded")
      const snap = cache.visibleRange("s1")!
      expect(snap.blocks.map(content)).toEqual(["older", "tail"])
      expect(snap.window).toMatchObject({ startBlockIndex: 98, endBlockIndex: 99, hasBefore: false })
      expect(snap.window.estimatedRows).toBe(6)
      await expect(cache.loadPage("s1", "older")).resolves.toBe("skipped")
      expect(fake.rangeCalls()).toHaveLength(2)
    })
  })

  it("coalesces two concurrent older loads into one read", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedTail(cache, fake, "s1")
      const before = fake.rangeCalls().length
      const a = cache.loadPage("s1", "older")
      const b = cache.loadPage("s1", "older")
      expect(fake.rangeCalls().length).toBe(before + 1)
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b98", "older")], { startBlockIndex: 98, endBlockIndex: 98, hasBefore: true, hasAfter: true }))
      expect(await Promise.all([a, b])).toEqual(["loaded", "loaded"])
      expect(cache.visibleRange("s1")!.window.startBlockIndex).toBe(98)
    })
  })

  it("navigates to an entry through the around anchor and treats a served tail as the tail", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedTail(cache, fake, "s1")
      const loading = cache.loadAround("s1", "tool-target")
      const request = fake.outputWindowRequests().at(-1)!.request
      expect(request.range.anchor).toEqual({ kind: "around", entryId: "tool-target" })
      fake.settleTotal(fake.totalCalls().length - 1, windowTotal({ startBlockIndex: 40, hasBefore: true, hasAfter: true }))
      await Promise.resolve()
      fake.settleRange(fake.rangeCalls().length - 1, { ...rangeOk([toolEntry("tool-target")], { startBlockIndex: 40, endBlockIndex: 40, hasBefore: true, hasAfter: true }), anchor: { kind: "around", entryId: "tool-target" } })
      await loading
      const around = cache.visibleRange("s1")!
      expect(around.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["tool-target"])
      expect(around.window.hasAfter).toBe(true)
      // A window that left the tail notes live output as newer instead of splicing it in.
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "upsert", index: 99, blockId: "text:live", block: textBlock("live", "live") }] })
      expect(cache.visibleRange("s1")!.blocks.map((block) => "id" in block ? block.id : "")).toEqual(["tool-target"])
      // An entry the runtime cannot place is served as the tail, which is then the window.
      const missing = cache.loadAround("s1", "absent")
      fake.settleTotal(fake.totalCalls().length - 1, windowTotal({ startBlockIndex: 99, hasBefore: true }))
      await Promise.resolve()
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b99", "tail again")], { startBlockIndex: 99, endBlockIndex: 99, hasBefore: true }))
      await missing
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["tail again"])
    })
  })

  it("evicts the oldest session by insertion order, never the pinned one, and refetches on re-open", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, maxSessions: 2 })
      await seedComplete(cache, fake, "s1")
      await seedComplete(cache, fake, "s2")
      await seedComplete(cache, fake, "s3")
      expect(cache.residentSessionIds()).toEqual(["s2", "s3"])
      expect(cache.visibleRange("s1")).toBeUndefined()
      const reads = fake.outputWindowCalls()
      await seedComplete(cache, fake, "s1")
      expect(fake.outputWindowCalls()).toBe(reads + 1)
      cache.retain("s1")
      await seedComplete(cache, fake, "s2")
      expect([...cache.residentSessionIds()].sort()).toEqual(["s1", "s2"])
    })
  })

  it("keeps disclosure intent across a prepend and a refresh, and drops it with the session", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, maxSessions: 1 })
      await seedTail(cache, fake, "s1")
      cache.setDisclosure("s1", "text:b99", true)
      const paging = cache.loadPage("s1", "older")
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b98", "older")], { startBlockIndex: 98, endBlockIndex: 98, hasBefore: true, hasAfter: true }))
      await paging
      expect(cache.disclosure("s1", "text:b99")).toBe(true)
      await seedComplete(cache, fake, "s2")
      expect(cache.disclosure("s1", "text:b99")).toBeUndefined()
    })
  })

  it("answers one session's disclosure intent by block identity", async () => {
    await run(async () => {
      const cache = createOutputTranscriptCache({ appService: fakeRuntimeClient().client, now: () => 1000 })
      cache.setDisclosure("s1", "tool:call-1", true)
      cache.setDisclosure("s1", "tool:call-2", false)
      cache.setDisclosure("s10", "tool:call-3", true)
      expect(cache.disclosures("s1")).toEqual({ "tool:call-1": true, "tool:call-2": false })
      expect(cache.disclosures("s2")).toEqual({})
    })
  })

  it("applies a live delta to the seeded window and confirms the delivered blocks against the resident window", async () => {
    await run(async () => {
      const adopted: string[] = []
      const windows: (number | null)[] = []
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({
        appService: fake.client, now: () => clock,
        onBlocksAdopted: (_id, blocks, window) => {
          adopted.push(...blocks.map((block) => "id" in block ? block.id : ""))
          windows.push(window.startBlockIndex)
        },
      })
      cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "hello")]))
      expect(adopted).toEqual(["a"])
      expect(windows).toEqual([0])
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "upsert", index: 1, blockId: "text:b", block: textBlock("b", "world") }] })
      const snap = cache.visibleRange("s1")!
      expect(snap.blocks.map(content)).toEqual(["hello", "world"])
      expect(snap.status.kind).toBe("complete")
      expect(snap.totalBlocks).toBe(2)
      expect(adopted).toEqual(["a", "b"])
      expect(cache.takeEstimateUpdates("s1")).toEqual([[1, 3]])
      expect(cache.takeEstimateUpdates("s1")).toEqual([])
      expect(cache.streamingOutputChars("s1")).toBe(0)
      clock += 100
      fake.liveDelta("s1", { blocks: [], streamingOutputChars: 40 })
      expect(cache.streamingOutputChars("s1")).toBe(40)
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["hello", "world"])
    })
  })

  it("coalesces a streaming burst into one frame and flushes a user message at once", async () => {
    await run(async () => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "he")]))
      // The first delta after an idle frame lands at once and starts the frame.
      clock += 20
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 2, text: "l" }] })
      expect(content(cache.visibleRange("s1")!.blocks[0])).toBe("hel")
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 3, text: "l" }] })
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 4, text: "o" }] })
      expect(content(cache.visibleRange("s1")!.blocks[0])).toBe("hel")
      // A user message echo is latency-critical and never waits for the frame.
      fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "insert", index: 1, blockId: "userMessage:m", block: userMessageBlock("m", "next") }] })
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["hello", "next"])
      clock += 20
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["hello", "next"])
    })
  })

  it("merges the deltas that queue behind a slow flush into one later frame", async () => {
    await run(async () => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      // A presentation that takes 400 ms per flush, as a long reply's render
      // did: each run moves the clock while the flush is still in progress.
      const presented: string[] = []
      createEffect(() => {
        const block = cache.visibleRange("s1")?.blocks[0]
        if (block !== undefined) presented.push(content(block))
        clock += 400
      })
      cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "he")]))
      presented.length = 0
      clock += 20
      for (const [offset, text] of [[2, "l"], [3, "l"], [4, "o"], [5, "!"]] as const) {
        fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: offset, text }] })
      }
      // The first delta flushes at once; the three that arrived while it ran
      // wait for one frame instead of each flushing alone.
      expect(presented).toEqual(["hel"])
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(presented).toEqual(["hel", "hello!"])
    })
  })

  it("never projects a hole when a reconnect read lands with streamed deltas held behind it", async () => {
    await run(async () => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")
      // The output window's projection memo, which the reported crash ran in.
      const projectWindow = createTranscriptWindowProjector()
      const failures: string[] = []
      const projection = createMemo(() => {
        try {
          return projectWindow(cache.visibleRange("s1"), false).timelineBlocks.length
        } catch (error) {
          failures.push(String(error))
          return -1
        }
      })
      createEffect(() => { projection() })
      await fake.live(cache, "s1", liveView([textBlock("a", "one")]))
      const read = fake.totalCalls().length
      fake.reconnect()
      await Promise.resolve()
      // The reply kept streaming while the reconnect read was in flight: the
      // runtime moved to four blocks, and the intake holds the newest one
      // until the read seeds it.
      clock += 40
      fake.liveDelta("s1", { visibleMessageCount: 4, blocks: [{ kind: "upsert", index: 3, blockId: "text:d", block: textBlock("d", "four") }] })
      fake.settleTotal(read, 3)
      await Promise.resolve()
      fake.settleRange(read, rangeOk([textBlock("a", "one"), textBlock("b", "two"), textBlock("c", "three")], { startBlockIndex: 0, endBlockIndex: 2 }))
      await flushRecovery()
      expect(failures).toEqual([])
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["one", "two", "three", "four"])
    })
  })

  it("keeps the current transcript visible through a rebase and installs the tail that follows", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "before")]))
      const generationBefore = cache.visibleRange("s1")!.generation
      fake.setOutputWindow("s1", [textBlock("a", "before"), textBlock("b", "rebased")])
      fake.invalidate("s1", "rebase")
      // Nothing is blanked while the tail read is in flight.
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["before"])
      await flushRecovery()
      const after = cache.visibleRange("s1")!
      expect(after.blocks.map(content)).toEqual(["before", "rebased"])
      expect(after.generation).not.toBe(generationBefore)
    })
  })

  it("publishes surviving identities at their new coordinates through protected recovery", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient({ s1: [textBlock("a", "first"), textBlock("b", "reading"), textBlock("c", "last")] })
      const cache = createOutputTranscriptCache({ appService: fake.client })
      cache.retain("s1")
      await cache.open("s1")
      cache.protectReader("s1", { following: false, blockIds: ["text:b"] })
      cache.setDisclosure("s1", "text:b", true)
      const generation = cache.visibleRange("s1")?.generation
      fake.invalidate("s1", "rebase")
      await flushRecovery()
      expect(cache.visibleRange("s1")?.blocks.map(blockIdentity)).toContain("text:b")
      expect(cache.visibleRange("s1")?.generation).toBe(generation)
      fake.setOutputWindow("s1", [textBlock("inserted", "older"), textBlock("a", "first"), textBlock("b", "reading"), textBlock("c", "last")])
      fake.invalidate("s1", "rebase")
      await flushRecovery()
      const after = cache.visibleRange("s1")
      expect((after?.window.startBlockIndex ?? 0) + (after?.blocks.findIndex((block) => blockIdentity(block) === "text:b") ?? -1)).toBe(2)
      expect(cache.disclosure("s1", "text:b")).toBe(true)
      expect(cache.isCurrent("s1")).toBe(true)
    })
  })

  it("surfaces recovery failure in the transcript status after the bounded retry budget", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, recoveryBackoff: INSTANT_BACKOFF })
      cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "before")]))
      fake.failOutputWindow(4)
      fake.invalidate("s1", "overflow")
      for (let i = 0; i < 6; i += 1) await flushRecovery()
      const snap = cache.visibleRange("s1")!
      expect(snap.status.kind).toBe("recovery-failed")
      expect(cache.isCurrent("s1")).toBe(false)
      // The window it had stays on screen.
      expect(snap.blocks.map(content)).toEqual(["before"])
      expect(cache.freshness("s1")?.source).toBe("status")
    })
  })

  it("exposes a navigation surface with no block-level render projection", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      await seedTail(cache, fake, "s1")
      const snap = cache.visibleRange("s1")!
      expect(Object.keys(snap).sort()).toEqual(["blocks", "generation", "heightEstimates", "historicalThroughIndex", "seedEpoch", "source", "status", "totalBlocks", "window"])
      const live = cache.view("s1")!
      expect(live.blocks).toBe(snap.blocks)
      expect(live.streamingToolText).toEqual({})
    })
  })

  it("keeps successful updates silent and reports bounded projection metadata without replacing the error", async () => {
    await run(async () => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain("s1")
      const errorLog = spyOn(Log.create({ service: "output-transcript-cache" }), "error").mockImplementation(() => {})
      const infoLog = spyOn(Log.create({ service: "output-transcript-cache" }), "info").mockImplementation(() => {})
      try {
        await fake.live(cache, "s1", liveView([textBlock("a", "safe content")]))
        for (let index = 1; index <= 40; index++) {
          clock += 20
          fake.liveDelta("s1", { visibleMessageCount: index + 1, blocks: [{ kind: "upsert", index, blockId: `text:b${index}`, block: textBlock(`b${index}`, "private content") }] })
        }
        expect(errorLog).not.toHaveBeenCalled()
        expect(infoLog).not.toHaveBeenCalled()

        const blocks = unwrap(cache.visibleRange("s1")!).blocks
        for (let index = 0; index < 10; index++) Reflect.deleteProperty(blocks, index)
        Reflect.set(blocks, 10, undefined)
        const failure = new Error("original failure")
        let thrown: unknown
        try {
          cache.reportProjectionFailure("s1", failure)
        } catch (caught) {
          thrown = caught
        }
        expect(thrown).toBe(failure)
        expect(errorLog).toHaveBeenCalledTimes(1)
        const [message, detail] = errorLog.mock.calls[0]!
        expect(message).toBe("transcript projection failed")
        expect(detail?.error).toBe(failure)
        expect(detail?.lastFlushReason).toBe("immediate")
        expect(detail?.snapshot).toMatchObject({ count: 41, holes: [0, 1, 2, 3, 4, 5, 6, 7], undefinedSlots: [10] })
        expect(detail?.source).toMatchObject({ count: 41, holes: [], undefinedSlots: [] })
        const recent = detail?.recentUpdates
        if (!Array.isArray(recent)) throw new Error("missing recent update metadata")
        expect(recent).toHaveLength(32)
        expect(recent.at(-1)).toMatchObject({ kind: "deltas", publication: "slots", publishedBefore: 40, publishedAfter: 41, publishedOriginBefore: 0, publishedOriginAfter: 0 })
        expect(recent.every((update: { replacements?: readonly number[] }) => (update.replacements?.length ?? 0) <= 8)).toBe(true)
        expect(JSON.stringify(detail)).not.toContain("private content")
        expect(JSON.stringify(detail)).not.toContain("safe content")
      } finally {
        errorLog.mockRestore()
        infoLog.mockRestore()
      }
    })
  })

  it("reports each retained nonempty to empty publication once with bounded identities and no content", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client })
      cache.retain("s1")
      const infoLog = spyOn(Log.create({ service: "output-transcript-cache" }), "info").mockImplementation(() => {})
      try {
        await fake.live(cache, "s1", liveView([]))
        expect(infoLog).not.toHaveBeenCalled()
        const message = { ...userMessageBlock("user", "private message"), submissionIds: ["submission-1"], imageCount: 1 }
        await fake.live(cache, "s1", liveView([message, ...Array.from({ length: 12 }, (_, i) => textBlock(`b${i}`, "private body"))]))
        fake.liveDelta("s1", { visibleMessageCount: 0, truncateTo: 0, blocks: [] })
        expect(infoLog).toHaveBeenCalledTimes(1)
        const [name, detail] = infoLog.mock.calls[0]!
        expect(name).toBe("retained transcript became empty")
        expect(detail).toMatchObject({
          sessionId: "s1", publication: "repave",
          before: { start: 0, end: 12, count: 13, total: 13 },
          after: { count: 0, total: 0 },
          source: { count: 0, total: 0 },
        })
        const before = detail?.before
        if (typeof before !== "object" || before === null || !("samples" in before) || !Array.isArray(before.samples)) throw new Error("missing before samples")
        expect(before.samples).toHaveLength(8)
        expect(before.samples[0]).toMatchObject({ blockId: "userMessage:user", submissionIds: ["submission-1"], imageCount: 1 })
        const recent = detail?.recentUpdates
        if (!Array.isArray(recent)) throw new Error("missing recent updates")
        expect(recent.at(-1)).toMatchObject({ publication: "repave", publishedBefore: 13, publishedAfter: 0 })
        expect(JSON.stringify(detail)).not.toContain("private")
        fake.liveDelta("s1", { visibleMessageCount: 0, truncateTo: 0, blocks: [] })
        expect(infoLog).toHaveBeenCalledTimes(1)
        await fake.live(cache, "s1", liveView([message]))
        fake.liveDelta("s1", { visibleMessageCount: 0, truncateTo: 0, blocks: [] })
        expect(infoLog).toHaveBeenCalledTimes(2)
      } finally { infoLog.mockRestore() }
    })
  })

  it("enriches the divergence record with source and pending publication context", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient({ s1: [textBlock("a", "private seed")] })
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      cache.retain("s1")
      const infoLog = spyOn(Log.create({ service: "output-transcript-cache" }), "info").mockImplementation(() => {})
      try {
        await cache.open("s1")
        for (let i = 0; i < 40; i++) fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: "private seed".length + i, text: "x" }] })
        fake.liveDelta("s1", { visibleMessageCount: 2, blocks: [{ kind: "upsert", index: 1, blockId: "text:pending", block: textBlock("pending", "private pending") }] })
        fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "upsert", index: 0, blockId: "text:other", block: textBlock("other", "private incoming") }] })
        const records = infoLog.mock.calls.filter(([name]) => name === "transcript delta diverged from the resident window")
        expect(records).toHaveLength(1)
        const detail = records[0]![1]
        expect(detail?.detail).toMatchObject({ rejection: { reason: "upsert-identity-mismatch", expectedIdentity: "text:a", incomingIdentity: "text:other" } })
        expect(detail?.snapshot).toMatchObject({ count: 1, samples: [{ blockId: "text:a" }] })
        expect(detail?.source).toMatchObject({ count: 2, samples: [{ blockId: "text:a" }, { blockId: "text:pending" }] })
        const recent = detail?.recentUpdates
        if (!Array.isArray(recent)) throw new Error("missing recent updates")
        expect(recent).toHaveLength(32)
        expect(recent.at(-1)).toMatchObject({ count: 2, publication: "pending", publishedBefore: 1, publishedAfter: 1 })
        expect(JSON.stringify(detail)).not.toContain("private")
        await flushRecovery()
        expect(content(cache.view("s1")?.blocks[0])).toBe("private seed")
      } finally { infoLog.mockRestore() }
    })
  })

  it("drops far pages on evictBefore: residency shrinks, absolute indices stand, older paging re-arms", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })
      const blocks: FrontendOutputBlock[] = Array.from({ length: 5 }, (_, i) => textBlock(`b${i}`, `block ${i}`))
      await fake.live(cache, "s1", liveView(blocks))
      cache.evictBefore("s1", 3)
      const snap = cache.visibleRange("s1")!
      expect(snap.blocks.map(content)).toEqual(["block 3", "block 4"])
      expect(snap.window).toMatchObject({ startBlockIndex: 3, endBlockIndex: 4, hasBefore: true })
      expect(snap.totalBlocks).toBe(5)
      const paging = cache.loadPage("s1", "older")
      expect(fake.rangeCalls().at(-1)!.request.anchor).toEqual({ kind: "beforeBlock", blockId: "text:b3" })
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b1", "block 1"), textBlock("b2", "block 2")], { startBlockIndex: 1, endBlockIndex: 2, hasBefore: true, hasAfter: true }))
      await expect(paging).resolves.toBe("loaded")
      expect(cache.visibleRange("s1")!.window.startBlockIndex).toBe(1)
    })
  })
})
