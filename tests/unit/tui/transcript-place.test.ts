import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { createHeightIndex } from "../../../src/tui/hooks/create-height-index.js"
import { transcriptPlace, type TranscriptLayoutSlot, type TranscriptScrollState } from "../../../src/tui/output-window/output-window-scroll.js"
import type { TranscriptFollow } from "../../../src/tui/output-window/transcript-follow.js"
import type { TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"

/** Blocks 10..19 resident of 20, five rows each. */
function snapshot(hasAfter = false): TranscriptSnapshot {
  const blocks = Array.from({ length: 10 }, (_value, position) => ({ kind: "text" as const, id: `e${10 + position}:0`, content: "x", timestamp: 1 }))
  return {
    status: { kind: "complete" },
    source: { kind: "live" },
    generation: 4,
    totalBlocks: 20,
    window: { startBlockIndex: 10, endBlockIndex: 19, hasBefore: true, hasAfter, estimatedRows: 100, contentBytes: 0 },
    heightEstimates: [],
    blocks,
    seedEpoch: 1,
    historicalThroughIndex: -1,
  }
}

function slotAt(offset: number, lastMaxScrollTop: number): TranscriptLayoutSlot {
  const scroll: TranscriptScrollState = { offset, anchor: undefined, textDepth: 0, generation: 4, lastMaxScrollTop, lastLeadingRows: 0, lastViewportWidth: 80, lastViewportRows: 0, follow: createSignal<TranscriptFollow>({ kind: "following" }) }
  return {
    scroll,
    heightIndex: { index: createHeightIndex({ itemCount: 20, estimatedRows: 5, initialEstimates: [] }), generation: 4, toggles: "false", eagerCompleted: false, eagerStartedAt: undefined },
  }
}

describe("a transcript place", () => {
  it("is the live end for a reader following it", () => {
    expect(transcriptPlace(slotAt(90, 90), snapshot())).toEqual({ tail: true })
  })

  it("is the block at the viewport top by its absolute index, and the rows into it", () => {
    expect(transcriptPlace(slotAt(62, 90), snapshot())).toEqual({ blockIndex: 12, rowOffsetWithinBlock: 2 })
    // A window with newer history below is never the live end.
    expect(transcriptPlace(slotAt(90, 90), snapshot(true))).toEqual({ blockIndex: 18, rowOffsetWithinBlock: 0 })
  })

  it("hands on a place that was handed in and not yet shown, and is nothing without a measured position", () => {
    expect(transcriptPlace({ restoreAnchor: { blockIndex: 3, rowOffsetWithinBlock: 1 } }, snapshot())).toEqual({ blockIndex: 3, rowOffsetWithinBlock: 1 })
    expect(transcriptPlace({}, snapshot())).toBeUndefined()
    expect(transcriptPlace(slotAt(62, 90), { ...snapshot(), generation: 5 })).toBeUndefined()
  })
})
