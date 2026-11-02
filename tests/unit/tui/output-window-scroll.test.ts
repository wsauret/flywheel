import { describe, expect, it, spyOn } from "bun:test"
import type { RenderContext } from "@opentui/core"
import { createRoot, createSignal } from "solid-js"
import { createHeightIndex, type HeightIndex } from "../../../src/tui/hooks/create-height-index.js"
import type { TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { createMountedRowRegistry, createSnapshotHeightIndex, createTranscriptLayoutCache, recordZeroHeightBlocks, seedRevealedBlockEstimates, type TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import { DEFAULT_ESTIMATE } from "../../../src/tui/hooks/output-height-estimates.js"
import { asScrollBox, fakeScrollBox, mountController, snapshotFor } from "../../fixtures/output-scroll-harness.js"

function liveSnapshotFor(totalBlocks: number): TranscriptSnapshot {
  return { ...snapshotFor("live", totalBlocks), source: { kind: "live" } }
}

/** A mounted row laid out at `height` rows. The registry passes that native
 *  layout height to the row's own report. */
function fakeRow(height = 0) {
  return { getLayout: () => ({ height, width: 0, top: 0, left: 0, right: 0, bottom: 0 }), getChildren: () => [] }
}

const measuredAt = (blockIndex: number) => (index: HeightIndex, height: number) => index.reportMeasured(blockIndex, height)

describe("createTranscriptLayoutCache", () => {
  it("hands out one stable slot per session and evicts the least recently used past the cap", () => {
    const slotFor = createTranscriptLayoutCache()
    const s0 = slotFor("s0")
    const s1 = slotFor("s1")
    expect(slotFor("s0")).toBe(s0)
    for (let i = 2; i < 30; i += 1) slotFor(`s${i}`) // cache at capacity (30)
    slotFor("s0") // touch: s1 becomes the LRU entry
    slotFor("s30") // capacity breach evicts s1, not the touched s0
    expect(slotFor("s0")).toBe(s0)
    expect(slotFor("s1")).not.toBe(s1)
  })

  it("keeps a slot for every active session when there are more than the floor", () => {
    let active = 0
    const slotFor = createTranscriptLayoutCache(() => active)
    const s0 = slotFor("s0")
    for (let i = 1; i < 31; i += 1) slotFor(`s${i}`)
    expect(slotFor("s0")).not.toBe(s0) // 31 sessions, floor 30: the oldest slot left
    active = 40
    const s1 = slotFor("s1")
    for (let i = 31; i < 40; i += 1) slotFor(`s${i}`)
    expect(slotFor("s1")).toBe(s1) // 40 slots stay while 40 sessions are active
  })
})

describe("createSnapshotHeightIndex", () => {
  it("adopts the slot's measured index across remounts of the same generation", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap, setSnap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 10))
    const deps = { snapshot: snap, showThinking: () => false, slot }

    const first = createRoot((dispose) => {
      const index = createSnapshotHeightIndex(deps)().index
      index.recordMeasuredBatch([[3, 7]])
      if (!slot.heightIndex) throw new Error("height index record was not initialized")
      slot.heightIndex.eagerCompleted = true
      slot.heightIndex.eagerStartedAt = 123
      dispose()
      return index
    })

    createRoot((dispose) => {
      const index = createSnapshotHeightIndex(deps)().index
      expect(index).toBe(first) // same instance: measurements survived the remount
      expect(index.hasMeasured(3)).toBe(true)
      expect(index.blockIndexToRowOffset(4)).toBe(2 * 3 + 7)
      expect(slot.heightIndex?.eagerCompleted).toBe(true)
      expect(slot.heightIndex?.eagerStartedAt).toBe(123)
      dispose()
    })

    // A new generation re-keys from scratch.
    setSnap(snapshotFor("gen-2", 4))
    const second = createRoot((dispose) => {
      const index = createSnapshotHeightIndex(deps)().index
      expect(index).not.toBe(first)
      expect(index.hasMeasured(3)).toBe(false)
      expect(slot.heightIndex?.eagerCompleted).toBe(false)
      expect(slot.heightIndex?.eagerStartedAt).toBeUndefined()
      dispose()
      return index
    })

    // A different generation key models a repaved block space: re-keys too.
    setSnap(snapshotFor("authoritative-tip-2", 4))
    createRoot((dispose) => {
      const index = createSnapshotHeightIndex(deps)().index
      expect(index).not.toBe(second)
      dispose()
    })
  })

  it("a visibility toggle across a remount demotes measurements but keeps extents", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 10))
    createRoot((dispose) => {
      createSnapshotHeightIndex({ snapshot: snap, showThinking: () => false, slot })().index.recordMeasuredBatch([[3, 7]])
      if (!slot.heightIndex) throw new Error("height index record was not initialized")
      slot.heightIndex.eagerCompleted = true
      slot.heightIndex.eagerStartedAt = 123
      dispose()
    })
    createRoot((dispose) => {
      const record = createSnapshotHeightIndex({ snapshot: snap, showThinking: () => true, slot })()
      const index = record.index
      expect(index.hasMeasured(3)).toBe(false) // rows re-measure as they mount
      expect(index.blockIndexToRowOffset(4)).toBe(2 * 3 + 7) // extent kept: no visual jump
      expect(record.eagerCompleted).toBe(true)
      expect(record.eagerStartedAt).toBe(123)
      dispose()
    })
  })

  it("restores estimates for off-screen thinking blocks revealed in a long transcript", () => {
    const index = createHeightIndex({ itemCount: 1_000, estimatedRows: DEFAULT_ESTIMATE })
    const hidden = new Set([10, 500, 900])
    recordZeroHeightBlocks(index, [...hidden])
    index.demoteAllToEstimates()

    seedRevealedBlockEstimates(index, hidden, new Set())

    for (const blockIndex of hidden) {
      expect(index.blockIndexToRowOffset(blockIndex + 1) - index.blockIndexToRowOffset(blockIndex)).toBe(DEFAULT_ESTIMATE)
      expect(index.hasMeasured(blockIndex)).toBe(false)
    }
  })
})

