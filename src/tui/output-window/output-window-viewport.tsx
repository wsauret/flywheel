/** @jsxImportSource @opentui/solid */

import type { ChildCardStatus } from "../../protocol/client/session-controls.js"
import type { ToolStreamingText } from "@infra/output-blocks"
import type { BoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Key } from "@solid-primitives/keyed"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import type { HeightIndex } from "../hooks/create-height-index.js"
import { type PresentedTerminalRow, visibleBlockIdentity } from "../output-blocks/visible-output-blocks.js"
import type { OutputTranscriptView, TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { BlockRenderer } from "../output-blocks/block-renderer.js"
import { Divider } from "../output-blocks/system-block.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import type { TranscriptWindowProjection } from "./output-window-projection.js"
import { type MountedRowRegistry, OVERSCAN_ROWS, projectedTotalRows, recordZeroHeightBlocks, RESIDENT_BLOCK_BUDGET, type TranscriptHeightIndexRecord } from "./output-window-scroll.js"
import { Log } from "@infra/log"
import { useRowWidth } from "../context/row-width.js"
import { RowGeometryProvider, type RowGeometryChannel } from "../context/row-geometry.js"
import { MutationEvidenceProvider } from "../context/mutation-evidence.js"
import { createRowChurnMonitor, type RowChurnHandle } from "./output-window-scroll-anomalies.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"

const log = Log.create({ service: "output-window-viewport" })

interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }
interface TranscriptViewportProps {
  snapshot: Accessor<TranscriptSnapshot | undefined>
  projection: Accessor<TranscriptWindowProjection>
  heightIndexRecord: Accessor<TranscriptHeightIndexRecord>
  viewport: Accessor<{ readonly scrollTop: number; readonly viewportRows: number }>
  transcript: OutputTranscriptView
  showThinking?: boolean
  streamingToolText?: StreamingToolTextById
  diffColors?: Accessor<DiffColorMode>
  processControls?: RowProcessControls
  roleView?: (sessionId: string) => RoleAssignmentView | undefined
  childStatus?: (sessionId: string) => ChildCardStatus
  /** MountedRowRegistry: every mounted row registers so the scroll
   *  controller can hold its reading anchor and re-measure after a width
   *  change. */
  registerRow: MountedRowRegistry["register"]
  /** Scroll-content rows outside the height index: the intro above the
   *  transcript rows and the pending spacer below them. */
  unindexedRows: Accessor<number>
  /** The session the transcript shows, named by the default-on churn records. */
  sessionId: string | undefined
}

/** Blocks mounted per painted frame beyond the synchronous viewport cover.
 *  Overscan and eager-measure backfill widen toward their goal at this rate, so
 *  a bucket crossing or a session open never mounts (and re-lays-out) an
 *  unbounded batch in one frame - the profiled cause of scroll hitches and the
 *  tab-open freeze. The viewport-intersecting range itself always mounts
 *  synchronously, so budgeted growth can never expose blank rows under the
 *  cursor; it only defers off-screen work. */
const MOUNT_BUDGET_BLOCKS = 12

// Sessions whose total block count fits RESIDENT_BLOCK_BUDGET mount every item
// once (budgeted, a few blocks per frame), then virtualize to the viewport
// neighborhood. The long-lived extent index preserves measurements, so
// remounting rows is stable. Larger sessions virtualize from the start. The
// budget is shared with background hydration and far-page eviction, so
// mounting, hydration, and eviction agree on which sessions are "small" - and
// hydration keys the same decision on the same totalBlocks this gate reads.

/** The transcript body: synthetic top and bottom spacers around mounted rows.
 *  Spacer heights come from the imperative height index. The mounted range
 *  always covers the viewport synchronously; overscan and the one-time
 *  measure-everything pass grow toward their goal a few blocks per painted
 *  frame (see MOUNT_BUDGET_BLOCKS), then the range slices to the viewport.
 *  Rows use block identity keys, so prepending an older page preserves existing
 *  mounts instead of shifting every position-keyed row. Expansion remains
 *  blockId-keyed, and each mounted row reports its height to the index. */
