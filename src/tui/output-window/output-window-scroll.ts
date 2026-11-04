import { TextBufferRenderable, type MouseEvent, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, createComputed, createMemo, createRoot, createSignal, on, untrack } from "solid-js"
import { patchScrollBoxLayoutHooks } from "../components/scrollbox-layout-hooks.js"
import { createHeightIndex, type ExtentCorrection, type HeightIndex, type HeightIndexConfig } from "../hooks/create-height-index.js"
import type { TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { DEFAULT_ESTIMATE } from "../hooks/output-height-estimates.js"
import type { LaunchScroll } from "../../infra/launch-state.js"

// Scroll virtualization keeps one authoritative offset, follows the bottom when
// position permits, detects unhydrated edges, and compensates for prepended rows.
// OpenTUI spacer rows represent unmounted content; the imperative HeightIndex is
// the single source of truth for offset-to-block mapping and measured extents.

export type EdgeDirection = "older" | "newer"

/** The resident-block budget: how many timeline blocks the TUI will hold
 *  mounted-or-resident for one session. One number, two enforcement
 *  mechanisms. A session whose TOTAL block count fits the budget mounts whole
 *  once to measure every height and hydrates to the head (then virtualizes to
 *  the viewport); a larger session virtualizes immediately, pages on demand,
 *  and far-page eviction sheds residency back under the same budget - so the
 *  two policies can never fight over one session. Sized ~3x the largest
 *  observed real session (~350 blocks; events fold heavily into blocks) at
 *  ~1ms measure cost per block. The over-budget path is insurance against the
 *  condensation policy changing, not an expected path. */
export const RESIDENT_BLOCK_BUDGET = 1000

/** Rows mounted and acquired on either side of the viewport before they enter it. */
export const OVERSCAN_ROWS = 120

/** Near-edge overscan in rows. Paging starts inside this band so the command
 *  layer can load an unhydrated edge before the user reaches the gap. */
const NEAR_EDGE_ROWS = 8

/** The hydrated window's place inside the absolute, fully-estimated transcript.
 *  Spacer sizes are pure functions of this plus the HeightIndex extents. */
export interface WindowGeometry {
  /** Absolute index of the first hydrated block (null = nothing hydrated). */
  readonly startBlockIndex: number | null
  /** Absolute index of the last hydrated block. */
  readonly endBlockIndex: number | null
  /** Total blocks in the generation (spacer denominator). */
  readonly totalBlocks: number
}

export function windowGeometry(snapshot: TranscriptSnapshot): WindowGeometry {
  return {
    startBlockIndex: snapshot.window.startBlockIndex,
    endBlockIndex: snapshot.window.endBlockIndex,
    totalBlocks: snapshot.totalBlocks,
  }
}

interface SpacerRows {
  /** Estimated rows of every block above the hydrated window. */
  readonly top: number
  /** Estimated rows of every block below the hydrated window. */
  readonly bottom: number
}

/** Top/bottom spacer heights for the hydrated window. The top spacer is the
 *  estimated extent of blocks [0, start); the bottom is [end+1, total). The
 *  hydrated rows in between mount real content, so scrollHeight = top + measured
 *  window + bottom = the HeightIndex's totalRows(). An empty window collapses to
 *  a single bottom spacer covering the whole transcript. */
function spacerRows(geometry: WindowGeometry, index: HeightIndex): SpacerRows {
  const total = geometry.totalBlocks
  if (geometry.startBlockIndex === null || geometry.endBlockIndex === null) {
    return { top: 0, bottom: index.blockIndexToRowOffset(total) }
  }
  const top = index.blockIndexToRowOffset(geometry.startBlockIndex)
  const afterWindow = index.blockIndexToRowOffset(geometry.endBlockIndex + 1)
  return { top, bottom: Math.max(0, index.blockIndexToRowOffset(total) - afterWindow) }
}

// The sum is queried several times per scrolled frame (spacers, projected totals,
// near-edge) and is provably 0 once the indices are recorded as measured-zero,
// yet each raw computation costs O(k log n) Fenwick queries. The projection hands
// out one stable indices array per change, so a WeakMap entry per array keyed by
// extentVersion makes the per-frame cost one Map hit.
const zeroHeightRowsCache = new WeakMap<readonly number[], { version: number; rows: number }>()

function zeroHeightRows(index: HeightIndex, zeroHeightBlockIndices: readonly number[]): number {
  if (zeroHeightBlockIndices.length === 0) return 0
  const version = index.extentVersion()
  const cached = zeroHeightRowsCache.get(zeroHeightBlockIndices)
  if (cached && cached.version === version) return cached.rows
  let rows = 0
  for (const blockIndex of zeroHeightBlockIndices) {
    rows += Math.max(0, index.blockIndexToRowOffset(blockIndex + 1) - index.blockIndexToRowOffset(blockIndex))
  }
  zeroHeightRowsCache.set(zeroHeightBlockIndices, { version, rows })
  return rows
}

export function projectedTotalRows(index: HeightIndex, zeroHeightBlockIndices: readonly number[] = []): number {
  return Math.max(0, index.totalRows() - zeroHeightRows(index, zeroHeightBlockIndices))
}


function heightIndexConfig(snapshot: TranscriptSnapshot | undefined): HeightIndexConfig {
  return {
    itemCount: snapshot?.totalBlocks ?? 0,
    estimatedRows: DEFAULT_ESTIMATE,
    initialEstimates: snapshot?.heightEstimates.map((estimate) => [estimate.blockIndex, estimate.rows] as const) ?? [],
  }
}

/** The transcript's long-lived height index survives live growth and OutputWindow
 *  remounts. A new generation replaces it; growth or truncation resizes it in
 *  place so surviving measurements persist. Visibility changes demote measured
 *  values to estimates, then synchronously restore mounted measurements through
 *  onDemote before new estimates can overwrite their unchanged native sizes. */
export function createSnapshotHeightIndex(deps: {
  readonly snapshot: Accessor<TranscriptSnapshot | undefined>
  readonly showThinking: Accessor<boolean>
  readonly slot: TranscriptLayoutSlot
  readonly onDemote?: (index: HeightIndex) => void
}): Accessor<TranscriptHeightIndexRecord> {
  const { slot } = deps
  const record = createMemo<TranscriptHeightIndexRecord>(() => {
    const snap = deps.snapshot()
    const generation = snap?.generation ?? -1
    const nextToggles = String(deps.showThinking())
    const totalBlocks = snap?.totalBlocks ?? 0
    const cached = slot.heightIndex
    if (cached && cached.generation === generation) {
      // Same reference out: downstream consumers are not re-notified through the
      // memo, re-run via their own snapshot/extentVersion tracking, and read the
      // resized index synchronously. resize makes no reactive writes.
      cached.index.resize(totalBlocks)
      if (cached.toggles !== nextToggles) {
        cached.toggles = nextToggles
        cached.index.demoteAllToEstimates()
        untrack(() => deps.onDemote?.(cached.index))
      }
      return cached
    }
    const created = createHeightIndex(untrack(() => heightIndexConfig(snap)))
    slot.heightIndex = {
      index: created,
      generation,
      toggles: nextToggles,
      eagerCompleted: false,
      eagerStartedAt: undefined,
    }
    return slot.heightIndex
  })
  return record
}

export interface TranscriptHeightIndexRecord {
  readonly index: HeightIndex
  readonly generation: number
  toggles: string
  eagerCompleted: boolean
  eagerStartedAt: number | undefined
}

/** Layout memory for one session, surviving OutputWindow remounts (the keyed
 *  foreground <Show> tears the whole render tree down on a tab switch). The
 *  remounted OutputWindow adopts its session's slot and re-renders at exact
 *  measured row heights and the exact prior scroll position instead of
 *  re-estimating, re-measuring, and re-tailing - the visible tab-switch
 *  reflow. Both members are imperative state outside the Solid graph (a
 *  HeightIndex's extentVersion signal has no owner, so root disposal never
 *  invalidates it). */
export interface TranscriptLayoutSlot {
  /** The session the slot holds; the layout cache sets it. Diagnostic
   *  records of the transcript name it. */
  readonly sessionId?: string
  /** The generation-keyed measured extents; createSnapshotHeightIndex adopts
   *  and maintains it. */
  heightIndex?: TranscriptHeightIndexRecord
  /** The scroll controller's authoritative position, mutated in place by
   *  createOutputScrollController - the slot IS the state, no save/restore. */
  scroll?: TranscriptScrollState
  /** Measured height of the queued-message overlay (OutputWindow's trailing
   *  spacer); seeds the spacer on remount so the restored scroll extent is
   *  right at first paint. */
  pendingRows?: number
  /** Measured full-width row columns; seeds block wrap widths on remount so
   *  first layouts wrap the final shape (see context/row-width.ts). */
  rowWidth?: number
  /** Absolute visible-message count captured when this client stopped following. */
  returnToLatestBaseline?: number
  /** The place a predecessor terminal held in this session (ARCH-DISTRIBUTION-031): a
   *  block's absolute index and the rows scrolled into it. The scroll
   *  controller holds it through every repave of the opening transcript and
   *  drops it at the person's first scroll. */
  restoreAnchor?: { readonly blockIndex: number; readonly rowOffsetWithinBlock: number }
}
type NumericSlot<K extends string> = { [P in K]?: number }

/** Signal backed by a cross-mount slot field: the setter writes the reactive
 *  signal and the slot in one step, so the in-mount view and the remount seed
 *  can never diverge. Seeds from the slot's persisted value. */
export function createSlotSignal<K extends string>(
  slot: NumericSlot<K>,
  key: K,
): [Accessor<number>, (value: number) => void] {
  const [rows, setRows] = createSignal(slot[key] ?? 0)
  return [rows, (value) => {
    slot[key] = value
    setRows(value)
  }]
}

/** The scroll controller's cross-remount position state. Field semantics live
 *  with their one writer, the controller's frame loop
 *  (create-output-scroll-controller.ts). */
export interface TranscriptScrollState {
  offset: number
  anchor: ScrollAnchor | undefined
  anchorIdentity?: string
  textPosition?: MountedTextPosition
  /** Rows from the viewport top down to `textPosition`. */
  textDepth: number
  generation: number | undefined
  lastMaxScrollTop: number
  pendingTailIntent: boolean
  lastLeadingRows: number
  lastViewportWidth: number
  lastViewportRows: number
  /** A land placed the reader, so reaching the bottom by it does not resume
   *  following. Explicit input and Return to latest end it. */
  landed: boolean
}

/** Mirrors the transcript cache's session floor (MAX_SESSIONS): layout memory
 *  for a session whose blocks were evicted re-measures on re-hydration anyway. */
const MAX_LAYOUT_SLOTS = 30

/** LRU per-session layout slots. The shell creates one cache for the app and
 *  hands the foreground's slot across the keyed OutputWindow remount boundary.
 *  The capacity follows the active session count, like the transcript cache,
 *  so switching among every working session keeps each one's scroll position
 *  and measured heights. */
export function createTranscriptLayoutCache(activeSessionCount: () => number = () => 0): (sessionId: string) => TranscriptLayoutSlot {
  const slots = new Map<string, TranscriptLayoutSlot>()
  return (sessionId) => {
    const existing = slots.get(sessionId)
    if (existing) {
      // Re-insertion keeps Map order = recency order.
      slots.delete(sessionId)
      slots.set(sessionId, existing)
      return existing
    }
    const slot: TranscriptLayoutSlot = { sessionId }
    slots.set(sessionId, slot)
    const capacity = Math.max(MAX_LAYOUT_SLOTS, activeSessionCount())
    for (const oldest of slots.keys()) {
      if (slots.size <= capacity) break
      slots.delete(oldest)
    }
    return slot
  }
}

/** Summed row delta of the corrections strictly above the anchor block - the
 *  amount the content under the viewport top just shifted by. */
export function upstreamCorrectionRows(corrections: readonly ExtentCorrection[], boundaryBlockIndex: number): number {
  let delta = 0
  for (const correction of corrections) if (correction.blockIndex < boundaryBlockIndex) delta += correction.deltaRows
  return delta
}

interface ScrollBoxHookHandlers {
  /** The frame decision: runs before the rows report this frame's layout, so
   *  rows it mounts join this frame's later layout rounds. */
  readonly onFrameStart: (dt: number) => void
  /** Runs after the rows report their sizes and before paint: measurements
   *  and corrections apply before paint, so no uncompensated position paints. */
  readonly onFrame: (dt: number) => void
  /** Wheel input, routed to the controller INSTEAD of OpenTUI's base handler. */
  readonly onWheel: (event: MouseEvent) => void
  /** Scrollbar press or drag (after the base handler applied it). */
  readonly onScrollbarDrag: () => void
  /** Native selection dragging, observed after OpenTUI updates its auto-scroll target. */
  readonly onSelectionDrag: (event: MouseEvent) => void
  readonly onSelectionEnd: () => void
  /** Runs after every viewport or content size change. Later native layout
   *  rounds can resize reactive spacers after onFrame and re-clamp the offset.
   *  The controller reconciles the extent and reading anchor on that geometry,
   *  then reasserts the offset before paint without consuming frame input again. */
  readonly onResize: () => void
}

function readMouseEvent<Target extends object>(target: Target): ((event: MouseEvent) => void) | undefined {
  if (!("onMouseEvent" in target) || typeof target.onMouseEvent !== "function") return undefined
  const method = target.onMouseEvent
  return (event) => method.call(target, event)
}

/** Wrap OpenTUI's protected update/mouse hooks so the scroll controller solely
 *  owns scrollTop: wheel events bypass the base handler and every tick funnels
 *  through one pre-paint decision. Returns the function that restores the hooks. */
export function patchScrollBoxHooks(e: ScrollBoxRenderable, handlers: ScrollBoxHookHandlers): () => void {
  const baseMouseEvent = readMouseEvent(e)
  const restoreLayoutHooks = patchScrollBoxLayoutHooks(e, {
    onFrameStart: handlers.onFrameStart,
    onFrame: handlers.onFrame,
    onResize: handlers.onResize,
  })
  Reflect.set(e, "onMouseEvent", (event: MouseEvent) => {
    // Ownership inversion: wheel input never reaches OpenTUI's base scroll
    // handler - the controller computes and writes the offset itself. Every
    // other mouse event (selection, clicks) passes through untouched.
    if (event.type === "scroll") {
      handlers.onWheel(event)
      return
    }
    baseMouseEvent?.(event)
    // The base handler stops the propagation of each press, drag, and release
    // that it applies to a scrollbar.
    if (event.propagationStopped) handlers.onScrollbarDrag()
    else if (event.type === "drag" && event.isDragging) handlers.onSelectionDrag(event)
    else if (event.type === "up" || event.type === "drag-end") handlers.onSelectionEnd()
  })
  return () => {
    restoreLayoutHooks()
    Reflect.deleteProperty(e, "onMouseEvent")
  }
}

export function recordZeroHeightBlocks(index: HeightIndex, zeroHeightBlockIndices: readonly number[]): void {
  if (zeroHeightBlockIndices.length === 0) return
  index.recordMeasuredBatch(zeroHeightBlockIndices.map((blockIndex) => [blockIndex, 0] as const))
}

/** Restore an estimate for blocks that a visibility change reveals. Their
 * measured zero height described the hidden representation, not the visible
 * block that will mount later. */
export function seedRevealedBlockEstimates(index: HeightIndex, prior: ReadonlySet<number>, current: ReadonlySet<number>): void {
  const revealed = [...prior].filter((blockIndex) => !current.has(blockIndex))
  if (revealed.length > 0) index.seedEstimatedBatch(revealed.map((blockIndex) => [blockIndex, DEFAULT_ESTIMATE] as const))
}

export function recordKnownBlockHeights(index: HeightIndex, snapshot: TranscriptSnapshot, zeroHeightBlockIndices: readonly number[]): void {
  const estimates = snapshot.heightEstimates.map((estimate) => [estimate.blockIndex, estimate.rows] as const)
  if (estimates.length > 0) index.seedEstimatedBatch(estimates)
  recordZeroHeightBlocks(index, zeroHeightBlockIndices)
}

/** Live mounted transcript rows, keyed by renderable: the source positions
 *  that keep the reading anchor on the same text across reflow. Rows report
 *  their own size changes; width changes and demotion request a fresh report. */
type MountedRow = Pick<Renderable, "getLayout" | "getChildren">

export interface MountedRowRegistry {
  /** Track a mounted row and its reactive block index; returns its disposer.
   * `report` queues the row's laid-out height in the index as the row decides:
   * a measurement, an estimate while its content holds the height, or nothing
   * between layouts. A row without `report` records no height. */
  register(el: MountedRow, absoluteIndex: () => number, report?: (index: HeightIndex, height: number) => void): () => void
  /** Report every mounted height, as native layout holds it, after a width
   * change, a measurement demotion, or a land. Rows outside the viewport lay
   * out without a size callback, so only this reaches them. Costs one native
   * layout read per row; scroll frames do not call it. */
  reportHeights(index: HeightIndex): void
  /** Capture the source position at a scroll-content row within this block. */
  captureText(blockIndex: number, rowOffset: number): MountedTextPosition | undefined
  /** Resolve to the scroll content's current laid-out row, before paint. */
  resolveText(blockIndex: number, position: MountedTextPosition): number | undefined
  /** The block's laid-out scroll-content rows, or undefined while it is not
   *  mounted or not laid out yet. */
  layoutRows(blockIndex: number): { readonly top: number; readonly height: number } | undefined
  /** The first and last mounted block and how many rows mount, for a
   *  diagnostic record. Walks every mounted row; no frame path calls it. */
  mountedRange(): { readonly first: number; readonly last: number; readonly count: number } | undefined
}

interface MountedTextPosition {
  readonly path: readonly number[]
  readonly sourceLine: number
  readonly displayColumn: number
}

export function createMountedRowRegistry(): MountedRowRegistry {
  const rows = new Map<MountedRow, { blockIndex: number; report: ((index: HeightIndex, height: number) => void) | undefined }>()
  const rowsByBlock = new Map<number, MountedRow>()
  const resolved = new WeakMap<TextBufferRenderable, { position: MountedTextPosition; width: number; height: number; visual: number | undefined }>()
  const watched = new WeakMap<TextBufferRenderable, () => void>()
  function unwatch(el: MountedRow): void {
    if (el instanceof TextBufferRenderable) {
      const invalidate = watched.get(el)
      if (invalidate) el.off("line-info-change", invalidate)
      watched.delete(el)
      resolved.delete(el)
    } else {
      for (const child of el.getChildren()) unwatch(child)
    }
  }
  function capture(el: MountedRow, row: number, path: readonly number[]): MountedTextPosition | undefined {
    if (el instanceof TextBufferRenderable) {
      const info = el.lineInfo
      const visual = Math.floor(row) + el.scrollY
      const sourceLine = info.lineSources[visual]
      const displayColumn = info.lineStartCols[visual]
      return sourceLine === undefined || displayColumn === undefined ? undefined : { path, sourceLine, displayColumn }
    }
    const children = el.getChildren()
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!child) continue
      const layout = child.getLayout()
      if (row < layout.top || row >= layout.top + layout.height) continue
      const found = capture(child, row - layout.top, [...path, i])
      if (found) return found
    }
    return undefined
  }
  return {
    register(el, absoluteIndex, report) {
      const dispose = createRoot(cleanup => {
        createComputed(on(absoluteIndex, blockIndex => {
          const prior = rows.get(el)?.blockIndex
          // Reindexing can briefly overlap another row's old index.
          if (prior !== undefined && rowsByBlock.get(prior) === el) rowsByBlock.delete(prior)
          rows.set(el, { blockIndex, report })
          rowsByBlock.set(blockIndex, el)
        }))
        return cleanup
      })
      return () => {
        dispose()
        const blockIndex = rows.get(el)?.blockIndex
        if (blockIndex !== undefined && rowsByBlock.get(blockIndex) === el) rowsByBlock.delete(blockIndex)
        rows.delete(el)
        unwatch(el)
      }
    },
    reportHeights(index) {
      for (const [el, { report }] of rows) report?.(index, el.getLayout().height)
    },
    captureText(blockIndex, rowOffset) {
      const row = rowsByBlock.get(blockIndex)
      if (!row) return undefined
      return capture(row, rowOffset - row.getLayout().top, [])
    },
    resolveText(blockIndex, position) {
      let el: MountedRow | undefined = rowsByBlock.get(blockIndex)
      if (!el) return undefined
      let top = el.getLayout().top
      for (const childIndex of position.path) {
        el = el.getChildren()[childIndex]
        if (!el) return undefined
        top += el.getLayout().top
      }
      if (!(el instanceof TextBufferRenderable)) return undefined
      if (!watched.has(el)) {
        const leaf = el
        const invalidate = () => { resolved.delete(leaf) }
        leaf.on("line-info-change", invalidate)
        watched.set(leaf, invalidate)
      }
      const layout = el.getLayout()
      // Reactive virtualization can remount the anchor during a layout round.
      // Its native dimensions are NaN until the next round lays it out.
      if (!Number.isFinite(layout.height)) return undefined
      let cached = resolved.get(el)
      // Native text stays isDirty after painting in 0.6. Its line-info event
      // invalidates source mappings on content changes without polling the text.
      if (!cached || cached.position !== position || cached.width !== layout.width || cached.height !== layout.height) {
        const info = el.lineInfo
        let visual: number | undefined
        for (let i = 0; i < info.lineSources.length; i++) {
          const column = info.lineStartCols[i]
          if (info.lineSources[i] !== position.sourceLine || column === undefined || column > position.displayColumn) continue
          visual = i
        }
        cached = { position, width: layout.width, height: layout.height, visual }
        resolved.set(el, cached)
      }
      return cached.visual === undefined ? undefined : top + cached.visual - el.scrollY
    },
    layoutRows(blockIndex) {
      const layout = rowsByBlock.get(blockIndex)?.getLayout()
      return layout === undefined || !Number.isFinite(layout.height) ? undefined : { top: layout.top, height: layout.height }
    },
    mountedRange() {
      let first = Number.POSITIVE_INFINITY
      let last = Number.NEGATIVE_INFINITY
      for (const blockIndex of rowsByBlock.keys()) {
        first = Math.min(first, blockIndex)
        last = Math.max(last, blockIndex)
      }
      return rowsByBlock.size === 0 ? undefined : { first, last, count: rowsByBlock.size }
    },
  }
}