describe("createOutputScrollController handed place", () => {
  it("holds the reader's newer off-tail place through same-session recovery", () => {
    const slot: TranscriptLayoutSlot = { restoreAnchor: { blockIndex: 5, rowOffsetWithinBlock: 1 } }
    const [snap, setSnap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    const box = fakeScrollBox()
    const rendererContext: RenderContext = Object.getPrototypeOf(box.ctx)
    // Count requests at the real renderer boundary without scheduling native
    // frames if the borrowed context loses its render-request isolation.
    const renderRequests = spyOn(rendererContext, "requestRender").mockImplementation(() => {})
    try {
      createRoot((dispose) => {
        try {
          const controller = mountController(slot, snap)
          controller.attach(asScrollBox(box))
          expect(renderRequests).toHaveBeenCalledTimes(0)
          box.scrollHeight = 40
          box.onUpdate?.(16)
          // Block 5 of two-row blocks starts at row 10; one row into it.
          expect(box.scrollTop).toBe(11)
          setSnap(snapshotFor("gen-2", 20))
          box.onUpdate?.(16)
          box.onUpdate?.(16)
          expect(box.scrollTop).toBe(11)
          expect(slot.restoreAnchor).toEqual({ blockIndex: 5, rowOffsetWithinBlock: 1 })

          controller.page("half-page-down")
          expect(slot.restoreAnchor).toBeUndefined()
          expect(box.scrollTop).toBe(16)
          const baseline = controller.returnToLatestBaseline()
          setSnap(snapshotFor("gen-3", 20))
          box.onUpdate?.(16)
          box.onUpdate?.(16)
          expect(box.scrollTop).toBe(16)
          expect(controller.returnToLatestBaseline()).toBe(baseline)
          controller.returnToLatest()
          box.onUpdate?.(16)
          expect(box.scrollTop).toBe(30)
        } finally {
          dispose()
        }
      })
      expect(renderRequests).toHaveBeenCalledTimes(0)
    } finally {
      renderRequests.mockRestore()
    }
  })
})

describe("createOutputScrollController remount restore", () => {
  // 20 blocks x 2 rows = 40 content rows; viewport 10 rows => maxScrollTop 30.
  const TOTAL_ROWS = 40
  const MAX_TOP = 30

  it("restores an off-tail position exactly, without tailing over half-mounted geometry", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))

    const saved = createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(MAX_TOP)
      controller.page("half-page-up") // explicit input: scroll 5 rows up
      expect(box.scrollTop).toBe(MAX_TOP - 5)
      dispose()
      return box.scrollTop
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      // First frame: nothing laid out yet. The degenerate extent must not be
      // adopted as "user is at the bottom".
      box.onUpdate?.(16)
      // Layout catches up: the restored offset is enforced, not the tail.
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(saved)
      box.onUpdate?.(16) // and stays put: no spurious tail-follow after the restore
      expect(box.scrollTop).toBe(saved)
      dispose()
    })
  })

  it("keeps an off-tail live restore when the same window reopens as indexed", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap, setSnap] = createSignal<TranscriptSnapshot | undefined>(liveSnapshotFor(20))

    const saved = createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16) // live generation tails to the bottom
      expect(box.scrollTop).toBe(MAX_TOP)
      controller.page("half-page-up")
      expect(box.scrollTop).toBe(MAX_TOP - 5)
      dispose()
      return box.scrollTop
    })

    // A continuous reseed keeps the snapshot generation (the model proved
    // block-for-block overlap); only the source kind flips to historical.
    setSnap(snapshotFor("live", 20))

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.onUpdate?.(16) // degenerate remount frame
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(saved)
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(saved)
      dispose()
    })
  })

  it("keeps an explicit off-tail restore after a transient extent collapse to the parked offset", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 55))
    const totalRows = 110
    const viewportRows = 30
    const parkedOffset = 50

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      box.viewport.height = viewportRows
      controller.attach(asScrollBox(box))
      box.scrollHeight = totalRows
      box.onUpdate?.(16) // fresh generation tails to maxScrollTop 80
      expect(box.scrollTop).toBe(80)
      controller.page("page-up") // explicit input parks at 50 with content below
      expect(box.scrollTop).toBe(parkedOffset)
      box.scrollHeight = parkedOffset + viewportRows // transient extent: maxScrollTop collapses to 50
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(parkedOffset)
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      box.viewport.height = viewportRows
      controller.attach(asScrollBox(box))
      box.onUpdate?.(16) // degenerate remount frame
      box.scrollHeight = totalRows
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(parkedOffset)
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(parkedOffset)
      dispose()
    })
  })

  it("restores an off-tail top position without treating mount geometry as bottom", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(MAX_TOP)
      controller.toTop() // explicit input parks at the transcript head
      expect(box.scrollTop).toBe(0)
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.onUpdate?.(16) // degenerate frame: maxScrollTop is 0
      expect(box.scrollTop).toBe(0)
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(0)
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(0)
      dispose()
    })
  })

  // A land on the last block also stands at the bottom, but the reader asked
  // to be at that block, so the grown tail does not pull the view along.
  it.each([
    { reader: "re-pins an at-bottom session to the grown tail", landed: false, top: MAX_TOP + 20 },
    { reader: "keeps a land at the bottom where it was, off the grown tail,", landed: true, top: MAX_TOP },
  ])("$reader on the first laid-out frame", ({ landed, top }) => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      if (landed) {
        controller.toBlock(19)
        box.onUpdate?.(16)
        box.onUpdate?.(16)
      }
      expect(box.scrollTop).toBe(MAX_TOP) // at the bottom
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      // Content grew while backgrounded; the remounted tree's extent is laid
      // out by the first frame (spacers come from the persisted height index).
      box.scrollHeight = TOTAL_ROWS + 20
      box.onUpdate?.(16)
      // The FIRST frame pins the new tail: no intermediate painted frame at
      // the stale pre-background offset (the visible tab-switch flicker).
      expect(box.scrollTop).toBe(top)
      expect(controller.returnToLatestBaseline() !== undefined).toBe(landed)
      dispose()
    })
  })

  it("an at-bottom restore converges to the tail across degenerate early frames", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(MAX_TOP)
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.onUpdate?.(16) // degenerate frame: nothing laid out yet
      box.scrollHeight = TOTAL_ROWS + 20
      box.onUpdate?.(16) // positional tail rule lands the real bottom
      expect(box.scrollTop).toBe(MAX_TOP + 20)
      dispose()
    })
  })

  it("an at-bottom restore with a prior scroll anchor still converges to the tail", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.onUpdate?.(16)
      controller.page("half-page-up") // explicit input captures an anchor
      controller.toBottom() // back at the tail, anchor stays captured
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(MAX_TOP)
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.onUpdate?.(16) // degenerate frame: the tail pin clamps to 0
      box.scrollHeight = TOTAL_ROWS + 20
      // The degenerate pin must have adopted 0 as the new bottom (not kept the
      // persisted pre-remount bottom): otherwise this frame reads offset 0 as
      // off-tail and the follow is permanently lost.
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(MAX_TOP + 20)
      dispose()
    })
  })

  it("reasserts the native extent and offset after bar recalculation reclamps them", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = TOTAL_ROWS
      box.contentHeight = TOTAL_ROWS
      box.onUpdate?.(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(MAX_TOP)
      // Later native layout rounds can recalculate the bars after onFrame.
      // The native extent remains authoritative over the bar's cached pair.
      box.scrollHeight = 0
      box.scrollTop = 0
      box.recalculateBarProps?.()
      expect(box.scrollHeight).toBe(TOTAL_ROWS)
      expect(box.scrollTop).toBe(MAX_TOP)
      dispose()
    })
  })
})