export function TranscriptViewport(props: TranscriptViewportProps) {
  // Per height-index record (= per generation/visibility) latch: flips once when the
  // transcript is hydrated to the HEAD and every block has measured, and
  // virtualization stays on from then on. An under-budget session arrives
  // head-hydrated in the open fetch, so the latch usually flips on the first
  // measured frame. Head-hydration stays in the condition for the windows
  // that still fill in pages (row/byte-truncated opens) - latching before
  // the head arrives would leave every later-hydrated block above to measure
  // lazily under the user's scroll, which is exactly the upstream
  // correction-hop jitter the eager mount exists to prevent.
  // Only the head matters: blocks below the viewport correct without moving
  // the anchored content, and requiring the tail too would keep a mid-history
  // window (hasAfter until the user scrolls down) eager-mounted indefinitely.
  // New blocks after the latch (live streaming) measure as they enter the
  // mounted neighborhood.
  // Eager-measure duration telemetry (first unmeasured eager frame -> latch
  // flip): the empirical cost of measure-everything-up-front. The slot-owned
  // record preserves both fields across foreground remounts.
  const fullyMeasured = (record: TranscriptHeightIndexRecord, timelineBlockIndices: readonly number[], hydratedToHead: boolean): boolean => {
    if (record.eagerCompleted) return true
    const index = record.index
    if (!hydratedToHead || !timelineBlockIndices.every((blockIndex) => index.hasMeasured(blockIndex))) {
      record.eagerStartedAt ??= performance.now()
      return false
    }
    record.eagerCompleted = true
    const started = record.eagerStartedAt
    if (started !== undefined) {
      const elapsedMs = Math.round(performance.now() - started)
      log.info("eager measure completed", { blocks: timelineBlockIndices.length, elapsedMs, msPerBlock: Number((elapsedMs / Math.max(1, timelineBlockIndices.length)).toFixed(3)) })
    }
    return true
  }
  // Once-per-identity warn latch: the duplication this detects is durable
  // ledger corruption, so re-warning per recompute is spam that buries the
  // one useful line.
  const warnedDuplicates = new Set<string>()
  // The mounted block range. The GOAL is the overscanned viewport neighborhood
  // (or, before the fullyMeasured latch flips, the whole timeline so every
  // block measures once). The EMITTED range reaches that goal under a per-frame
  // mount budget: the viewport-intersecting range is always covered
  // synchronously, shrinks apply immediately, and growth beyond the viewport
  // advances MOUNT_BUDGET_BLOCKS per painted frame, scroll direction first.
  // Growth state is carried in absolute block indices so a prepend (which
  // shifts every projection position) cannot misalign it. Equality-guarded:
  // scroll ticks inside a quant bucket leave the descriptor memo untouched.
  const renderer = useRenderer()
  const [growTick, setGrowTick] = createSignal(0)
  let emittedAbs: { readonly firstBlock: number; readonly lastBlock: number } | undefined
  let lastScrollTop = 0
  let growthQueued = false
  const queueGrowth = () => {
    if (growthQueued) return
    growthQueued = true
    renderer.once("frame", () => {
      growthQueued = false
      setGrowTick((t) => t + 1)
    })
    renderer.requestRender()
  }
  onCleanup(() => { growthQueued = true })
  // Rows whose geometry hold just ended report after the first frame laid out
  // after the hold ended. A hold can end inside a frame: OpenTUI awaits the
  // terminal presentation between a frame's layout and its "frame" event, and a
  // metadata reply lands there. That frame's layout predates the settled content,
  // so only a frame that started later (a higher frameId) reports. Evidence rows
  // settle together (one metadata burst per open), so one shared frame listener
  // drains them all instead of one listener per row.
  const afterLayout = new Map<() => void, number>()
  let draining = false
  const drainAfterLayout = (frame: { readonly frameId: number }) => {
    for (const [report, settledInFrame] of afterLayout) {
      if (settledInFrame >= frame.frameId) continue
      afterLayout.delete(report)
      report()
    }
    if (afterLayout.size > 0) return renderer.requestRender()
    draining = false
    renderer.off("frame", drainAfterLayout)
  }
  const reportAfterLayout = (report: () => void) => {
    if (!draining) {
      draining = true
      renderer.on("frame", drainAfterLayout)
    }
    afterLayout.set(report, renderer.frameId)
    onCleanup(() => afterLayout.delete(report))
    renderer.requestRender()
  }
  onCleanup(() => {
    afterLayout.clear()
    renderer.off("frame", drainAfterLayout)
  })
  // The session is static per mount, like the layout slot that names it.
  const churn = createRowChurnMonitor(untrack(() => props.sessionId))
  onCleanup(() => churn.close())
  const trackChurn = (blockIndex: number) => churn.mounted(blockIndex, untrack(props.heightIndexRecord).generation)
  const range = createMemo<{ readonly start: number; readonly end: number } | undefined>(
    () => {
      const projection = props.projection()
      const record = props.heightIndexRecord()
      const index = record.index
      const snap = props.snapshot()
      index.extentVersion()
      growTick()
      const indices = projection.timelineBlockIndices
      if (indices.length === 0) { emittedAbs = undefined; return undefined }
      // The published offset follows native layout, which grows a frame before the
      // grown row reports its height. The index places nothing past its own bottom,
      // so a later offset maps to that bottom: the rows the viewport shows stay
      // mounted until their report lands, instead of unmounting and shrinking the
      // extent the offset came from.
      const published = props.viewport()
      const indexBottom = Math.max(0, projectedTotalRows(index, projection.zeroHeightBlockIndices) + props.unindexedRows() - published.viewportRows)
      const viewport = published.scrollTop > indexBottom ? { ...published, scrollTop: indexBottom } : published
      const hydratedToHead = snap !== undefined && !snap.window.hasBefore
      // Keyed on the session's TOTAL size, like background hydration: gating
      // on resident length would eager-mount a big session's whole resident
      // window (which eviction then caps below the budget, so it would never
      // virtualize) - big sessions must slice from the first frame.
      const fitsBudget = snap !== undefined && snap.totalBlocks <= RESIDENT_BLOCK_BUDGET
      const eagerMeasuring = fitsBudget && !fullyMeasured(record, indices, hydratedToHead)
      const goal = eagerMeasuring ? { start: 0, end: indices.length } : mountedProjectionRange(indices, index, viewport)
      const scrollingUp = viewport.scrollTop < lastScrollTop
      lastScrollTop = viewport.scrollTop
      const prev = emittedAbs === undefined
        ? undefined
        : { start: lowerBound(indices, emittedAbs.firstBlock), end: upperBound(indices, emittedAbs.lastBlock) }
      const next = widenTowards({
        prev,
        goal,
        must: viewportRange(indices, index, viewport),
        budget: MOUNT_BUDGET_BLOCKS,
        upFirst: scrollingUp,
      })
      const firstBlock = indices[next.start]
      const lastBlock = indices[next.end - 1]
      emittedAbs = firstBlock === undefined || lastBlock === undefined ? undefined : { firstBlock, lastBlock }
      if (next.start !== goal.start || next.end !== goal.end) queueGrowth()
      return next
    },
    undefined,
    { equals: (a, b) => a?.start === b?.start && a?.end === b?.end },
  )
  // Row descriptors follow the mounted range, not the extents: a measurement
  // flush that moves no range boundary leaves every row and its props alone,
  // and only the spacer heights below follow it.
  const rows = createMemo<readonly RowDescriptor[]>(() => {
    const snap = props.snapshot()
    const projection = props.projection()
    const r = range()
    if (!snap || !r) return []
    const indices = projection.timelineBlockIndices.slice(r.start, r.end)
    const blocks = projection.timelineBlocks.slice(r.start, r.end)
    const boundaries = projection.hasBoundaryBefore.slice(r.start, r.end)
    const windowStart = snap.window.startBlockIndex ?? 0
    // Keyed by block id (see <Key>): a prepend reconciles existing rows by identity
    // instead of re-pointing every position, so only the new page mounts/measures.
    // Duplicate identities get an occurrence suffix: <Key> would otherwise hand the
    // reconciler the SAME renderable twice and Yoga aborts the whole process on the
    // second insert ("child already has an owner"). A duplicate here means the
    // durable branch itself double-recorded a turn - render it truthfully, but
    // loudly: the writer bug is upstream, never here.
    const occurrences = new Map<string, number>()
    return blocks.map((block, i) => {
      const identity = visibleBlockIdentity(block)
      const seen = occurrences.get(identity) ?? 0
      occurrences.set(identity, seen + 1)
      if (seen > 0 && !warnedDuplicates.has(identity)) {
        warnedDuplicates.add(identity)
        log.warn("duplicate block identity in transcript window", { identity, absoluteIndex: indices[i] })
      }
      return {
        id: seen === 0 ? identity : `${identity}~dup${seen}`,
        block,
        absoluteIndex: indices[i] ?? windowStart + i,
        hasBoundaryBefore: boundaries[i] ?? false,
      }
    })
  })
  const spacers = createMemo<{ readonly top: number; readonly bottom: number }>(() => {
    const projection = props.projection()
    const index = props.heightIndexRecord().index
    index.extentVersion()
    const mountedRows = rows()
    const first = mountedRows[0]?.absoluteIndex
    const last = mountedRows.at(-1)?.absoluteIndex
    if (first === undefined || last === undefined) return { top: 0, bottom: 0 }
    const totalRows = projectedTotalRows(index, projection.zeroHeightBlockIndices)
    return { top: index.blockIndexToRowOffset(first), bottom: Math.max(0, totalRows - index.blockIndexToRowOffset(last + 1)) }
  }, { top: 0, bottom: 0 }, { equals: (a, b) => a.top === b.top && a.bottom === b.bottom })

  // The projector returns the same indices array while its items are
  // unchanged, so this memo lets a streaming flush pass without re-recording.
  const zeroHeightBlockIndices = createMemo(() => props.projection().zeroHeightBlockIndices)
  createEffect(() => {
    const indices = zeroHeightBlockIndices()
    if (indices.length === 0) return
    const index = props.heightIndexRecord().index
    queueMicrotask(() => recordZeroHeightBlocks(index, indices))
  })

  // The top spacer is always mounted and spans the full row width, so it is
  // the one reporter for the shared row-width channel: blocks seed their wrap
  // widths from it and render final shapes on their first layout.
  const rowWidth = useRowWidth()
  return (
    <MutationEvidenceProvider reader={() => props.transcript.mutationEvidence()}>
      <box
        height={spacers().top}
        width="100%"
        selectable={false}
        onSizeChange={function (this: BoxRenderable) {
          if (Number.isFinite(this.width) && this.width > 0) rowWidth.report(this.width)
        }}
      />
      <Key each={rows()} by="id">
        {(row) => (
          <RowMount
            block={() => row().block}
            absoluteIndex={() => row().absoluteIndex}
            hasBoundaryBefore={() => row().hasBoundaryBefore}
            settled={() => {
              // Streaming appends only ever target the last block of the
              // transcript, whatever read the window descends from: a tail
              // read carries a consistency token too, so the window's source
              // never tells a growing reply from history. Everything else is
              // settled and takes the cached lex. A wrong `false` (a last block
              // that never grows again) only costs the lexer cache, never
              // correctness.
              const snap = props.snapshot()
              return !snap || row().absoluteIndex < snap.totalBlocks - 1
            }}
            historical={() => row().absoluteIndex <= (props.snapshot()?.historicalThroughIndex ?? -1)}
            heightIndex={() => props.heightIndexRecord().index}
            transcript={props.transcript}
            showThinking={props.showThinking}
            streamingToolText={props.streamingToolText}
            diffColors={props.diffColors}
            registerRow={props.registerRow}
            reportAfterLayout={reportAfterLayout}
            trackChurn={trackChurn}
            processControls={props.processControls}
            roleView={props.roleView}
            childStatus={props.childStatus}
          />
        )}
      </Key>
      <box height={spacers().bottom} width="100%" selectable={false} />
    </MutationEvidenceProvider>
  )
}