/** The stable viewport-top reference. When the top is over mounted content we
 *  anchor to that block row. When it is inside a spacer, we anchor to the nearest
 *  hydrated boundary plus distance; a spacer estimate is never promoted into a
 *  fake source block. A viewport top inside the leading extent (the session intro
 *  renders inside the scrollbox ABOVE the transcript rows) is a block-0 anchor
 *  with a NEGATIVE within-block offset, so positions over the intro round-trip
 *  exactly. The trailing notice row and the queued-message spacer need no
 *  representation: they sit below all content, so captures and re-pins cancel
 *  and bottom-follow uses the element's real scrollHeight. */
export type ScrollAnchor =
  | { readonly kind: "block"; readonly blockIndex: number; readonly rowOffsetWithinBlock: number }
  | { readonly kind: "before-window"; readonly blockIndex: number; readonly distanceRows: number }
  | { readonly kind: "after-window"; readonly blockIndex: number; readonly distanceRows: number }

export function anchorAtOffset(scrollTop: number, index: HeightIndex, geometry?: WindowGeometry, leadingRows = 0): ScrollAnchor {
  const contentTop = scrollTop - leadingRows
  if (contentTop < 0) return { kind: "block", blockIndex: 0, rowOffsetWithinBlock: contentTop }
  if (geometry && geometry.startBlockIndex !== null && geometry.endBlockIndex !== null) {
    const spacers = spacerRows(geometry, index)
    const windowEnd = index.blockIndexToRowOffset(geometry.endBlockIndex + 1)
    if (contentTop < spacers.top) return { kind: "before-window", blockIndex: geometry.startBlockIndex, distanceRows: spacers.top - contentTop }
    if (contentTop >= windowEnd) return { kind: "after-window", blockIndex: geometry.endBlockIndex + 1, distanceRows: contentTop - windowEnd }
  }
  const blockIndex = index.rowOffsetToBlockIndex(contentTop)
  return { kind: "block", blockIndex, rowOffsetWithinBlock: Math.max(0, contentTop - index.blockIndexToRowOffset(blockIndex)) }
}