describe("createMountedRowRegistry", () => {
  it("reports each mounted row's height from its current layout", () => {
    const registry = createMountedRowRegistry()
    const index = createHeightIndex({ itemCount: 4, estimatedRows: 2 })
    registry.register(fakeRow(5), () => 0, measuredAt(0))
    registry.register(fakeRow(6), () => 1, (heights, height) => heights.reportEstimated(1, height)) // the row holds its height
    index.recordMeasuredBatch([[2, 9]])
    registry.register(fakeRow(4), () => 2, measuredAt(2)) // measured but laid out anew: re-reported
    registry.register(fakeRow(), () => 3) // a row without a report records no height
    registry.reportHeights(index)
    index.flushMeasurements()
    expect(index.hasMeasured(0)).toBe(true)
    expect(index.blockIndexToRowOffset(1)).toBe(5)
    expect(index.hasMeasured(1)).toBe(false)
    expect(index.blockIndexToRowOffset(2)).toBe(5 + 6)
    expect(index.blockIndexToRowOffset(3)).toBe(5 + 6 + 4)
    expect(index.hasMeasured(3)).toBe(false)
  })

  it("stops reporting an unregistered row", () => {
    const registry = createMountedRowRegistry()
    const index = createHeightIndex({ itemCount: 1, estimatedRows: 2 })
    const unregister = registry.register(fakeRow(7), () => 0, measuredAt(0))
    unregister()
    registry.reportHeights(index)
    index.flushMeasurements()
    expect(index.hasMeasured(0)).toBe(false)
  })
})

