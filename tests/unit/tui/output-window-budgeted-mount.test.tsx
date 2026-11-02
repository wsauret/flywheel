/** @jsxImportSource @opentui/solid */

/** Regression: mounting beyond the viewport is budgeted per painted frame.
 *  A session open or an overscan splice must never mount an unbounded block
 *  batch in one frame (the profiled cause of scroll hitches and the tab-open
 *  freeze), the viewport itself is always covered synchronously, and budgeted
 *  backfill above the tail must not move a pinned viewport. */

import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, it, spyOn } from "bun:test"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { OutputTranscriptView, TranscriptSnapshot, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import type { TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import { widenTowards } from "../../../src/tui/output-window/output-window-viewport.js"
import { scrollFrameHook } from "../../helpers/scroll-frame-hook.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../../src/infra/output-blocks.js"
import { ManualClock } from "@opentui/core/testing"
import { buildMutationDiff } from "../../../src/infra/mutation-diff.js"
import { getToolDisplay, resolveToolPresentation } from "../../../src/infra/tools/tool-display-registry.js"
import { createBlockDisclosureChannel } from "../../../src/tui/context/block-disclosure.js"
import { mutationEvidenceFixture } from "./output-blocks/_mutation-evidence-fixture.js"
import { makeView, renderScheduledFrame, renderWindow as renderScheduledWindow, snapshot, transcriptOf } from "./_output-window-transcript.js"

describe("widenTowards", () => {
  const r = (start: number, end: number) => ({ start, end })

  it("spends at most one budget per step, including the first emission, and reaches the goal", () => {
    const goal = r(0, 100)
    const must = r(40, 50)
    let range = widenTowards({ prev: undefined, goal, must, budget: 10, upFirst: false })
    expect(range.end - range.start).toBeLessThanOrEqual(10 + (must.end - must.start))
    for (let step = 0; step < 20; step += 1) {
      const next = widenTowards({ prev: range, goal, must, budget: 10, upFirst: false })
      const grown = Math.max(0, range.start - next.start) + Math.max(0, next.end - range.end)
      expect(grown).toBeLessThanOrEqual(10)
      range = next
    }
    expect(range).toEqual(goal)
  })

  it("always covers the viewport range even with a zero budget", () => {
    const next = widenTowards({ prev: r(0, 5), goal: r(60, 90), must: r(70, 75), budget: 0, upFirst: false })
    expect(next.start).toBeLessThanOrEqual(70)
    expect(next.end).toBeGreaterThanOrEqual(75)
  })

  it("shrinks past-goal edges immediately", () => {
    const next = widenTowards({ prev: r(0, 100), goal: r(40, 60), must: r(45, 55), budget: 5, upFirst: false })
    expect(next).toEqual(r(40, 60))
  })

  it("prefers the scroll-direction edge", () => {
    const up = widenTowards({ prev: r(50, 60), goal: r(30, 80), must: r(52, 58), budget: 10, upFirst: true })
    expect(up.start).toBe(40)
    expect(up.end).toBe(60)
    const down = widenTowards({ prev: r(50, 60), goal: r(30, 80), must: r(52, 58), budget: 10, upFirst: false })
    expect(down.start).toBe(50)
    expect(down.end).toBe(70)
  })

  it("reseeds at the viewport after a disjoint jump, spending one budget direction-first", () => {
    const next = widenTowards({ prev: r(0, 10), goal: r(500, 700), must: r(590, 600), budget: 12, upFirst: true })
    expect(next.start).toBeLessThanOrEqual(590)
    expect(next.end).toBeGreaterThanOrEqual(600)
    // One budget total beyond the viewport cover, allocated upward first.
    expect((590 - next.start) + (next.end - 600)).toBeLessThanOrEqual(12)
    expect(next.start).toBe(590 - 12)
  })
})

function textBlock(index: number): FrontendOutputBlock {
  return { kind: "text", id: `b${index}`, content: `row ${index}`, timestamp: index }
}

/** Renders 2 rows at the 80-column test width while the snapshot estimates 1,
 *  so mounting it drains a real estimate-to-measured correction. */
function wideBlock(index: number): FrontendOutputBlock {
  return { kind: "text", id: `b${index}`, content: `row ${index} ${"pad ".repeat(30)}`, timestamp: index }
}

function snapshotOf(blocks: readonly FrontendOutputBlock[], window: TranscriptWindow, totalBlocks: number): TranscriptSnapshot {
  return {
    status: { kind: "partial" },
    source: { kind: "historical", consistencyToken: "g-budget" },
    totalBlocks,
    window,
    heightEstimates: Array.from({ length: totalBlocks }, (_value, blockIndex) => ({ blockIndex, rows: 1 })),
    blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

function viewOf(snap: TranscriptSnapshot): OutputTranscriptView {
  return makeView(snap).view
}

async function renderWindow(
  view: OutputTranscriptView,
  layoutSlot: TranscriptLayoutSlot = {},
  showThinking: () => boolean = () => false,
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
          get showThinking() { return showThinking() },
          captureScrollbox: (el: ScrollBoxRenderable) => { scrollbox = el },
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
            availableWidth: () => 80,
            noProviderReady: () => false,
          },
        })
      },
    }),
    { width: 80, height: 10 },
  )
  await result.flush()
  return { scrollbox, result }
}