/** Where a reader stands in one session's transcript, as a place another
 *  process can find again (ARCH-DISTRIBUTION-031): following the live end, or a block's
 *  absolute index and the rows scrolled into it. Measured offsets are this
 *  process's own and never travel. A place handed in and not shown yet is
 *  handed on as it came. */
export function transcriptPlace(slot: TranscriptLayoutSlot, snapshot: TranscriptSnapshot | undefined): LaunchScroll | undefined {
  if (slot.restoreAnchor) return slot.restoreAnchor
  const { scroll: state, heightIndex: record } = slot
  if (!state || !snapshot || !record || record.generation !== snapshot.generation) return undefined
  if (!snapshot.window.hasAfter && state.offset >= state.lastMaxScrollTop) return { tail: true }
  const anchor = anchorAtOffset(state.offset, record.index, windowGeometry(snapshot), state.lastLeadingRows)
  return anchor.kind === "block" ? { blockIndex: anchor.blockIndex, rowOffsetWithinBlock: anchor.rowOffsetWithinBlock } : undefined
}

interface NearEdgeInput {
  readonly scrollTop: number
  readonly viewportRows: number
  readonly totalRows: number
  readonly spacers: SpacerRows
  // The window-edge flags carry the protocol's names: hasBefore = older history
  // remains above the window, hasAfter = newer history remains below it.
  readonly hasBefore: boolean
  readonly hasAfter: boolean
}