describe("createOutputScrollController same-frame measurement", () => {
  it.each([false, true])("compensates growth above the anchor before wheel glide (%s)", (wheel) => {
    // 20 blocks x 2 estimated rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    const registry = createMountedRowRegistry()
    createRoot((dispose) => {
      const controller = mountController(slot, snap, {
        mountedRows: {
          ...registry,
          // Each fake text row is one source line, placed at its block's extent.
          layoutRows: (blockIndex) => {
            const top = slot.heightIndex!.index.blockIndexToRowOffset(blockIndex)
            return { top, height: slot.heightIndex!.index.blockIndexToRowOffset(blockIndex + 1) - top }
          },
          captureText: (blockIndex, row) => ({ path: [], sourceLine: row - slot.heightIndex!.index.blockIndexToRowOffset(blockIndex), displayColumn: 0 }),
          resolveText: (blockIndex, position) => slot.heightIndex!.index.blockIndexToRowOffset(blockIndex) + position.sourceLine,
        },
        wheel: { baseRows: 3, frameShare: 0.5 },
      })
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16) // fresh generation tails to the bottom (30)
      controller.page("half-page-up") // offset 25: anchor over block 12
      expect(box.scrollTop).toBe(25)
      // Block 0 lays out at 5 rows (estimate was 2). Its size callback runs
      // before the frame hook, so the +3 upstream correction and the offset
      // compensation land in ONE frame -- no intermediate frame at the stale
      // offset (the paging-boundary flutter).
      slot.heightIndex!.index.reportMeasured(0, 5)
      box.scrollHeight = 43
      if (wheel) box.onMouseEvent?.({ type: "scroll", scroll: { direction: "up", delta: 1 } })
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(wheel ? 26 : 28)
      if (wheel) {
        slot.heightIndex!.index.reportMeasured(1, 4)
        box.scrollHeight = 45
        box.onUpdate?.(16)
        expect(box.scrollTop).toBe(27)
        box.onUpdate?.(16)
        expect(box.scrollTop).toBe(27)
      }
      dispose()
    })
  })

})