interface RowDescriptor {
  readonly id: string
  readonly block: PresentedTerminalRow
  readonly absoluteIndex: number
  readonly hasBoundaryBefore: boolean
}

/** Bucketing for the mounted range: scrolls inside a bucket keep the exact same
 *  range, so the descriptor memo (and Solid reconciliation) stays untouched for
 *  ~RANGE_QUANT_ROWS of travel. Rounding always widens outward, so effective
 *  overscan is OVERSCAN_ROWS..OVERSCAN_ROWS+RANGE_QUANT_ROWS. */
const RANGE_QUANT_ROWS = 32

function mountedProjectionRange(indices: readonly number[], index: HeightIndex, viewport: { readonly scrollTop: number; readonly viewportRows: number }) {
  const topRow = Math.max(0, Math.floor((viewport.scrollTop - OVERSCAN_ROWS) / RANGE_QUANT_ROWS) * RANGE_QUANT_ROWS)
  const bottomRow = Math.max(topRow, Math.ceil((viewport.scrollTop + Math.max(1, viewport.viewportRows) + OVERSCAN_ROWS) / RANGE_QUANT_ROWS) * RANGE_QUANT_ROWS)
  const firstBlock = index.rowOffsetToBlockIndex(topRow)
  const lastBlock = index.rowOffsetToBlockIndex(bottomRow)
  const start = clamp(lowerBound(indices, firstBlock), 0, Math.max(0, indices.length - 1))
  const end = clamp(Math.max(start + 1, upperBound(indices, lastBlock)), start + 1, indices.length)
  return { start, end }
}