/** Which unhydrated edge (if any) the viewport is approaching. Content spans
 *  [0, totalRows): the top spacer is [0, top), the hydrated window is
 *  [top, totalRows-bottom), the bottom spacer is [totalRows-bottom, totalRows).
 *  The viewport nears older history when its top falls within NEAR_EDGE_ROWS of
 *  the top spacer's end, and newer history when its bottom falls within
 *  NEAR_EDGE_ROWS of where the bottom spacer begins. Returns null when neither
 *  edge is close (or that edge is already hydrated). */
function nearEdge(input: NearEdgeInput): EdgeDirection | null {
  const viewportTop = input.scrollTop
  const viewportBottom = input.scrollTop + input.viewportRows
  if (input.hasBefore && viewportTop <= input.spacers.top + NEAR_EDGE_ROWS) return "older"
  const bottomSpacerStart = input.totalRows - input.spacers.bottom
  if (input.hasAfter && viewportBottom >= bottomSpacerStart - NEAR_EDGE_ROWS) return "newer"
  return null
}

/** Underfill: the hydrated window is shorter than the viewport, so even pinned to
 *  the bottom there is empty space. An empty window is repaired by ONE
 *  hydrateAnchor (the cold-open seed); a resident window's deficit is above it
 *  (underfill implies hasBefore) and repairs through an older page. Returns the
 *  row deficit, or 0 when the window fills the viewport. */