describe("createOutputScrollController same-frame tail growth", () => {
  it("pins the tail in the frame live growth lays out (no push-down/pop-back flicker)", () => {
    // 20 blocks x 2 rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.contentHeight = 40 // yoga's fresh extent; the element lags a frame behind
      box.onUpdate?.(16) // sync adopts it, fresh generation tails to the bottom
      expect(box.scrollTop).toBe(30)
      // A subagent preview grows one row: yoga lays out 41 rows THIS frame;
      // the element's own extent would only catch up next frame. The pin must
      // land in the same onUpdate, pushing the transcript up with the tail
      // pinned instead of painting pushed down and popping back.
      box.contentHeight = 41
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(31)
      dispose()
    })
  })

  it("keeps the tail pinned across a transient extent shrink", () => {
    // 20 blocks x 2 rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16) // fresh generation tails to the bottom
      controller.page("half-page-up") // explicit input captures an anchor
      controller.toBottom() // back at the tail, anchor stays captured
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(30)
      // A block above re-measures smaller: the extent shrinks for a frame.
      // The tail pin follows down and must adopt the shrunken extent as the
      // new bottom -- preserving the stale bottom would classify the next
      // frame as off-tail and drop the follow for good.
      box.scrollHeight = 34
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(24)
      box.scrollHeight = 44 // appended output must tail as before
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(34)
      dispose()
    })
  })

  it("follows again when a taller viewport brings the bottom into view", () => {
    // 20 blocks x 2 rows = 40 content rows. A docked question leaves a
    // 7-row viewport (maxScrollTop 33); closing it gives back 3 rows.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      box.viewport.height = 7
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16) // fresh generation tails to the bottom
      controller.page("half-page-up") // the reader leaves the tail by 3 rows
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(30)
      expect(controller.returnToLatestBaseline()).toBeDefined()
      box.viewport.height = 10 // the dock closes: maxScrollTop drops to 30
      box.onUpdate?.(16)
      expect(controller.returnToLatestBaseline()).toBeUndefined()
      box.scrollHeight = 44 // appended output must tail
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(34)
      dispose()
    })
  })
})

describe("createOutputScrollController preserveScroll with fresh extents", () => {
  it("releases the bottom anchor across an expansion that lays out the same frame", () => {
    // 20 blocks x 2 rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.contentHeight = 40
      box.onUpdate?.(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(30)
      controller.preserveScroll(() => {}) // expand a box at the pinned tail
      box.contentHeight = 50 // with the extent sync the expansion lays out frame N
      box.onUpdate?.(16) // frame N: release window holds the offset
      expect(box.scrollTop).toBe(30)
      box.onUpdate?.(16) // frame N+1: still suppressed
      expect(box.scrollTop).toBe(30)
      box.onUpdate?.(16) // frame N+2: release is positional now (offset < new max)
      expect(box.scrollTop).toBe(30)
      controller.toBottom() // and End still reaches the true tail
      expect(box.scrollTop).toBe(40)
      dispose()
    })
  })
})

describe("createOutputScrollController preserveScroll at the tail", () => {
  // 20 blocks x 2 rows = 40 content rows; viewport 10 => maxScrollTop 30.
  it("releases the bottom anchor across an expansion instead of re-pinning the tail", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(30)
      controller.preserveScroll(() => {}) // expand a box at the pinned tail
      box.onUpdate?.(16) // frame N: element extent still stale, offset enforced
      expect(box.scrollTop).toBe(30)
      box.scrollHeight = 50 // the expansion lands in layout one frame later
      box.onUpdate?.(16) // frame N+1: without the release this frame re-pins to 40
      expect(box.scrollTop).toBe(30)
      box.onUpdate?.(16) // frame N+2: release is positional now (offset < new max)
      expect(box.scrollTop).toBe(30)
      dispose()
    })
  })

  it("explicit input during the release window re-engages the tail immediately", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(30)
      controller.preserveScroll(() => {}) // expand at the tail: release window opens
      box.scrollHeight = 50
      controller.toBottom() // End: explicit input cancels the release
      expect(box.scrollTop).toBe(40)
      box.scrollHeight = 60 // appended output tails again
      box.onUpdate?.(16)
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(50)
      dispose()
    })
  })

  it("re-engages the tail after a collapse at the bottom", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(30)
      controller.preserveScroll(() => {}) // collapse a box at the pinned tail
      box.onUpdate?.(16) // frame N: extent stale
      box.scrollHeight = 34 // collapsed content shrinks the extent
      box.onUpdate?.(16) // frame N+1: enforce clamps to the shrunk max
      expect(box.scrollTop).toBe(24)
      box.onUpdate?.(16) // frame N+2: still at the (new) bottom -> tail again
      box.scrollHeight = 44 // appended output must tail as before
      box.onUpdate?.(16)
      expect(box.scrollTop).toBe(34)
      dispose()
    })
  })
})