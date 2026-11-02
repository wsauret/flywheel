/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { createOutputTranscriptCache } from "../../../src/tui/transcript-store/create-output-transcript-cache.js"
import type { OutputTranscriptView, TranscriptSnapshot, TranscriptStatus, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import type { OutputWindowCommand } from "../../../src/tui/output-window/output-window.js"
import type { TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import { LINE_WHEEL } from "../../../src/tui/output-window/output-window-wheel.js"
import { DEFAULT_ESTIMATE, heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import { fakeRuntimeClient, liveView } from "./hooks/_output-transcript-cache-fixtures.js"
import { scrollFrameHook } from "../../helpers/scroll-frame-hook.js"

function textBlock(id: string, content: string): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function questionBlock(toolUseId: string): FrontendOutputBlock {
  return { kind: "question", toolUseId, questions: [{ question: "Continue?", choices: [], multiSelect: false }], timestamp: 1 }
}

function windowOf(over: Partial<TranscriptWindow> = {}): TranscriptWindow {
  return { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, estimatedRows: 1, contentBytes: 17, ...over }
}

function snapshot(over: { blocks: readonly FrontendOutputBlock[]; totalBlocks: number; window: TranscriptWindow; heightEstimates?: TranscriptSnapshot["heightEstimates"]; consistencyToken?: string }): TranscriptSnapshot {
  return {
    status: { kind: "partial" } satisfies TranscriptStatus,
    source: { kind: "historical", consistencyToken: over.consistencyToken ?? "g1" },
    totalBlocks: over.totalBlocks,
    window: over.window,
    heightEstimates: over.heightEstimates ?? heightEstimatesFromBlocks(over.blocks, over.window.startBlockIndex ?? 0, true),
    blocks: over.blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

async function renderWindow(
  view: OutputTranscriptView,
  onNearEdge: (direction: "older" | "newer") => void,
  command?: () => OutputWindowCommand | undefined,
  layoutSlot: TranscriptLayoutSlot = {},
): Promise<{ scrollbox: ScrollBoxRenderable; result: Awaited<ReturnType<typeof testRender>> }> {
  const [{ OutputWindow }, { ThemeProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
  ])
  let scrollbox!: ScrollBoxRenderable
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(OutputWindow, {
          layoutSlot,
          transcript: view,
          running: false,
          // One row per report on every host: these tests count rows.
          wheel: LINE_WHEEL,
          captureScrollbox: (el: ScrollBoxRenderable) => { scrollbox = el },
          onNearEdge,
          get command() { return command?.() },
          sessionIntro: {
            moduleRows: () => [],
            runtimeIdentity: () => ({ version: "0.0.0-test", buildId: null }), showBuild: () => false,
            projectRoot: () => "/scratch/project",
            accountHome: "/scratch/home",
            userDataRoot: "/scratch/home/.flywheel",
            branchName: () => undefined,
            sessionKind: () => "chat" as const,
            modelLabel: () => undefined,
            profileName: () => "default",
            fontTipDismissed: () => false,
            tabsHintDismissed: () => false, onDismissTabsHint: () => {},
            availableWidth: () => 60,
            noProviderReady: () => false,
          },
        })
      },
    }),
    { width: 60, height: 8 },
  )
  await result.flush()
  return { scrollbox, result }
}


describe("OutputWindow near-edge paging", () => {
  it("repairs an underfilled resident window by paging older, not by re-hydrating the anchor", async () => {
    // The collapsed-window failure shape: a recovery repave left 2 resident
    // blocks at the tail of a long transcript (hasBefore=true), shorter than
    // the viewport. An afterBlock anchor hydrate can never extend the window
    // upward, so re-firing it every frame is a request storm that starves
    // older paging; the deficit must route to onNearEdge("older") instead.
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: [textBlock("b283", "row 283"), textBlock("b284", "row 284")],
      totalBlocks: 285,
      window: windowOf({ startBlockIndex: 283, endBlockIndex: 284, hasBefore: true, estimatedRows: 2 }),
    }))
    const edges: string[] = []
    let hydrates = 0
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => { hydrates += 1 },
      loadAround: async () => {},
      hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
    }
    const { scrollbox, result } = await renderWindow(view, (direction) => { edges.push(direction) })
    try {
      const update = scrollFrameHook(scrollbox)
      for (let i = 0; i < 5; i += 1) update(16)
      expect(edges).toContain("older")
      expect(hydrates).toBe(0)
    } finally {
      result.renderer.destroy()
    }
  })

  it("checks near-edge paging when the window changes under the same scroll offset", async () => {
    const [snap, set] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: Array.from({ length: 100 }, (_, i) => textBlock(`b${i}`, `row ${i}`)),
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 0, endBlockIndex: 99, hasBefore: false, estimatedRows: 100 }),
    }))
    const edges: string[] = []
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
	      hydrateAnchor: async () => {},
        loadAround: async () => {},
        hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
	      setDisclosure: () => {},
	      disclosure: () => undefined,
	    }
    const { scrollbox, result } = await renderWindow(view, (direction) => { edges.push(direction) })
    try {
      const update = scrollFrameHook(scrollbox)
      // User intent arrives ONLY through input events now (ownership inversion):
      // wheel up well into the window; a raw scrollTop write would be enforced
      // away as a layout nudge.
      // Mounted rows measure ~2 rows each (block + selection spacer), so the
      // ~200-row extent needs a deep wheel run to land near future block 45.
      for (let i = 0; i < 135; i += 1) await result.mockMouse.scroll(2, 2, "up")
      // Wheel input coalesces and drains a bounded step per frame now; run
      // enough frames to apply the whole burst.
      for (let i = 0; i < 30; i += 1) update(16)
      expect(edges).toEqual([])

      set(snapshot({
        blocks: Array.from({ length: 55 }, (_, i) => textBlock(`b${45 + i}`, `row ${45 + i}`)),
        totalBlocks: 100,
        window: windowOf({ startBlockIndex: 45, endBlockIndex: 99, hasBefore: true, estimatedRows: 55 }),
      }))
      await result.flush()
      for (let i = 0; i < 4; i += 1) update(16)

      expect(edges).toContain("older")
    } finally {
      result.renderer.destroy()
    }
  })

  it("signals older while the viewport rests in the unhydrated top spacer", async () => {
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`)),
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 59, hasBefore: true, hasAfter: true, estimatedRows: 20 }),
    }))
    const edges: string[] = []
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
	      hydrateAnchor: async () => {},
        loadAround: async () => {},
        hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
	      setDisclosure: () => {},
	      disclosure: () => undefined,
	    }
    const { scrollbox, result } = await renderWindow(view, (direction) => { edges.push(direction) })
    try {
      const update = scrollFrameHook(scrollbox)

      // The mid-history window opens anchored at its head (block 40); wheel up
      // INTO the unhydrated top spacer.
      update(16)
      const initialTop = scrollbox.scrollTop
      for (let i = 0; i < 4; i += 1) await result.mockMouse.scroll(2, 2, "up")
      for (let i = 0; i < 3; i += 1) update(16) // frame-drained wheel backlog

      expect(edges).toContain("older")
      expect(scrollbox.scrollTop).toBe(initialTop - 4)
      // The controller enforces its authoritative offset over layout nudges.
      update(16)
      expect(scrollbox.scrollTop).toBe(initialTop - 4)
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not replay an already-present output command on remount", async () => {
    const blocks = Array.from({ length: 60 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const snap = snapshot({
      blocks,
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 99, hasBefore: true, estimatedRows: 60 }),
    })
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap,
      visibleMessageCount: () => snap.totalBlocks,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => {},
      loadAround: async () => {},
      hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
    }
    const [command, setCommand] = createSignal<OutputWindowCommand | undefined>({ id: 1, type: "bottom" })
    const layoutSlot: TranscriptLayoutSlot = {
      scroll: {
        offset: 12,
        anchor: undefined,
        textDepth: 0,
        generation: 1,
        lastMaxScrollTop: 80,
        pendingTailIntent: false,
        lastLeadingRows: 0,
        lastViewportWidth: 0,
        lastViewportRows: 0,
        landed: false,
      },
    }
    const { result } = await renderWindow(view, () => {}, command, layoutSlot)

    try {
      const restoredOffset = layoutSlot.scroll?.offset
      if (restoredOffset === undefined) throw new Error("scroll state was not restored")
      expect(restoredOffset).toBe(12)

      setCommand({ id: 2, type: "bottom" })
      await result.flush()
      expect(layoutSlot.scroll?.offset).toBeGreaterThan(restoredOffset)
    } finally {
      result.renderer.destroy()
    }
  })
  it("runs edge detection for repeated page-up commands from the virtual top spacer", async () => {
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`)),
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 59, hasBefore: true, hasAfter: true, estimatedRows: 20 }),
    }))
    const [command, setCommand] = createSignal<OutputWindowCommand | undefined>()
    const edges: string[] = []
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
	      hydrateAnchor: async () => {},
        loadAround: async () => {},
        hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
	      setDisclosure: () => {},
	      disclosure: () => undefined,
	    }
    const { scrollbox, result } = await renderWindow(view, (direction) => { edges.push(direction) }, command)
    try {
      const update = scrollFrameHook(scrollbox)
      setCommand({ id: 1, type: "top" })
      await result.flush()

      edges.length = 0
      setCommand({ id: 2, type: "page-up" })
      await result.flush()
      update(16)
      expect(edges).toContain("older")

      edges.length = 0
      setCommand({ id: 3, type: "page-up" })
      await result.flush()
      update(16)
      expect(edges).toContain("older")
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not re-pin to bottom when a wheel scroll races an older prepend", async () => {
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${80 + i}`, `row ${80 + i}`))
    const [snap, set] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: tail,
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 80, endBlockIndex: 99, hasBefore: true, estimatedRows: 20 }),
    }))
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => {},
      loadAround: async () => {},
      hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
    }
    const { scrollbox, result } = await renderWindow(view, () => {})
    try {
      const update = scrollFrameHook(scrollbox)
      const bottomBefore = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
      expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(bottomBefore - 1)

      await result.mockMouse.scroll(2, 2, "up")
      update(16) // wheel input applies on the next frame
      expect(scrollbox.scrollTop).toBeLessThan(bottomBefore)

      set(snapshot({
        blocks: [
          ...Array.from({ length: 20 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`)),
          ...tail,
        ],
        totalBlocks: 100,
        window: windowOf({ startBlockIndex: 60, endBlockIndex: 99, hasBefore: true, estimatedRows: 40 }),
      }))
      await result.flush()

      const bottomAfter = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
      expect(scrollbox.scrollTop).toBeLessThan(bottomAfter)

      update(16)
      const anchoredTop = scrollbox.scrollTop
      expect(anchoredTop).toBeLessThan(bottomAfter)
      set(snapshot({
        blocks: [
          ...Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`)),
          ...Array.from({ length: 20 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`)),
          ...tail,
        ],
        totalBlocks: 100,
        window: windowOf({ startBlockIndex: 40, endBlockIndex: 99, hasBefore: true, estimatedRows: 60 }),
      }))
      await result.flush()
      update(16)

      // The prepended blocks start from the TUI DEFAULT_ESTIMATE, then mounted
      // rows can measure shorter and shrink the upstream extent. That correction
      // is anchor compensation, not bottom-follow intent: the viewport moves by
      // the same extent delta and remains below the bottom.
      const bottomAfterClamp = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
      const upstreamExtentDelta = bottomAfterClamp - bottomAfter
      expect(scrollbox.scrollTop).toBe(anchoredTop + upstreamExtentDelta)
      expect(scrollbox.scrollTop).toBeLessThan(bottomAfterClamp)
    } finally {
      result.renderer.destroy()
    }
  })

  it("preserves explicit scroll-away through bursty tail growth and resumes follow after a bottom command", async () => {
    await createRoot(async (dispose) => {
      const sessionId = "s1"
      let clock = 1000
      const initial = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`, `row ${i}`))
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      cache.retain(sessionId)
      await fake.live(cache, sessionId, liveView(initial))
      const seeded = cache.visibleRange(sessionId)
      if (!seeded) throw new Error("expected a seeded snapshot")
      const estimatesBefore = seeded.heightEstimates
      const generationBefore = seeded.generation
      const [command, setCommand] = createSignal<OutputWindowCommand | undefined>()
      const view: OutputTranscriptView = {
        mutationEvidence: () => cache.mutationEvidence(sessionId),
        protectReader: (reader) => cache.protectReader(sessionId, reader),
        reportProjectionFailure: (error) => cache.reportProjectionFailure(sessionId, error),
        visibleRange: () => cache.visibleRange(sessionId),
        visibleMessageCount: () => cache.visibleMessageCount(sessionId),
        jumpToLatest: () => cache.jumpToLatest(sessionId),
        freshness: () => cache.freshness(sessionId),
        hydrateAnchor: () => cache.hydrateAnchor(sessionId),
        loadAround: (entryId) => cache.loadAround(sessionId, entryId),
        hydrateBlockBody: (blockId) => { void cache.hydrateBlockBody(sessionId, blockId) },
        takeEstimateUpdates: () => cache.takeEstimateUpdates(sessionId),
        evictBefore: (blockIndex) => { cache.evictBefore(sessionId, blockIndex) },
        setDisclosure: (key, expanded) => { cache.setDisclosure(sessionId, key, expanded) },
        disclosure: (key) => cache.disclosure(sessionId, key),
      }
      const { scrollbox, result } = await renderWindow(view, () => {}, command)
      try {
        const update = scrollFrameHook(scrollbox)
        for (let i = 0; i < 4; i += 1) await result.mockMouse.scroll(2, 2, "up")
        update(16)
        const scrolledAwayTop = scrollbox.scrollTop
        const heightBeforeBurst = scrollbox.scrollHeight

        for (let i = 0; i < 20; i += 1) {
          clock += 1
          const blockId = `b${30 + i}`
          const block = textBlock(blockId, `row ${30 + i}`)
          fake.liveDelta(sessionId, {
            visibleMessageCount: initial.length + i + 1,
            blocks: [{ kind: "insert", index: initial.length + i, blockId: `text:${blockId}`, block }],
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        await result.flush()
        update(16)

        const appended = cache.visibleRange(sessionId)
        expect(appended?.generation).toBe(generationBefore)
        expect(appended?.heightEstimates).toBe(estimatesBefore)
        expect(scrollbox.scrollTop).toBe(scrolledAwayTop)
        expect(scrollbox.scrollHeight).toBeGreaterThan(heightBeforeBurst)
        expect(scrollbox.scrollTop).toBeLessThan(Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height))

        setCommand({ id: 1, type: "bottom" })
        await result.flush()
        update(16)
        clock += 20
        const following = textBlock("b50", "row 50")
        fake.liveDelta(sessionId, {
          visibleMessageCount: 51,
          blocks: [{ kind: "insert", index: 50, blockId: "text:b50", block: following }],
        })
        await result.flush()
        update(16)
        expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height) - 1)
      } finally {
        result.renderer.destroy()
        dispose()
      }
    })
  })

  it("releases the retained scroll extent after an older prepend re-anchors", async () => {
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${80 + i}`, `row ${80 + i}`))
    const inflatedRows = DEFAULT_ESTIMATE * 8
    const inflatedTailEstimates = tail.map((_block, offset) => ({ blockIndex: 80 + offset, rows: inflatedRows }))
    const [state, setState] = createStore({
      snap: snapshot({
        blocks: tail,
        totalBlocks: 100,
        window: windowOf({ startBlockIndex: 80, endBlockIndex: 99, hasBefore: true, estimatedRows: tail.length * inflatedRows }),
        heightEstimates: inflatedTailEstimates,
      }),
    })
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => state.snap,
      visibleMessageCount: () => state.snap.totalBlocks,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => {},
      loadAround: async () => {},
      hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
    }
    const { scrollbox, result } = await renderWindow(view, () => {})
    try {
      const retainedHeight = scrollbox.scrollHeight
      await result.mockMouse.scroll(2, 2, "up")

      setState("snap", reconcile(snapshot({
        blocks: [
          ...Array.from({ length: 20 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`)),
          ...tail,
        ],
        totalBlocks: 100,
        window: windowOf({ startBlockIndex: 60, endBlockIndex: 99, hasBefore: true, estimatedRows: 40 * DEFAULT_ESTIMATE }),
      })))
      await result.flush()

      expect(scrollbox.scrollHeight).toBeLessThan(retainedHeight)
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not jump to the transcript tail for a mid-history unanswered question", async () => {
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshot({
      blocks: [
        ...Array.from({ length: 19 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`)),
        questionBlock("ask_mid"),
      ],
      totalBlocks: 100,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 59, hasBefore: true, hasAfter: true, estimatedRows: 20 }),
    }))
    const view: OutputTranscriptView = {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap()?.totalBlocks ?? 0,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => {},
      loadAround: async () => {},
      hydrateBlockBody: () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
    }
    const { scrollbox, result } = await renderWindow(view, () => {})
    try {
      await result.flush()
      expect(scrollbox.scrollTop).toBeLessThan(Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height))
    } finally {
      result.renderer.destroy()
    }
  })
})