function frameTicker(scrollbox: ScrollBoxRenderable, result: { flush: () => Promise<void> }) {
  const update = scrollFrameHook(scrollbox)
  return async () => {
    update(16)
    await result.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("OutputWindow budgeted mounting", () => {
  it("grows the eager measure pass a bounded batch per frame instead of mounting the whole session", async () => {
    // 601 head-hydrated blocks fit the resident budget, so the old eager path
    // mounted all of them before the first paint. Budgeted growth must paint
    // the tail neighborhood first and add a bounded batch per frame.
    const blocks = Array.from({ length: 601 }, (_value, offset) => textBlock(offset))
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: 600, hasBefore: false, hasAfter: false, estimatedRows: 601, contentBytes: 0 }, 601)
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      // First paint: viewport neighborhood only, nowhere near 601 children.
      expect(scrollbox.getChildren().length).toBeLessThan(120)
      const tick = frameTicker(scrollbox, result)
      let previous = scrollbox.getChildren().length
      for (let i = 0; i < 6; i += 1) {
        await tick()
        const current = scrollbox.getChildren().length
        // A tick can span three painted frames when the renderer schedules an
        // extra flush under load. Each frame adds at most the 12-block budget,
        // plus a small number of chrome nodes, never an unbounded batch.
        expect(current - previous).toBeLessThanOrEqual(40)
        previous = current
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the tail pinned and the frame stable while backfill mounts above with wrong estimates", async () => {
    // Wide blocks render 2 rows at width 80 while every estimate claims 1 row,
    // so each backfill batch above the viewport drains real estimate-to-
    // measured corrections. The pinned tail frame must absorb them without
    // moving or blanking on ANY frame - update ticks and flush renders are
    // asserted separately so a one-frame shift cannot hide inside a tick.
    const blocks = Array.from({ length: 601 }, (_value, offset) => wideBlock(offset))
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: 600, hasBefore: false, hasAfter: false, estimatedRows: 601, contentBytes: 0 }, 601)
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      const tick = frameTicker(scrollbox, result)
      await tick()
      const settled = result.captureCharFrame()
      expect(settled).toContain("row 600")
      const update = scrollFrameHook(scrollbox)
      for (let i = 0; i < 24; i += 1) {
        update(16)
        expect(result.captureCharFrame()).toBe(settled)
        await result.flush()
        expect(result.captureCharFrame()).toBe(settled)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(result.captureCharFrame()).toBe(settled)
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("holds an off-tail anchored row still while budgeted backfill corrects estimates above it", async () => {
    const blocks = Array.from({ length: 601 }, (_value, offset) => wideBlock(offset))
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: 600, hasBefore: false, hasAfter: false, estimatedRows: 601, contentBytes: 0 }, 601)
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      const tick = frameTicker(scrollbox, result)
      await tick()
      // Leave the tail: wheel input disarms follow and anchors the position.
      await result.mockMouse.scroll(2, 2, "up")
      await tick()
      const parked = result.captureCharFrame()
      const markerLine = parked.split("\n").findIndex((line) => line.includes("row 5"))
      expect(markerLine).toBeGreaterThanOrEqual(0)
      const marker = /row \d+/.exec(parked.split("\n")[markerLine] ?? "")?.[0] ?? ""
      // Backfill mounts and corrects above for many frames; the anchored
      // semantic row must stay on (or within one row of) its screen line.
      for (let i = 0; i < 16; i += 1) {
        await tick()
        const lines = result.captureCharFrame().split("\n")
        const found = lines.findIndex((line) => line.includes(marker))
        expect(found).toBeGreaterThanOrEqual(0)
        expect(Math.abs(found - markerLine)).toBeLessThanOrEqual(1)
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("completes the eager measure pass through budgeted growth, then virtualizes down", async () => {
    // Wide blocks measure 2 rows against 1-row estimates: the final extent
    // (~480 rows) is provably measured, not estimated - an early latch that
    // virtualized before full coverage would leave the extent near 240.
    const blocks = Array.from({ length: 240 }, (_value, offset) => wideBlock(offset))
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: 239, hasBefore: false, hasAfter: false, estimatedRows: 240, contentBytes: 0 }, 240)
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      const tick = frameTicker(scrollbox, result)
      // 240 blocks / 12 per frame = 20 growth frames; allow slack for the
      // shrink after the fullyMeasured latch flips.
      for (let i = 0; i < 40; i += 1) await tick()
      // Latched and virtualized: children track the viewport neighborhood.
      expect(scrollbox.getChildren().length).toBeLessThan(180)
      // The extent reflects MEASURED two-row blocks across the whole
      // transcript, proving the latch waited for full coverage.
      expect(scrollbox.scrollHeight).toBeGreaterThanOrEqual(400)
      expect(result.captureCharFrame()).toContain("row 239")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps eager completion and geometry in the caller-owned slot across hidden tail growth", async () => {
    const layoutSlot: TranscriptLayoutSlot = {}
    const initialBlocks = Array.from({ length: 240 }, (_value, offset) => wideBlock(offset))
    const initial = snapshotOf(initialBlocks, { startBlockIndex: 0, endBlockIndex: 239, hasBefore: false, hasAfter: false, estimatedRows: 240, contentBytes: 0 }, 240)
    const first = await renderWindow(viewOf(initial), layoutSlot)
    let measuredRows = 0
    let index: NonNullable<TranscriptLayoutSlot["heightIndex"]>["index"]
    let scroll: NonNullable<TranscriptLayoutSlot["scroll"]>
    try {
      const tick = frameTicker(first.scrollbox, first.result)
      for (let i = 0; i < 40; i += 1) await tick()
      expect(layoutSlot.heightIndex?.eagerCompleted).toBe(true)
      index = layoutSlot.heightIndex!.index
      if (!layoutSlot.scroll) throw new Error("scroll state was not initialized")
      scroll = layoutSlot.scroll
      scroll.offset = 0
      scroll.anchor = undefined
      scroll.pendingTailIntent = false
      measuredRows = index.totalRows()
      expect(first.scrollbox.getChildren().length).toBeLessThan(180)
    } finally {
      first.result.renderer.destroy()
    }

    const grownBlocks = Array.from({ length: 300 }, (_value, offset) => wideBlock(offset))
    const grown = snapshotOf(grownBlocks, { startBlockIndex: 0, endBlockIndex: 299, hasBefore: false, hasAfter: false, estimatedRows: 300, contentBytes: 0 }, 300)
    const second = await renderWindow(viewOf(grown), layoutSlot)
    try {
      const tick = frameTicker(second.scrollbox, second.result)
      expect(layoutSlot.heightIndex?.index).toBe(index!)
      expect(layoutSlot.scroll).toBe(scroll!)
      expect(layoutSlot.heightIndex?.eagerCompleted).toBe(true)
      expect(second.scrollbox.getChildren().length).toBeLessThan(180)
      expect(second.scrollbox.scrollHeight).toBeGreaterThanOrEqual(measuredRows)
      for (let i = 0; i < 10; i += 1) await tick()
      expect(second.scrollbox.getChildren().length).toBeLessThan(180)
      expect(index!.hasMeasured(299)).toBe(false)
    } finally {
      second.result.renderer.destroy()
    }
  })

  const fillerPatch = ["--- a/src/example.ts", "+++ b/src/example.ts", "@@ -1,26 +1,26 @@", ...Array.from({ length: 26 }, (_line, index) => ` const filler${index} = ${index}`)].join("\n")

  async function renderEvidenceRow(patch = fillerPatch, lines = 26) {
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch, lines }])
    const metadata = Promise.withResolvers<void>()
    const bytes = Promise.withResolvers<void>()
    fixture.holdFiles(metadata.promise)
    fixture.holdPatches(bytes.promise)
    const edit: FrontendOutputBlock = { kind: "tool", id: "edit-1", name: "edit", presentation: { name: "Edit", detail: "src/example.ts" }, status: "completed", fileChangeKind: "patch", mutationEvidence: fixture.evidence, timestamp: 1 }
    const blocks = [textBlock(0), edit, textBlock(2)]
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: 2, hasBefore: false, hasAfter: false, estimatedRows: 3, contentBytes: 0 }, 3)
    const layoutSlot: TranscriptLayoutSlot = {}
    const [showThinking, setShowThinking] = createSignal(false)
    const { scrollbox, result } = await renderWindow({ ...viewOf(snap), mutationEvidence: () => fixture.reader }, layoutSlot, showThinking)
    const tick = frameTicker(scrollbox, result)
    for (let i = 0; i < 6; i += 1) await tick()
    return { fixture, metadata, bytes, layoutSlot, result, tick, setShowThinking, dispose: () => {
      metadata.resolve()
      bytes.resolve()
      result.renderer.destroy()
      fixture.reader.dispose()
    } }
  }

  it("records an evidence row's final reserved height before the eager latch flips, without waiting for patch bytes", async () => {
    const { fixture, metadata, bytes, layoutSlot, result, tick, setShowThinking, dispose } = await renderEvidenceRow()
    const editRows = () => {
      const index = layoutSlot.heightIndex!.index
      return index.blockIndexToRowOffset(2) - index.blockIndexToRowOffset(1)
    }
    try {
      // Every row has laid out, but the evidence row's headings and reservation are not known yet.
      expect(layoutSlot.heightIndex?.eagerCompleted).toBeFalsy()
      // A width change and a visibility change each ask every mounted row for its height.
      // The held row stays unmeasured, so the latch stays open and keeps it mounted.
      result.resize(100, 10)
      for (let i = 0; i < 3; i += 1) await tick()
      expect(layoutSlot.heightIndex?.index.hasMeasured(1)).toBe(false)
      expect(layoutSlot.heightIndex?.eagerCompleted).toBeFalsy()
      setShowThinking(true)
      for (let i = 0; i < 3; i += 1) await tick()
      expect(layoutSlot.heightIndex?.index.hasMeasured(1)).toBe(false)
      expect(layoutSlot.heightIndex?.eagerCompleted).toBeFalsy()
      metadata.resolve()
      for (let i = 0; i < 6; i += 1) await tick()
      expect(layoutSlot.heightIndex?.eagerCompleted).toBe(true)
      const reserved = editRows()
      expect(reserved).toBeGreaterThan(TOOL_PREVIEW_LINE_LIMIT)
      bytes.resolve()
      for (let i = 0; i < 6; i += 1) { await tick(); await fixture.settle() }
      expect(editRows()).toBe(reserved)
    } finally { dispose() }
  })

  it("records a collapsed file that wraps past the preview rows at its final height, note included, on its first report", async () => {
    const { fixture, metadata, layoutSlot, result, tick, dispose } = await renderEvidenceRow(`--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n+${"wrapped ".repeat(400)}`, 1)
    const index = layoutSlot.heightIndex!.index
    const reports = spyOn(index, "reportMeasured")
    try {
      expect(index.hasMeasured(1)).toBe(false)
      metadata.resolve()
      for (let i = 0; i < 8; i += 1) { await tick(); await fixture.settle() }
      const heights = reports.mock.calls.flatMap(([block, rows]) => block === 1 ? [rows] : [])
      expect(heights.length).toBeGreaterThan(0)
      expect(heights.every(rows => rows === heights[0])).toBe(true)
      expect(index.blockIndexToRowOffset(2) - index.blockIndexToRowOffset(1)).toBe(heights[0]!)
      expect(result.captureCharFrame()).toContain("... more content (click to expand)")
    } finally { reports.mockRestore(); dispose() }
  })

  it("records an evidence row's settled height when its metadata lands while a frame is presenting", async () => {
    const patch = ["--- a/src/example.ts", "+++ b/src/example.ts", "@@ -1,26 +1,26 @@", ...Array.from({ length: 26 }, (_line, index) => ` const filler${index} = ${index}`)].join("\n")
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch, lines: 26 }])
    const metadata = Promise.withResolvers<void>()
    fixture.holdFiles(metadata.promise)
    // The evidence row sits far above the bottom-anchored viewport, outside the overscan.
    const edit: FrontendOutputBlock = { kind: "tool", id: "edit-1", name: "edit", presentation: { name: "Edit", detail: "src/example.ts" }, status: "completed", fileChangeKind: "patch", mutationEvidence: fixture.evidence, timestamp: 1 }
    const blocks = [textBlock(0), edit, ...Array.from({ length: 240 }, (_value, offset) => textBlock(offset + 2))]
    const snap = snapshotOf(blocks, { startBlockIndex: 0, endBlockIndex: blocks.length - 1, hasBefore: false, hasAfter: false, estimatedRows: blocks.length, contentBytes: 0 }, blocks.length)
    const layoutSlot: TranscriptLayoutSlot = {}
    const { scrollbox, result } = await renderWindow({ ...viewOf(snap), mutationEvidence: () => fixture.reader }, layoutSlot)
    const tick = frameTicker(scrollbox, result)
    // OpenTUI awaits the native presentation between a frame's layout and its "frame" event,
    // so a metadata reply can land inside that window. This frame lets it land there.
    const renderer = result.renderer
    const emit = renderer.emit.bind(renderer)
    let landInFrame = false
    let landed: Promise<void> | undefined
    renderer.emit = (event: string | symbol, ...args: unknown[]): boolean => {
      if (event !== "frame" || !landInFrame) return emit(event, ...args)
      landInFrame = false
      landed = (async () => {
        metadata.resolve()
        await fixture.settle()
        emit(event, ...args)
      })()
      return true
    }
    // The renderer emits "frame" only while something listens for it.
    renderer.on("frame", () => {})
    try {
      for (let i = 0; i < 40; i += 1) await tick()
      const index = () => layoutSlot.heightIndex!.index
      expect(index().hasMeasured(1)).toBe(false)
      expect(layoutSlot.heightIndex?.eagerCompleted).toBeFalsy()
      landInFrame = true
      await result.renderOnce()
      await landed
      for (let i = 0; i < 12; i += 1) await tick()
      expect(fixture.reader.open("tool:edit-1", fixture.evidence.manifest).files.status).toBe("ready")
      expect(layoutSlot.heightIndex?.eagerCompleted).toBe(true)
      expect(index().blockIndexToRowOffset(2) - index().blockIndexToRowOffset(1)).toBeGreaterThan(TOOL_PREVIEW_LINE_LIMIT)
    } finally {
      metadata.resolve()
      result.renderer.destroy()
      fixture.reader.dispose()
    }
  })

  it("flips the eager latch when an evidence row's metadata request fails", async () => {
    const { fixture, metadata, layoutSlot, tick, dispose } = await renderEvidenceRow()
    try {
      expect(layoutSlot.heightIndex?.eagerCompleted).toBeFalsy()
      fixture.failFiles(true)
      metadata.resolve()
      for (let i = 0; i < 6; i += 1) await tick()
      expect(fixture.reader.open("tool:edit-1", fixture.evidence.manifest).files.status).toBe("error")
      expect(layoutSlot.heightIndex?.eagerCompleted).toBe(true)
    } finally { dispose() }
  })
})