/** The blocks the viewport itself needs this frame, with one quant bucket of
 *  margin to absorb leading intro rows and estimate error. This range mounts
 *  synchronously regardless of the mount budget - the no-blank-rows floor. */
function viewportRange(indices: readonly number[], index: HeightIndex, viewport: { readonly scrollTop: number; readonly viewportRows: number }) {
  const topRow = Math.max(0, viewport.scrollTop - RANGE_QUANT_ROWS)
  const bottomRow = viewport.scrollTop + Math.max(1, viewport.viewportRows) + RANGE_QUANT_ROWS
  const firstBlock = index.rowOffsetToBlockIndex(topRow)
  const lastBlock = index.rowOffsetToBlockIndex(bottomRow)
  const start = clamp(lowerBound(indices, firstBlock), 0, Math.max(0, indices.length - 1))
  const end = clamp(Math.max(start + 1, upperBound(indices, lastBlock)), start + 1, indices.length)
  return { start, end }
}

interface WidenTowardsInput {
  readonly prev: { readonly start: number; readonly end: number } | undefined
  readonly goal: { readonly start: number; readonly end: number }
  readonly must: { readonly start: number; readonly end: number }
  readonly budget: number
  readonly upFirst: boolean
}

/** One budgeted step from `prev` toward `goal`. Shrinks (edges past the goal)
 *  apply immediately: dropping rows is cheap and keeps residency bounded.
 *  Growth spends at most `budget` new blocks, the edge in the scroll direction
 *  first. The result always covers `must`, whatever the budget - viewport
 *  coverage is never deferred. With no prior range, or after a jump that left
 *  the previous range disjoint from the goal, growth restarts from the
 *  viewport cover itself, so even the first emission spends only one budget
 *  beyond the viewport.
 *  Exported for direct unit testing. */
