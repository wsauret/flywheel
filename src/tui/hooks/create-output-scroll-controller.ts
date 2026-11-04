import type { BaseRenderable, MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, batch, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { HeightIndex } from "./create-height-index.js"
import type { TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { createOutputWindowScrollTelemetry } from "../output-window/output-window-scroll-diagnostics.js"
import { createScrollFightMonitor } from "../output-window/output-window-scroll-anomalies.js"
import type { TranscriptWindowProjection } from "../output-window/output-window-projection.js"
import {
  anchorAtOffset,
  createSnapshotHeightIndex,
  type EdgeDirection,
  frameEdgeSignals,
  maxScrollTop,
  patchScrollBoxHooks,
  recordKnownBlockHeights,
  recordZeroHeightBlocks,
  seedRevealedBlockEstimates,
  type MountedRowRegistry,
  type TranscriptLayoutSlot,
  type TranscriptScrollState,
  upstreamCorrectionRows,
  RESIDENT_BLOCK_BUDGET,
  windowGeometry,
} from "../output-window/output-window-scroll.js"
import { createWheelRows, frameWheelRows, type WheelProfile, wheelProfileFor } from "../output-window/output-window-wheel.js"

// The controller solely owns the scroll offset and virtualization height index.
// Its `offset` is authoritative and the scrollbox is write-only: observed
// scrollTop is never interpreted as intent. Explicit input paths update intent;
// each frame either pins the tail, compensates the anchor for upstream extent
// changes, or reasserts the authoritative offset over layout nudges.

/** Upward viewport margin retained so paging does not expose an eviction gap. */
const EVICT_PROTECTED_BLOCKS = 600
/** Minimum eviction batch; prevents per-frame churn near the residency cap. */
const EVICT_MIN_BLOCKS = 200

/** The offset that puts the middle of a block of `height` rows at `top` in the
 *  middle of the viewport. A block taller than the viewport shows from its top. */
function centredTop(top: number, height: number, viewportRows: number): number {
  return height >= viewportRows ? top : top - Math.floor((viewportRows - height) / 2)
}

export interface OutputScrollControllerDeps {
  readonly snapshot: Accessor<TranscriptSnapshot | undefined>
  readonly projection: Accessor<TranscriptWindowProjection>
  readonly showThinking: Accessor<boolean>
  readonly onNearEdge?: (direction: EdgeDirection) => void
  readonly hydrateAnchor: () => Promise<void>
  readonly updateSelection: (current: ScrollBoxRenderable, x: number, y: number) => void
  /** Drain per-block row-estimate point updates from the incremental delta
   *  path; seeded into the height index instead of re-reading a whole-window
   *  estimate array per flush. */
  readonly takeEstimateUpdates?: () => readonly (readonly [number, number])[]
  /** Drop resident blocks before the given absolute index (far-page eviction);
   *  invoked only when the viewport-protected range clears them. */
  readonly evictBefore?: (blockIndex: number) => void
  /** Rows of scrollbox content rendered ABOVE the transcript rows (the session
   *  intro when the window reaches the head). Scroll offsets are leading + index
   *  rows; anchor math subtracts it and re-pins add it back. */
  readonly leadingRows?: Accessor<number>
  /** Every scroll-content row outside the height index: the leading rows and
   *  the pending spacer below the transcript rows. Read for diagnostics only. */
  readonly unindexedRows?: Accessor<number>
  /** The mounted transcript rows: the source positions that hold the
   *  reading anchor across reflow. Their heights reach the index through
   *  each row's size callback. onRowsMeasured drains the reports of the
   *  frame's first row layout; the next frame decision drains the reports
   *  that later layout rounds queue. */
  readonly mountedRows?: MountedRowRegistry
  /** The session's cross-remount layout memory (height index + scroll state).
   *  Owned by the shell's layout cache; the controller adopts and mutates it. */
  readonly slot: TranscriptLayoutSlot
  readonly visibleMessageCount: Accessor<number>
  readonly jumpToLatest: () => Promise<void>
  /** How the terminal reports the wheel; the host terminal's when absent. */
  readonly wheel?: WheelProfile
  /** The clock that times wheel reports; `performance.now` when absent. */
  readonly now?: () => number
}

export interface TranscriptSelectionAutoScroll {
  readonly contains: (target: BaseRenderable | null) => boolean
  readonly update: (x: number, y: number) => void
  readonly stop: () => void
}

export interface OutputScrollController {
  readonly heightIndex: Accessor<HeightIndex>
  readonly heightIndexRecord: Accessor<import("../output-window/output-window-scroll.js").TranscriptHeightIndexRecord>
  readonly viewport: Accessor<{ readonly scrollTop: number; readonly viewportRows: number }>
  readonly attach: (el: ScrollBoxRenderable) => void
  readonly page: (action: "page-up" | "page-down" | "half-page-up" | "half-page-down") => void
  readonly toTop: () => void
  readonly toBottom: () => void
  readonly toBlock: (blockIndex: number) => void
  readonly wheel: (event: MouseEvent) => void
  readonly preserveScroll: (mutate: () => void) => void
  readonly selectionAutoScroll: TranscriptSelectionAutoScroll
  readonly returnToLatestBaseline: Accessor<number | undefined>
  readonly returnToLatest: () => void
}

export function createOutputScrollController(deps: OutputScrollControllerDeps): OutputScrollController {
  const { snapshot, projection } = deps
  const wheelProfile = deps.wheel ?? wheelProfileFor(process.platform, process.env)
  const wheelRows = createWheelRows(wheelProfile)
  const now = deps.now ?? (() => performance.now())

  // Only a NEW generation re-keys the height index; growth resizes in place and
  // a visibility toggle demotes measurements to estimates (they re-measure).
  const heightIndexRecord = createSnapshotHeightIndex({
    snapshot,
    showThinking: deps.showThinking,
    slot: deps.slot,
    onDemote: (index) => {
      // Unchanged mounted rows receive no size callback. Restore their
      // measurements before a fresh snapshot can reseed them with estimates.
      deps.mountedRows?.reportHeights(index)
      index.flushMeasurements()
    },
  })
  const heightIndex = () => heightIndexRecord().index

  let el: ScrollBoxRenderable | undefined
  let selectionPointer: { readonly x: number; readonly y: number } | undefined
  let tailingNow = false
  // The signed rows of wheel reports that no frame has applied yet. Each
  // frame applies the profile's share of them (see onFrame); every row of
  // every report lands, and only explicit navigation discards them.
  let pendingWheelRows = 0
  // The place the next frame takes: a handed-on place in a block, or a
  // landing that centres a block.
  let pendingBlockTarget:
    | { readonly kind: "restore"; readonly blockIndex: number; readonly rowOffsetWithinBlock: number }
    | { readonly kind: "land"; readonly blockIndex: number }
    | undefined
  // The block a taken landing centres. It stays set until the block's
  // laid-out row places the offset, before the frame that mounts it paints.
  let landing: number | undefined
  // The extent the frame decision stood on. Reactive spacers can trigger
  // another native layout round after onFrame; its size callbacks then
  // reconcile the offset against that round's extent and reading anchor.
  let frameExtent = Number.NaN
  // A frame's size callbacks run after its decision. Only callbacks of the
  // frame that this decision belongs to may reconcile it.
  let decidedFrameId = -1
  // Whether this frame's decision placed the reading position on mounted
  // text, which already stands on this frame's native row heights.
  let readingOnLayout = false
  let compensatedMaxScrollTop = 0
  let preserveOffTailBottom = false
  // preserveScroll release window: a collapse/expand toggle must not move the
  // transcript, even at the pinned tail - the bottom anchor lets go and the
  // box grows downward, exactly like a mid-transcript toggle. The positional
  // at-bottom rule would re-pin on the frame the toggle's new extent lays out
  // (and on a stale-extent frame the sync skips), so a toggle suppresses tail
  // derivation for those frames; afterwards lastMaxScrollTop reflects the
  // post-toggle extent and the release is purely positional again (an
  // expansion leaves the offset below the new bottom, a collapse re-engages
  // the tail).
  let suppressTailFrames = 0
  // Probe-gated stall telemetry: how long queued wheel input waited for a
  // painted frame. Input-to-frame latency, not frame-to-frame gap: a frame gap
  // also spans demand-driven idle, so it cannot by itself distinguish a stall
  // from an idle renderer. frameGapMs rides along as context.
  let lastFrameAt = 0
  let wheelQueuedAt = 0
  const [returnToLatestBaseline, setReturnToLatestBaseline] = createSignal<number | undefined>(deps.slot.returnToLatestBaseline)

  function setBaseline(value: number | undefined): void {
    if (value === undefined) Reflect.deleteProperty(deps.slot, "returnToLatestBaseline")
    else deps.slot.returnToLatestBaseline = value
    setReturnToLatestBaseline(value)
  }

  function reconcileFollowing(atBottom: boolean, hasAfter: boolean): void {
    if (atBottom && !hasAfter) {
      setBaseline(undefined)
      return
    }
    if (returnToLatestBaseline() === undefined) setBaseline(deps.visibleMessageCount())
  }

  // The session layout slot owns the authoritative position in place, so a keyed
  // remount adopts it without a save/restore step.
  const restored = deps.slot.scroll
  const state: TranscriptScrollState = restored ?? {
    offset: 0,
    anchor: undefined,
    textDepth: 0,
    generation: undefined,
    lastMaxScrollTop: 0,
    // End pressed while newer history was unhydrated: pin the real tail once
    // hasAfter flips false. Any explicit input cancels (captureUserOffset).
    pendingTailIntent: false,
    lastLeadingRows: 0,
    lastViewportWidth: 0,
    lastViewportRows: 0,
    landed: false,
  }
  deps.slot.scroll = state
  // Remount restore latch: until the rebuilt tree's extent reaches the restored
  // offset, geometry is transient - deriving tail-follow from it (or adopting
  // lastMaxScrollTop) would read the half-mounted extent as "at the bottom" and
  // spuriously jump to the tail. A restore parked at absolute top needs the same
  // protection until the current extent proves there are still rows below it;
  // otherwise 0/0 mount geometry erases the saved off-tail bottom. The latch only
  // guards OFF-tail restores: a restore that WAS at the bottom is positionally a
  // fresh generation, so it skips the latch and pendingTailIntent pins the tail
  // on the first laid-out frame - enforcing the stale pre-background offset for
  // even one frame paints the transcript at the old position (the visible
  // tab-switch flicker). A true generation change or any explicit input also
  // ends the restore.
  const restoredOffTail = restored !== undefined && state.offset < state.lastMaxScrollTop
  let restoring = restoredOffTail
  // A land that reached the bottom is where the reader asked to be, not the
  // live end it would follow.
  if (restored !== undefined && !restoredOffTail && !state.landed) state.pendingTailIntent = true

  // scrollTop seeded at the restored offset so the virtualized window mounts the
  // right neighborhood on the first render pass, before the first frame syncs.
  const [viewport, setViewport] = createSignal({ scrollTop: state.offset, viewportRows: 0 })
  const telemetry = createOutputWindowScrollTelemetry({
    snapshot: () => untrack(snapshot),
    anchor: () => state.anchor,
    bottomFollowActive: () => tailingNow,
  })
  // What the default-on fight monitor compares between frame decisions: the
  // person's input since the last decision, whether the controller placed the
  // position itself since then, and the last write that moved scrollTop.
  let inputDirection: -1 | 0 | 1 = 0
  let repositioned = false
  let lastWriteSource = ""
  const fights = createScrollFightMonitor(deps.slot.sessionId, {
    state,
    heightIndexRecord: () => untrack(heightIndexRecord),
    leadingRows: () => leadingRows(),
    unindexedRows: () => deps.unindexedRows?.() ?? 0,
    mountedRows: deps.mountedRows,
    textResolved: () => readingOnLayout,
    writeSource: () => lastWriteSource,
  })
  onCleanup(() => fights.close())

  const syncViewport = (e: ScrollBoxRenderable) => setViewport((v) => (
    v.scrollTop === e.scrollTop && v.viewportRows === e.viewport.height
      ? v
      : { scrollTop: e.scrollTop, viewportRows: e.viewport.height }
  ))
  const leadingRows = () => deps.leadingRows?.() ?? 0

  /** The only scrollTo call site: render `target` clamped to the currently
   *  laid-out extent. The authoritative `offset` (the INTENT) is managed by the
   *  callers - a mid-layout clamp must never destroy it, so an intent past the
   *  still-mounting extent simply re-applies each frame until layout catches up
   *  (the controller keeps offset and maxScrollExtent separate the
   *  same way). */
  function writeScroll(e: ScrollBoxRenderable, target: number, source: string): void {
    const beforeTop = e.scrollTop
    const applied = Math.max(0, Math.min(target, maxScrollTop(e)))
    // The controller owns the offset and writes it again each frame, so the
    // write must not reapply after the next layout as scrollTo does.
    if (applied !== e.scrollTop) e.scrollTop = applied
    if (beforeTop === e.scrollTop) return
    lastWriteSource = source
    telemetry.changed(source, e, beforeTop)
  }

  /** Explicit navigation (page, top, bottom, scrollbar, selection): it
   *  replaces the wheel rows that still wait, then moves like any input. */
  function captureUserOffset(e: ScrollBoxRenderable, target: number, source: string): void {
    pendingWheelRows = 0
    adoptUserOffset(e, target, source)
  }

  /** Every user move funnels here: adopt the new offset (clamped at input
   *  time - a user cannot scroll past the current content), re-capture the
   *  anchor at it, and cancel deferred tail intent. Tailing needs no
   *  bookkeeping - the next frame re-derives it from the position this leaves
   *  behind. */
  function adoptUserOffset(e: ScrollBoxRenderable, target: number, source: string): void {
    Reflect.deleteProperty(deps.slot, "restoreAnchor")
    restoring = false
    landing = undefined
    state.landed = false
    const direction = Math.sign(target - state.offset)
    if (direction === -1 || direction === 1) inputDirection = direction
    state.offset = Math.max(0, Math.min(target, maxScrollTop(e)))
    writeScroll(e, state.offset, source)
    syncViewport(e)
    const snap = untrack(snapshot)
    captureAnchor(snap)
    state.pendingTailIntent = false
    suppressTailFrames = 0
    state.lastMaxScrollTop = maxScrollTop(e)
    reconcileFollowing(state.offset >= state.lastMaxScrollTop, snap?.window.hasAfter === true)
  }

  function captureAnchor(snap: TranscriptSnapshot | undefined): void {
    state.anchor = anchorAtOffset(state.offset, untrack(heightIndex), snap ? windowGeometry(snap) : undefined, leadingRows())
    state.anchorIdentity = identityAt(snap, state.anchor.blockIndex)
    if (state.anchor.kind === "block") captureReadingText(state.anchor.blockIndex, state.offset)
    else {
      state.textPosition = undefined
      state.textDepth = 0
    }
  }

  /** Holds the reading position on the block's first laid-out text row at or
   *  below `fromRow`. A card can open with a margin row that holds no text,
   *  and the leading rows the index places the block by can lag native layout
   *  by a frame; without text the next frame could only compensate through
   *  those rows. */
  function captureReadingText(blockIndex: number, fromRow: number): void {
    state.textPosition = undefined
    state.textDepth = 0
    const rows = deps.mountedRows?.layoutRows(blockIndex)
    if (!rows) return
    for (let row = Math.max(fromRow, rows.top); row < rows.top + rows.height; row++) {
      const text = deps.mountedRows?.captureText(blockIndex, row)
      if (!text) continue
      state.textPosition = text
      state.textDepth = row - state.offset
      return
    }
  }

  function identityAt(snap: TranscriptSnapshot | undefined, blockIndex: number): string | undefined {
    const block = snap?.blocks[blockIndex - (snap.window.startBlockIndex ?? 0)]
    return block === undefined ? undefined : blockIdentity(block)
  }

  function adoptCoordinateRevision(snap: TranscriptSnapshot, index: HeightIndex): boolean {
    if (snap.generation === state.generation) return false
    const initial = state.generation === undefined
    state.generation = snap.generation
    let placed = false
    if (!initial && state.anchor && returnToLatestBaseline() !== undefined && !state.pendingTailIntent) {
      const local = state.anchorIdentity === undefined ? -1 : snap.blocks.findIndex((block) => blockIdentity(block) === state.anchorIdentity)
      const blockIndex = local >= 0
        ? (snap.window.startBlockIndex ?? 0) + local
        : state.anchorIdentity === undefined ? state.anchor.blockIndex : snap.window.startBlockIndex
      if (blockIndex !== null) {
        if (local < 0 && state.anchorIdentity !== undefined) {
          state.textPosition = undefined
          const replacement = snap.blocks[0]
          state.anchorIdentity = replacement ? blockIdentity(replacement) : undefined
          state.anchor = { kind: "block", blockIndex, rowOffsetWithinBlock: 0 }
        }
        state.anchor = { ...state.anchor, blockIndex }
        const within = state.anchor.kind === "block" ? state.anchor.rowOffsetWithinBlock
          : state.anchor.kind === "before-window" ? -state.anchor.distanceRows : state.anchor.distanceRows
        state.offset = Math.max(0, leadingRows() + index.blockIndexToRowOffset(blockIndex) + within)
        placed = true
        repositioned = true
        suppressTailFrames = 1
      }
    } else if (initial && snap.window.hasAfter && snap.window.startBlockIndex !== null) {
      setBaseline(deps.visibleMessageCount())
      state.anchor = { kind: "block", blockIndex: snap.window.startBlockIndex, rowOffsetWithinBlock: 0 }
      state.offset = Math.max(0, leadingRows() + index.blockIndexToRowOffset(snap.window.startBlockIndex))
    }
    const handed = deps.slot.restoreAnchor
    if (handed && handed.blockIndex < snap.totalBlocks) pendingBlockTarget = { kind: "restore", ...handed }
    return placed
  }

  function resolveMountedReadingAnchor(): boolean {
    if (!state.anchor || !state.textPosition || returnToLatestBaseline() === undefined || state.pendingTailIntent) return false
    const row = deps.mountedRows?.resolveText(state.anchor.blockIndex, state.textPosition)
    if (row === undefined) return false
    state.offset = Math.max(0, row - state.textDepth)
    return true
  }

  // Seed effect: full local estimates once per estimate-array identity (seed
  // paths replace the array; the 16ms delta path never touches it), point
  // updates from the incremental delta path per flush, zero-height blocks from
  // the projection. Reads snapshot/index but NOT extentVersion, so it never
  // self-triggers off its own index writes; measured-wins keeps a re-seed of a
  // measured block a no-op.
  let lastSeededEstimates: TranscriptSnapshot["heightEstimates"] | undefined
  let priorZeroHeightBlocks = new Set<number>()
  let lastZeroHeightBlockIndices: readonly number[] | undefined
  createEffect(() => {
    const snap = snapshot()
    const index = heightIndex()
    const zeroHeightBlockIndices = projection().zeroHeightBlockIndices
    if (!snap) return
    const estimates = snap.heightEstimates
    // Tracked on purpose: the incremental delta path moves estimatedRows in
    // place per flush, making this effect the drain point for point updates.
    void snap.window.estimatedRows
    untrack(() => {
      // The projector keeps the indices array's identity while its items are
      // unchanged, so a streaming flush that moved only estimates skips the
      // set rebuild and the reveal diff.
      if (zeroHeightBlockIndices !== lastZeroHeightBlockIndices) {
        lastZeroHeightBlockIndices = zeroHeightBlockIndices
        const currentZeroHeightBlocks = new Set(zeroHeightBlockIndices)
        seedRevealedBlockEstimates(index, priorZeroHeightBlocks, currentZeroHeightBlocks)
        priorZeroHeightBlocks = currentZeroHeightBlocks
      }
      if (estimates !== lastSeededEstimates) {
        lastSeededEstimates = estimates
        recordKnownBlockHeights(index, snap, zeroHeightBlockIndices)
        return
      }
      const updates = deps.takeEstimateUpdates?.() ?? []
      if (updates.length > 0) index.seedEstimatedBatch(updates)
      recordZeroHeightBlocks(index, zeroHeightBlockIndices)
    })
  })

  // The painted thumb is always the true ratio. Correction hops (estimates
  // above the viewport becoming measurements) legitimately move it mid-scroll;
  // painting them immediately is honest and small now that estimates track
  // rendered heights closely. Any display smoothing that defers those hops
  // banks a display/truth gap during a flick and must pay it back as a
  // visible catch-up glide once motion rests - the "zoom".

  /** The one scroll decision per frame, before the rows lay out: drain
   *  corrections, pin the tail or compensate the anchored position, apply
   *  input, enforce the authoritative offset over OpenTUI layout nudges, and
   *  publish the viewport, so rows it mounts join this frame's layout.
   *  onRowsMeasured applies this frame's row measurements before paint. */
  function onFrame(): void {
    const e = el
    if (!e) return
    const snap = untrack(snapshot)
    const index = untrack(heightIndex)
    if (!snap) { syncViewport(e); return }
    const frameNow = now()
    const frameGap = lastFrameAt === 0 ? 0 : frameNow - lastFrameAt
    lastFrameAt = frameNow
    if (pendingWheelRows !== 0 && wheelQueuedAt !== 0 && frameNow - wheelQueuedAt > 200) {
      telemetry.event("frame stall while scrolling", e, {
        inputWaitMs: Math.round(frameNow - wheelQueuedAt),
        frameGapMs: Math.round(frameGap),
        pendingWheelRows,
      })
    }

    // OpenTUI applies selection auto-scroll in its base update immediately before
    // this controller runs. Adopt that explicit input before frame enforcement.
    if (selectionPointer && e.scrollTop !== state.offset) {
      captureUserOffset(e, e.scrollTop, "user.selection")
      updateSelectionFocus(e)
    }

    // The native extent is this frame's layout: the tail pin and every clamp
    // below see the true bottom in the same frame live growth paints, so a
    // block growing at the pinned tail pushes the transcript UP instead of
    // painting pushed down and popping back next frame. Size callbacks
    // reconcile this extent with any later layout round and resolve the
    // matching reading offset before either can paint.
    frameExtent = e.scrollHeight

    const viewportGrowth = adoptViewportSize(e, index)

    // Apply the reports that the previous frame's later layout rounds queued.
    // This frame's rows report after the decision, for onRowsMeasured.
    index.flushMeasurements()
    const corrections = index.takeCorrections()
    // Render-probe-gated telemetry: how often estimates are wrong enough to
    // correct mid-scroll, and whether the hop lands upstream of the anchor
    // (= moves the thumb). Steady-state scrolling over a measured transcript
    // should drain zero corrections.
    if (corrections.length > 0) {
      telemetry.event("corrections drained", e, {
        count: corrections.length,
        totalRows: corrections.reduce((sum, c) => sum + c.deltaRows, 0),
        upstreamRows: state.anchor ? upstreamCorrectionRows(corrections, state.anchor.blockIndex) : 0,
        firstBlock: corrections[0]?.blockIndex,
        lastBlock: corrections.at(-1)?.blockIndex,
      })
    }

    let placed = adoptCoordinateRevision(snap, index)
    // A landing whose block did not lay out before its frame painted keeps
    // its estimated place, clamped to the content like a laid-out one.
    if (landing !== undefined) {
      landing = undefined
      state.offset = Math.min(state.offset, maxScrollTop(e))
    }

    const count = deps.visibleMessageCount()
    const baseline = returnToLatestBaseline()
    if (baseline !== undefined && count < baseline) setBaseline(count)
    if (snap.window.hasAfter) reconcileFollowing(false, true)

    // A target placed this frame already stands on this frame's extents and
    // leading rows, so the compensation below must not move it again.
    const target = pendingBlockTarget
    if (target !== undefined) {
      pendingBlockTarget = undefined
      const top = index.blockIndexToRowOffset(target.blockIndex)
      // A landing's estimate decides which rows this frame mounts and stands
      // until landOnLayout places the block on their layout, before paint.
      state.offset = Math.max(0, leadingRows() + (target.kind === "restore"
        ? top + target.rowOffsetWithinBlock
        : centredTop(top, index.blockIndexToRowOffset(target.blockIndex + 1) - top, e.viewport.height)))
      placed = true
      repositioned = true
      state.pendingTailIntent = false
      reconcileFollowing(false, snap.window.hasAfter)
      suppressTailFrames = 1
      pendingWheelRows = 0
      restoring = false
      landing = target.kind === "land" ? target.blockIndex : undefined
      state.landed = target.kind === "land"
      captureAnchor(snap)
      landOnLayout(e)
    }

    // Native layout already holds this frame's row heights; the index learns
    // them only after the decision. A position resolved on mounted text has
    // absorbed them, so the post-measurement compensation must not repeat it.
    readingOnLayout = resolveMountedReadingAnchor()
    placed = readingOnLayout || placed

    const leading = leadingRows()
    const leadingDelta = leading - state.lastLeadingRows
    state.lastLeadingRows = leading

    // Wheel input captures a new anchor against the current layout. Move the
    // old reading position onto that layout first, including during glide.
    let compensatedRows = placed ? 0 : leadingDelta
    if (!placed && state.anchor && corrections.length > 0) compensatedRows += upstreamCorrectionRows(corrections, state.anchor.blockIndex)
    if (compensatedRows !== 0) state.offset = Math.max(0, state.offset + compensatedRows)
    applyWheelRows(e, frameNow)

    const tailReleased = suppressTailFrames > 0
    if (tailReleased) suppressTailFrames -= 1
    // Geometry can move the resolved off-tail offset past the prior bottom.
    // Following comes from the slot's intent, not that new physical position.
    tailingNow = !snap.window.hasAfter
      && !restoring
      && !tailReleased
      && (returnToLatestBaseline() === undefined || state.pendingTailIntent)
    if (tailingNow) {
      compensatedRows = 0
      state.pendingTailIntent = false
      state.offset = maxScrollTop(e)
      writeScroll(e, state.offset, "frame.follow")
    } else {
      // Enforce the authoritative intent over any layout nudge; an intent past
      // the still-mounting extent re-applies each frame until layout catches up.
      writeScroll(e, state.offset, compensatedRows !== 0 ? "frame.compensate" : "frame.enforce")
    }
    decidedFrameId = e.ctx.frameId
    syncViewport(e)
    fights.frame(e, snap, { input: inputDirection, repositioned, tailing: tailingNow, extent: frameExtent })
    inputDirection = 0
    repositioned = false

    if (restoring) {
      // Half-mounted geometry: keep the persisted lastMaxScrollTop and make no
      // paging/eviction decisions until the extent reaches the restored offset
      // and proves that an off-tail restore is still off-tail. The second clause
      // is what preserves a viewport parked at absolute top: max=0 must not
      // collapse the saved 0<oldBottom state into "at bottom".
      const currentMax = maxScrollTop(e)
      if (currentMax < state.offset || currentMax <= state.offset + 1) return
      restoring = false
    }
    // The extent was pre-synced from the frame's fresh layout above, so
    // maxScrollTop(e) is normally current. The compensation floor remains for
    // the frames the sync skips (NaN between layouts): there the element
    // extent lags, and adopting the stale max would make the positional tail
    // rule read a compensated offset as "at the bottom" next frame and re-pin
    // (the wheel-vs-prepend race). A transient shrink to an explicit off-tail
    // offset is also stale for bottom classification: keep the last known
    // bottom until a real tail-follow or explicit input replaces it. A frame
    // that DID tail-follow is that replacement: its pin already adopted the
    // (possibly shrunken or degenerate-remount) extent as the new bottom, so
    // preserving the stale larger bottom here would classify the very next
    // frame as off-tail and permanently drop the follow.
    const currentMaxScrollTop = maxScrollTop(e)
    // A viewport that changed height moved the bottom for real (a question dock
    // closing gives its rows back), so the last known bottom moves with it.
    compensatedMaxScrollTop = state.lastMaxScrollTop + compensatedRows - viewportGrowth
    preserveOffTailBottom = !tailingNow && state.anchor !== undefined && state.offset < compensatedMaxScrollTop - 1 && currentMaxScrollTop <= state.offset + 1
    state.lastMaxScrollTop = preserveOffTailBottom
      ? compensatedMaxScrollTop
      : compensatedRows === 0
        ? currentMaxScrollTop
        : Math.max(currentMaxScrollTop, compensatedMaxScrollTop)
    reconcileFollowing(
      tailingNow || (!state.landed && state.offset >= state.lastMaxScrollTop),
      snap.window.hasAfter,
    )
    if (!state.anchor) captureAnchor(snap)
    else if (!state.textPosition && state.anchor.kind === "block" && !tailingNow) {
      // Navigation can arrive before virtualization mounts the destination.
      // Complete its source anchor once layout exists, but never recapture
      // an established logical position after reflow.
      captureReadingText(state.anchor.blockIndex, state.offset)
    }

    const { edge, deficit } = frameEdgeSignals(e, snap, index, untrack(projection).zeroHeightBlockIndices)
    // Underfill repair depends on residency: an empty window cold-opens with
    // one anchor hydrate, but once blocks are resident the missing rows sit
    // ABOVE the window (underfill implies hasBefore) and an afterBlock anchor
    // read can never extend upward - re-firing it would fetch the same range
    // every frame. Page older through the same lane as edge approach.
    if (deficit > 0 && snap.blocks.length === 0) { void deps.hydrateAnchor(); return }
    if (deficit > 0) deps.onNearEdge?.("older")
    else if (edge) deps.onNearEdge?.(edge)

    // Far-page eviction: residency past the resident-block budget sheds pages
    // far above the viewport. Only over-budget sessions can get here (a
    // fitting session's residency is bounded by its total), so eviction never
    // undercuts the eager mount. The cut is derived from the applied position,
    // so the reader's neighborhood (plus a generous upward-paging margin) is
    // always protected.
    const start = snap.window.startBlockIndex
    const end = snap.window.endBlockIndex
    if (deps.evictBefore && start !== null && end !== null && end - start + 1 > RESIDENT_BLOCK_BUDGET) {
      const viewportTopBlock = index.rowOffsetToBlockIndex(Math.max(0, e.scrollTop - leading))
      const cut = Math.min(viewportTopBlock - EVICT_PROTECTED_BLOCKS, end)
      if (cut - start >= EVICT_MIN_BLOCKS) deps.evictBefore(cut)
    }
  }

  /** After the rows of this frame's layout reported their sizes, and before
   *  paint: apply those measurements and keep the decided reading position
   *  on the same content. It never consumes input; that is onFrame's. */
  function onRowsMeasured(): void {
    const e = el
    if (!e || decidedFrameId !== e.ctx.frameId || landOnLayout(e)) return
    const index = untrack(heightIndex)
    index.flushMeasurements()
    const corrections = index.takeCorrections()
    if (corrections.length === 0) return
    telemetry.event("corrections drained", e, {
      count: corrections.length,
      totalRows: corrections.reduce((sum, c) => sum + c.deltaRows, 0),
      upstreamRows: state.anchor ? upstreamCorrectionRows(corrections, state.anchor.blockIndex) : 0,
      firstBlock: corrections[0]?.blockIndex,
      lastBlock: corrections.at(-1)?.blockIndex,
    })
    if (tailingNow || restoring || readingOnLayout || !state.anchor) return
    const rows = upstreamCorrectionRows(corrections, state.anchor.blockIndex)
    if (rows === 0) return
    state.offset = Math.max(0, state.offset + rows)
    // The decision's native extent can already include this growth. Add it
    // only to the compensation floor, not to the adopted native bottom.
    state.lastMaxScrollTop = preserveOffTailBottom
      ? compensatedMaxScrollTop + rows
      : Math.max(maxScrollTop(e), compensatedMaxScrollTop + rows)
    writeScroll(e, state.offset, "frame.compensate")
    // Input in the decision captured its text position on this layout at
    // the offset before compensation; capture it again where it now reads.
    captureAnchor(untrack(snapshot))
    syncViewport(e)
  }

  /** Adopts the frame's viewport size and returns how many rows it grew.
   *  Wrapped rows scale ~ oldCols/newCols until they re-measure. Both sizes
   *  persist in the slot, so a terminal resized while this session was
   *  backgrounded rescales on its first frame back in the foreground. */
  function adoptViewportSize(e: ScrollBoxRenderable, index: HeightIndex): number {
    const { width, height } = e.viewport
    if (state.lastViewportWidth > 0 && width > 0 && width !== state.lastViewportWidth) {
      index.rescaleKnown(state.lastViewportWidth / width)
      // The rescale also moved rows whose height the new width kept, and those
      // rows call no size callback. Every mounted row reports its true height.
      deps.mountedRows?.reportHeights(index)
    }
    if (width > 0) state.lastViewportWidth = width
    const growth = state.lastViewportRows > 0 && height > 0 ? height - state.lastViewportRows : 0
    if (height > 0) state.lastViewportRows = height
    return growth
  }

  /** Apply the profile's share of the waiting wheel rows. Line reports land
   *  whole on this frame. Notch reports glide: a frame applies half, so the
   *  rest shrinks geometrically and stops a few frames after the last report
   *  (a fixed per-frame ration once turned a big flick into seconds of
   *  catch-up motion after the fingers stopped). */
  function applyWheelRows(e: ScrollBoxRenderable, frameNow: number): void {
    const step = frameWheelRows(wheelProfile, pendingWheelRows)
    if (step === 0) return
    pendingWheelRows -= step
    adoptUserOffset(e, state.offset + step, "user.wheel")
    if (pendingWheelRows === 0) {
      wheelQueuedAt = 0
      return
    }
    wheelQueuedAt = frameNow
    e.requestRender()
  }

  /** Wheel input: OpenTUI's base handler is suppressed, and the report is not
   *  applied inline either. The profile turns it into rows, which join the
   *  rows that wait for the next frames. A report against the waiting
   *  direction nets with them, so every report moves the view. */
  function onWheel(e: ScrollBoxRenderable, event: MouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    const at = now()
    const sign = direction === "down" ? 1 : -1
    if (pendingWheelRows === 0) wheelQueuedAt = at
    pendingWheelRows += sign * wheelRows(sign, at)
    e.requestRender()
  }

  function wheel(event: MouseEvent): void {
    if (el) onWheel(el, event)
  }

  /** Scrollbar press or drag: the base handler already applied it to
   *  scrollTop; a drag is EXPLICIT input, so adopting the applied position is
   *  intent, not inference. */
  function onScrollbarDrag(e: ScrollBoxRenderable): void {
    captureUserOffset(e, e.scrollTop, "user.scrollbar")
  }

  function updateSelectionFocus(e: ScrollBoxRenderable): void {
    if (!selectionPointer) return
    const right = e.viewport.x + Math.max(0, e.viewport.width - 1)
    const bottom = e.viewport.y + Math.max(0, e.viewport.height - 1)
    const x = Math.max(e.viewport.x, Math.min(selectionPointer.x, right))
    const y = Math.max(e.viewport.y, Math.min(selectionPointer.y, bottom))
    deps.updateSelection(e, x, y)
  }

  function containsSelectionStart(target: BaseRenderable | null): boolean {
    const currentElement = el
    if (!currentElement) return false
    for (let current = target; current; current = current.parent) if (current === currentElement) return true
    return false
  }

  function updateSelectionDrag(x: number, y: number): void {
    const currentElement = el
    if (!currentElement) return
    selectionPointer = { x, y }
    currentElement.updateAutoScroll(x, y)
    updateSelectionFocus(currentElement)
  }

  function stopSelectionDrag(): void {
    selectionPointer = undefined
    el?.stopAutoScroll()
  }

  function page(action: "page-up" | "page-down" | "half-page-up" | "half-page-down"): void {
    const e = el
    if (!e) return
    const up = action === "page-up" || action === "half-page-up"
    const rows = action.startsWith("half-") ? Math.max(1, Math.floor(e.viewport.height / 2)) : e.viewport.height
    captureUserOffset(e, state.offset + (up ? -rows : rows), `command.${action}`)
  }

  function toTop(): void {
    const e = el
    if (!e) return
    captureUserOffset(e, 0, "command.top")
  }

  /** Jump to the live tail (End/G). If newer history is unhydrated, jump to
   *  the loaded bottom and pin the real tail when it hydrates. */
  function toBottom(): void {
    const e = el
    if (!e) return
    const snap = untrack(snapshot)
    captureUserOffset(e, maxScrollTop(e), "command.bottom")
    state.pendingTailIntent = snap?.window.hasAfter === true
    setBaseline(undefined)
  }

  function returnToLatest(): void {
    state.landed = false
    setBaseline(undefined)
    state.pendingTailIntent = true
    void deps.jumpToLatest()
  }

  function toBlock(blockIndex: number): void {
    const e = el
    if (!e) return
    Reflect.deleteProperty(deps.slot, "restoreAnchor")
    pendingBlockTarget = { kind: "land", blockIndex }
    e.requestRender()
  }

  /** Centres the landing block on its laid-out rows, before paint: the middle
   *  of the block at the middle of the viewport, a block taller than the
   *  viewport from its top, both clamped to the content. The reading anchor
   *  then holds the block's own text at its row of the viewport, so rows that
   *  lay out above it later in this frame or after do not move it. Returns
   *  false while the block has no layout yet. */
  function landOnLayout(e: ScrollBoxRenderable): boolean {
    const blockIndex = landing
    const rows = blockIndex === undefined ? undefined : deps.mountedRows?.layoutRows(blockIndex)
    if (blockIndex === undefined || rows === undefined) return false
    landing = undefined
    repositioned = true
    // The mounted range follows both the index and the published offset. It
    // must take them together: on the corrected index with the estimated
    // offset it would unmount the block and its neighbours, and the placement
    // and text anchor taken here would stand on rows remounted without layout.
    batch(() => {
      // Mounted rows that no frame showed yet have laid out without reporting
      // their heights. The index takes every mounted height from the layout, so
      // the offset published below maps back to these rows, and the corrections
      // that layout already holds do not move the placement again.
      const index = untrack(heightIndex)
      deps.mountedRows?.reportHeights(index)
      index.flushMeasurements()
      index.takeCorrections()
      frameExtent = e.scrollHeight
      state.offset = Math.max(0, Math.min(centredTop(rows.top, rows.height, e.viewport.height), maxScrollTop(e)))
      writeScroll(e, state.offset, "command.block")
      state.anchor = { kind: "block", blockIndex, rowOffsetWithinBlock: state.offset - rows.top }
      state.anchorIdentity = identityAt(untrack(snapshot), blockIndex)
      captureReadingText(blockIndex, rows.top)
      syncViewport(e)
    })
    return true
  }

  /** Capture the current viewport-top as the anchor and run a content mutation
   *  (expand/collapse): the frame hook's compensation keeps the content under
   *  the cursor still. At the pinned tail the bottom anchor lets go (see
   *  suppressTailFrames), so a toggle grows downward there like anywhere else. */
  function preserveScroll(mutate: () => void): void {
    const e = el
    if (!e) { mutate(); return }
    const snap = untrack(snapshot)
    captureAnchor(snap)
    // A toggle is explicit input: a deferred End intent must not re-pin the
    // tail the frame the release window expires.
    state.pendingTailIntent = false
    suppressTailFrames = 2
    reconcileFollowing(false, snap?.window.hasAfter === true)
    mutate()
  }

  function attach(e: ScrollBoxRenderable): void {
    el = e
    // A press anywhere in the transcript starts a selection, except on the
    // scrollbar: OpenTUI paints the bar inside the box, and a selection that
    // starts there takes the drag from the thumb.
    e.selectable = true
    e.shouldStartSelection = (x, y) => {
      const bar = e.verticalScrollBar
      return !bar.visible || x < bar.x || x >= bar.x + bar.width || y < bar.y || y >= bar.y + bar.height
    }
    const restore = patchScrollBoxHooks(e, {
      onFrameStart: () => untrack(onFrame),
      onFrame: () => untrack(() => batch(onRowsMeasured)),
      onWheel: (event) => untrack(() => wheel(event)),
      onScrollbarDrag: () => untrack(() => onScrollbarDrag(e)),
      onSelectionDrag: (event) => untrack(() => updateSelectionDrag(event.x, event.y)),
      onSelectionEnd: () => untrack(stopSelectionDrag),
      // Later native layout rounds can move reactive spacers and re-clamp the
      // offset after onFrame. When such a round moved the extent, resolve the
      // reading anchor on its geometry before reasserting the offset, without
      // applying frame input again. An unchanged extent leaves the decided
      // offset standing. Keep the frame's mounted range: publishing another
      // viewport here can remount rows and cycle layout before their
      // measurements reach the index.
      onResize: () => untrack(() => {
        // A viewport that changed size since the decision needs the height-index
        // rescale of the next decision first: a new offset can unmount the anchor.
        if (Number.isFinite(frameExtent) && decidedFrameId === e.ctx.frameId && e.viewport.width === state.lastViewportWidth && e.viewport.height === state.lastViewportRows && !landOnLayout(e) && e.scrollHeight !== frameExtent) {
          frameExtent = e.scrollHeight
          if (tailingNow && returnToLatestBaseline() === undefined) state.offset = maxScrollTop(e)
          else resolveMountedReadingAnchor()
        }
        writeScroll(e, state.offset, "resize.reassert")
      }),
    })
    onCleanup(() => { stopSelectionDrag(); restore(); el = undefined })
  }

  return {
    heightIndex,
    heightIndexRecord,
    viewport,
    attach,
    page,
    toTop,
    toBottom,
    toBlock,
    wheel,
    preserveScroll,
    selectionAutoScroll: { contains: containsSelectionStart, update: updateSelectionDrag, stop: stopSelectionDrag },
    returnToLatestBaseline,
    returnToLatest,
  }
}