describe("OutputWindow growth at the followed tail", () => {
  const numberedLines = (name: string, count: number) => Array.from({ length: count }, (_, i) => `${name} ${i + 1}`).join("\n") + "\n"
  // Frames the renderer schedules itself, painted one at a time on a manual clock. A row the
  // viewport shows that unmounts and remounts keeps the renderer scheduling, so a settled
  // drain stops well before the cap.
  const FRAME_CAP = 40
  async function drain(result: Awaited<ReturnType<typeof renderScheduledWindow>>["result"], clock: ManualClock, afterFrame: () => Promise<void> | void, visible: () => boolean) {
    let frames = 0
    let blankFrames = 0
    while (result.renderer.getSchedulerState().hasScheduledRender && frames < FRAME_CAP) {
      await renderScheduledFrame(result, clock)
      await afterFrame()
      frames += 1
      if (!visible()) blankFrames += 1
    }
    return { frames, blankFrames, settled: !result.renderer.getSchedulerState().hasScheduledRender }
  }

  it("settles with the rows visible when a block above the last one grows by many rows in one publication", async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ kind: "text", id: `h${i}`, content: `history ${i}`, timestamp: 1 }) satisfies FrontendOutputBlock)
    const blocksWith = (growing: string): FrontendOutputBlock[] => [...history, { kind: "text", id: "grow", content: growing, timestamp: 1 }, { kind: "text", id: "tail", content: "tail row", timestamp: 1 }]
    const { view, set } = makeView(snapshot({ blocks: blocksWith("grow 1") }))
    const clock = new ManualClock()
    const { result, scrollbox } = await renderScheduledWindow(view, 20, 80, "chat", false, clock)
    const maxTop = () => Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
    const shows = (pattern: RegExp) => () => pattern.test(result.captureCharFrame())
    try {
      expect(scrollbox.scrollTop).toBe(maxTop())
      set(snapshot({ blocks: blocksWith(numberedLines("grow", 200)) }))
      const growth = await drain(result, clock, () => {}, shows(/grow \d+/))
      expect(growth).toEqual({ frames: expect.any(Number), blankFrames: 0, settled: true })
      expect(result.captureCharFrame()).toContain("tail row")
      expect(scrollbox.scrollTop).toBe(maxTop())
    } finally {
      result.renderer.destroy()
    }
  })

  it("grows an expanded file downward and settles when its patch bytes land after the tail release", async () => {
    const diff = buildMutationDiff([
      { path: "eta.txt", before: { kind: "absent" }, after: { kind: "text", text: numberedLines("eta", 40) } },
      { path: "theta.txt", before: { kind: "absent" }, after: { kind: "text", text: numberedLines("theta", 1500) } },
    ])
    const fixture = await mutationEvidenceFixture(diff, { windowBytes: 48000 })
    const tool: FrontendOutputBlock = {
      kind: "tool", id: "multi", name: "bash", presentation: resolveToolPresentation("bash", { command: "write eta theta" }, "/workspace"),
      action: getToolDisplay("bash").action, status: "completed", timestamp: 1, exitCode: 0, content: "done", declaresMutation: true,
      mutationEvidence: fixture.evidence,
    }
    const history = Array.from({ length: 20 }, (_, i) => ({ kind: "text", id: `h${i}`, content: `history ${i}`, timestamp: 1 }) satisfies FrontendOutputBlock)
    const blocks: FrontendOutputBlock[] = [...history, tool, { kind: "text", id: "ok", content: "ok", timestamp: 1 }]
    const clock = new ManualClock()
    const { result, scrollbox, slot } = await renderScheduledWindow({ ...transcriptOf(blocks), ...createBlockDisclosureChannel(), mutationEvidence: () => fixture.reader }, 40, 160, "chat", false, clock)
    const maxTop = () => Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
    const showsTheta = () => /theta \d+/.test(result.captureCharFrame())
    try {
      for (let i = 0; i < 4; i += 1) {
        await fixture.settle()
        await drain(result, clock, () => fixture.settle(), showsTheta)
      }
      const tail = scrollbox.scrollTop
      expect(tail).toBe(maxTop())
      const bytes = Promise.withResolvers<void>()
      fixture.holdPatches(bytes.promise)
      await result.mockMouse.click(10, result.captureCharFrame().split("\n").findIndex(line => line.includes("theta.txt")))
      // Past the toggle's two-frame tail release, before the reply.
      await drain(result, clock, () => Bun.sleep(1), showsTheta)
      bytes.resolve()
      fixture.holdPatches(undefined)
      await fixture.settle()
      const landing = await drain(result, clock, () => fixture.settle(), showsTheta)
      expect(landing).toEqual({ frames: expect.any(Number), blankFrames: 0, settled: true })
      const index = slot.heightIndex!.index
      expect(slot.scroll!.lastLeadingRows + index.totalRows()).toBe(scrollbox.scrollHeight)
      expect(scrollbox.scrollTop).toBe(tail)
    } finally {
      result.renderer.destroy()
      fixture.reader.dispose()
    }
  })
})