export function widenTowards(input: WidenTowardsInput): { readonly start: number; readonly end: number } {
  const { goal, must, budget, upFirst } = input
  const cover = (r: { start: number; end: number }) => ({ start: Math.min(r.start, must.start), end: Math.max(r.end, must.end) })
  const prev = input.prev ?? must
  let start = Math.max(prev.start, goal.start)
  let end = Math.min(prev.end, goal.end)
  if (end <= start) {
    // Disjoint jump: restart growth from the viewport cover clamped into the goal.
    start = Math.max(goal.start, Math.min(must.start, goal.end - 1))
    end = Math.min(goal.end, Math.max(must.end, goal.start + 1))
  }
  let remaining = budget
  const growUp = () => {
    const spend = Math.min(remaining, start - goal.start)
    start -= spend
    remaining -= spend
  }
  const growDown = () => {
    const spend = Math.min(remaining, goal.end - end)
    end += spend
    remaining -= spend
  }
  if (upFirst) { growUp(); growDown() } else { growDown(); growUp() }
  return cover({ start, end })
}

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((values[mid] ?? 0) < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(values: readonly number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((values[mid] ?? 0) <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

interface RowMountProps {
  block: Accessor<PresentedTerminalRow>
  absoluteIndex: Accessor<number>
  hasBoundaryBefore: Accessor<boolean>
  settled: Accessor<boolean>
  heightIndex: Accessor<HeightIndex>
  transcript: OutputTranscriptView
  showThinking?: boolean
  streamingToolText?: StreamingToolTextById
  diffColors?: Accessor<DiffColorMode>
  historical: Accessor<boolean>
  registerRow: MountedRowRegistry["register"]
  /** Runs the report after the next laid-out frame; cancelled with the caller's owner. */
  reportAfterLayout: (report: () => void) => void
  /** Starts watching this mount for unmounting without a height report. */
  trackChurn: (blockIndex: number) => RowChurnHandle
  processControls?: RowProcessControls
  roleView?: (sessionId: string) => RoleAssignmentView | undefined
  childStatus?: (sessionId: string) => ChildCardStatus
}

/** One hydrated row. Reports its laid-out height into the height index (via
 *  reportMeasured, so a layout pass measuring many rows coalesces into one extent
 *  bump) so variable-height blocks refine the spacer math. OpenTUI calls the
 *  size callback on the first layout and on every size change. The controller
 *  flushes after the frame's first row layout; later layout rounds queue
 *  reports for the next frame decision. A row that moves to another index position,
 *  or into a new height index, keeps its size and reports it again. Demotion
 *  restores unchanged mounted sizes synchronously through the row registry.
 *  Content that holds the row's geometry (see RowGeometryChannel) defers the
 *  measurement until it settles, so the eager pass keeps the row mounted and
 *  records its final height instead of an interim one. Until then the row
 *  reports its interim height as an estimate. */
function RowMount(props: RowMountProps) {
  const heightIndex = createMemo(() => props.heightIndex())
  const absoluteIndex = createMemo(() => props.absoluteIndex())
  const [holds, setHolds] = createSignal<readonly Accessor<boolean>[]>([])
  const geometrySettled = createMemo(() => holds().every(settled => settled()))
  // The mount, not the row's later index, is what the churn record counts.
  const churn = untrack(() => props.trackChurn(absoluteIndex()))
  // Whether content held this mount's geometry, for the churn record: the
  // holds release before the row's own cleanup runs.
  let held = false
  const geometry: RowGeometryChannel = {
    hold(settled) {
      held = true
      setHolds(previous => [...previous, settled])
      onCleanup(() => setHolds(previous => previous.filter(hold => hold !== settled)))
    },
  }
  // The one authority for how this row's height reaches the index: its own size
  // reports and the registry's report-all pass (width change, demotion, land) both call it.
  const record = (index: HeightIndex, height: number): void => {
    // OpenTUI reports height=NaN while a row is between layouts (a window
    // splice re-lays-out every mounted row). That is "no measurement yet", not
    // a measurement: Math.max does not clamp NaN, and one NaN extent poisons
    // every prefix sum in the height index (blank transcript, NaN scroll
    // anchors). The row reports again once laid out.
    if (!Number.isFinite(height)) return
    // A zero-height layout still reports as one row so an empty-rendering
    // block cannot prevent the fullyMeasured latch from enabling virtualization.
    const rows = Math.max(1, height)
    // Native layout already places held content at its interim height, and the
    // controller and the mounted range read offsets through the index. The
    // estimate keeps the two in step; the measurement waits for the final height.
    if (untrack(geometrySettled)) index.reportMeasured(props.absoluteIndex(), rows)
    else index.reportEstimated(props.absoluteIndex(), rows)
    churn.reported()
  }
  const report = (row: BoxRenderable) => record(props.heightIndex(), row.height)
  return (
    <box
      ref={(el: BoxRenderable) => {
        onCleanup(props.registerRow(el, props.absoluteIndex, record))
        onCleanup(() => churn.unmounted(() => untrack(() => {
          const index = heightIndex()
          const blockIndex = absoluteIndex()
          return {
            kind: props.block().kind,
            holdReason: held ? "geometry" : Number.isFinite(el.height) ? "none" : "no-layout",
            nativeRows: Number.isFinite(el.height) ? el.height : undefined,
            indexRows: index.blockIndexToRowOffset(blockIndex + 1) - index.blockIndexToRowOffset(blockIndex),
          }
        })))
        createEffect(on([heightIndex, absoluteIndex], () => report(el), { defer: true }))
        // Settled content can keep the interim size, which calls no size callback. The
        // first frame laid out after the hold ends records the final height.
        createEffect(on(geometrySettled, (settled) => {
          // oxlint-disable-next-line solid/reactivity -- the report reads the row's index when the frame drains, not when it is queued
          if (settled) props.reportAfterLayout(() => report(el))
        }, { defer: true }))
      }}
      width="100%"
      flexDirection="column"
      onSizeChange={function (this: BoxRenderable) { report(this) }}
    >
      <Show when={props.hasBoundaryBefore()}>
        <Divider />
      </Show>
      <RowGeometryProvider value={geometry}>
        <BlockRenderer
          block={props.block()}
          showThinking={props.showThinking}
          diffColors={props.diffColors}
          settled={props.settled()}
          streamingToolText={props.streamingToolText}
          historical={props.historical()}
          onHydrateBody={(blockId) => props.transcript.hydrateBlockBody(blockId)}
          processControls={props.processControls}
          roleView={props.roleView}
          childStatus={props.childStatus}
        />
      </RowGeometryProvider>
    </box>
  )
}