function underfillRows(windowRows: number, viewportRows: number, hasBefore: boolean): number {
  if (!hasBefore) return 0
  return Math.max(0, viewportRows - windowRows)
}

/** The paging signals for one scrolled frame: which unhydrated edge the viewport
 *  approaches, and the underfill deficit that warrants a hydrateAnchor. Pure
 *  window math over the extent index; the scroll controller acts on the result. */
export function frameEdgeSignals(
  el: ScrollGeometryElement,
  snapshot: TranscriptSnapshot,
  index: HeightIndex,
  zeroHeightBlockIndices: readonly number[],
) {
  const geometry = windowGeometry(snapshot)
  const spacers = spacerRows(geometry, index)
  const viewportRows = el.viewport.height
  const windowRows = Math.max(0, projectedTotalRows(index, zeroHeightBlockIndices) - spacers.top - spacers.bottom)
  const edge = nearEdge({
    scrollTop: el.scrollTop,
    viewportRows,
    totalRows: projectedTotalRows(index, zeroHeightBlockIndices),
    spacers,
    hasBefore: snapshot.window.hasBefore,
    hasAfter: snapshot.window.hasAfter,
  })
  return { edge, deficit: underfillRows(windowRows, viewportRows, snapshot.window.hasBefore) }
}

export interface ScrollGeometryElement {
  readonly scrollTop: number
  readonly viewport: { readonly height: number }
  readonly scrollHeight: number
}

export function maxScrollTop(el: ScrollGeometryElement): number {
  return Math.max(0, el.scrollHeight - el.viewport.height)
}
