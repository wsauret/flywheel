/**
 * Default-on records of the transcript scroll states that must not happen:
 * the reading position moving against the person's input, the content extent
 * swinging back and forth between frames, and a row that mounts and unmounts
 * again and again without its height reaching the height index. Steady-state
 * scrolling writes nothing. The first occurrence of a condition records its
 * evidence at INFO; repeats coalesce into a count every REPEAT_WINDOW_MS while
 * the condition lasts, and one closing record gives the total count and the
 * duration when it ends (ARCH-RUNTIME-076, ARCH-RUNTIME-077). The records hold
 * positions, sizes, and kinds only, never transcript content.
 *
 * The per-change scroll telemetry in output-window-scroll-diagnostics.ts stays
 * behind FLYWHEEL_RENDER_DEBUG: it writes a record per frame.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { DebugLog } from "../../infra/debug-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import type { MountedRowRegistry, TranscriptHeightIndexRecord, TranscriptScrollState } from "./output-window-scroll.js"

/** Frames without the condition that end an episode. */
const QUIET_FRAMES = 30
/** A condition that keeps recurring reports its count at most this often. */
const REPEAT_WINDOW_MS = 10_000
/** Mounts that end without a height report before a row records. One
 *  scroll-away unmount is ordinary; the same row churning is a fight between
 *  the mounted range and the extent it produces. */
const CHURN_UNMOUNTS = 3

interface Fields { readonly [key: string]: unknown }

interface EpisodeRecordTypes { readonly detected: string; readonly repeated: string; readonly ended: string }

interface EpisodeRecorder {
  /** One occurrence of the condition `key` names. The first one of an episode
   *  records `identity` with `evidence()`; later ones only count. */
  observe(key: string, identity: Fields, evidence: () => Fields): void
  /** The episode of `key`, or every open episode, ended: records its total
   *  count and its duration once. */
  end(key?: string): void
}

/** Episodes of one record family. The coalescer reports the repeats of a long
 *  episode every REPEAT_WINDOW_MS; the recorder owns the detection and the one
 *  closing record, so an episode of a single occurrence closes too. */
function createEpisodeRecorder(types: EpisodeRecordTypes, sessionId: string | undefined): EpisodeRecorder {
  const write = (type: string, payload: Fields) => DebugLog.record({ type, payload, ...(sessionId === undefined ? {} : { sessionId }) })
  const open = new Map<string, { readonly identity: Fields; readonly startedAt: number; occurrences: number }>()
  // The closing record carries the total, so the window that an end closes
  // writes no repeat count of its own.
  let ending = false
  const repeats = coalesceRepeats<null>({
    windowMs: REPEAT_WINDOW_MS,
    first: () => {},
    repeated: (key, { count, windowMs }) => {
      if (!ending) write(types.repeated, { ...open.get(key)?.identity, count, durationMs: windowMs })
    },
  })
  return {
    observe(key, identity, evidence) {
      const episode = open.get(key)
      if (episode === undefined) {
        open.set(key, { identity, startedAt: Date.now(), occurrences: 1 })
        write(types.detected, { ...identity, ...evidence() })
      } else {
        episode.occurrences += 1
      }
      repeats.observe(key, null)
    },
    end(key) {
      ending = true
      repeats.end(key)
      ending = false
      // Deleting the entry being visited is safe while iterating a Map.
      for (const [openKey, episode] of open) {
        if (key !== undefined && key !== openKey) continue
        open.delete(openKey)
        write(types.ended, { ...episode.identity, count: episode.occurrences, durationMs: Date.now() - episode.startedAt })
      }
    },
  }
}

type ScrollFightKind = "reading-against-input" | "extent-oscillation"

/** One frame decision of the scroll controller, as the monitor compares it
 *  with the previous one. */
interface ScrollFrameSample {
  readonly input: -1 | 0 | 1
  readonly repositioned: boolean
  readonly scrollTop: number
  /** The anchor block and the row within it; undefined outside the window or at the tail. */
  readonly anchorBlock: number | undefined
  readonly anchorRow: number
  /** The viewport width when the controller captured the anchor: a row within
   *  a block counts at one width only. */
  readonly anchorWidth: number
  readonly extent: number
  /** What the extent legitimately follows: content, generation, and width. */
  readonly generation: number
  readonly totalBlocks: number
  readonly estimatedRows: number
  readonly viewportWidth: number
}

/** The controller state the monitor reads for its evidence, only when it records. */
export interface ScrollFightSource {
  readonly state: TranscriptScrollState
  readonly heightIndexRecord: () => TranscriptHeightIndexRecord
  readonly leadingRows: () => number
  /** Scroll-content rows outside the height index: the leading rows and the pending spacer. */
  readonly unindexedRows: () => number
  readonly mountedRows: MountedRowRegistry | undefined
  /** Whether this frame's decision resolved the reading position on mounted text. */
  readonly textResolved: () => boolean
  /** The source of the last write that moved scrollTop. */
  readonly writeSource: () => string
}

/** What one frame decision did, beside the state the controller owns. */
interface ScrollFrameDecision {
  /** The direction of the person's input since the previous decision: -1 up, 1 down, 0 none. */
  readonly input: -1 | 0 | 1
  /** The controller placed the reading position itself since the previous
   *  decision (a landing, a handed-on place, a remapped generation), so its
   *  move answers no scroll direction. */
  readonly repositioned: boolean
  /** Tail follow keeps no reading anchor current, so a tail frame compares with nothing. */
  readonly tailing: boolean
  /** The native content extent this frame decided on. */
  readonly extent: number
}

export interface ScrollFightMonitor {
  frame(e: ScrollBoxRenderable, snap: TranscriptSnapshot, decision: ScrollFrameDecision): void
  /** Reports the open counts; the owner calls it when it unmounts. */
  close(): void
}

/** Watches the frame decisions of one mounted scroll controller of `sessionId`,
 *  which the records name so a session-filtered search finds them. The evidence
 *  is read only when a record is written, so a frame costs a few comparisons. */
export function createScrollFightMonitor(sessionId: string | undefined, source: ScrollFightSource): ScrollFightMonitor {
  let direction: -1 | 0 | 1 = 0
  let previous: ScrollFrameSample | undefined
  let extentBefore = Number.NaN
  let element: ScrollBoxRenderable | undefined
  // The controller replaces the anchor at each capture and keeps it through a
  // reflow, so the width at which an anchor first appears is its width.
  let anchorSeen: TranscriptScrollState["anchor"]
  let anchorWidth = Number.NaN
  const evidence = (): Fields => {
    const { state } = source
    const record = source.heightIndexRecord()
    const indexRows = record.index.totalRows()
    const nativeExtent = element?.scrollHeight ?? Number.NaN
    const unindexedRows = source.unindexedRows()
    return {
      scrollTop: element?.scrollTop,
      previousScrollTop: previous?.scrollTop,
      offset: state.offset,
      viewportRows: element?.viewport.height,
      nativeExtent,
      indexRows,
      leadingRows: source.leadingRows(),
      unindexedRows,
      // Native rows that neither the index nor the unindexed rows account for.
      unaccountedRows: nativeExtent - indexRows - unindexedRows,
      mountedRange: source.mountedRows?.mountedRange(),
      anchorKind: state.anchor?.kind,
      anchorBlock: state.anchor?.blockIndex,
      anchorRow: state.anchor?.kind === "block" ? state.anchor.rowOffsetWithinBlock : undefined,
      textAnchored: state.textPosition !== undefined,
      textResolved: source.textResolved(),
      generation: state.generation,
      eagerCompleted: record.eagerCompleted,
      writeSource: source.writeSource(),
    }
  }
  const quiet = new Map<ScrollFightKind, number>()
  const episodes = createEpisodeRecorder({ detected: "tui.scroll.fight.detected", repeated: "tui.scroll.fight.repeated", ended: "tui.scroll.fight.ended" }, sessionId)

  const note = (kind: ScrollFightKind, hit: boolean, fields: () => Fields): void => {
    const frames = quiet.get(kind)
    if (hit) {
      quiet.set(kind, 0)
      episodes.observe(kind, { kind }, () => ({ ...fields(), ...evidence() }))
      return
    }
    if (frames === undefined) return
    if (frames + 1 < QUIET_FRAMES) {
      quiet.set(kind, frames + 1)
      return
    }
    quiet.delete(kind)
    episodes.end(kind)
  }

  return {
    frame(e, snap, decision) {
      element = e
      if (source.state.anchor !== anchorSeen) {
        anchorSeen = source.state.anchor
        anchorWidth = e.viewport.width
      }
      const anchor = decision.tailing ? undefined : source.state.anchor
      const sample: ScrollFrameSample = {
        input: decision.input,
        repositioned: decision.repositioned,
        scrollTop: e.scrollTop,
        anchorBlock: anchor?.kind === "block" ? anchor.blockIndex : undefined,
        anchorRow: anchor?.kind === "block" ? anchor.rowOffsetWithinBlock : 0,
        anchorWidth,
        extent: decision.extent,
        generation: snap.generation,
        totalBlocks: snap.totalBlocks,
        estimatedRows: snap.window.estimatedRows,
        viewportWidth: e.viewport.width,
      }
      if (sample.input !== 0) direction = sample.input
      const prior = previous
      const comparable = prior !== undefined && !sample.repositioned && prior.generation === sample.generation
      let moved = 0
      if (comparable && sample.anchorBlock !== undefined && prior.anchorBlock !== undefined && sample.anchorWidth === prior.anchorWidth) {
        moved = Math.sign(sample.anchorBlock - prior.anchorBlock) || Math.sign(sample.anchorRow - prior.anchorRow)
      }
      note("reading-against-input", direction !== 0 && moved === -direction, () => ({
        direction,
        input: sample.input,
        previousAnchorBlock: prior?.anchorBlock,
        previousAnchorRow: prior?.anchorRow,
      }))
      // The extent returns to the value of two frames ago, while nothing it
      // follows changed and no input arrived: something mounts and unmounts.
      const unchanged = comparable && prior.totalBlocks === sample.totalBlocks && prior.estimatedRows === sample.estimatedRows && prior.viewportWidth === sample.viewportWidth
      const oscillated = unchanged && sample.input === 0 && sample.extent === extentBefore && sample.extent !== prior.extent
      note("extent-oscillation", oscillated, () => ({ extents: [extentBefore, prior?.extent, sample.extent] }))
      extentBefore = unchanged ? (prior?.extent ?? Number.NaN) : Number.NaN
      previous = sample
    },
    close() {
      quiet.clear()
      episodes.end()
    },
  }
}

export interface RowChurnMonitor {
  /** A row of `blockIndex` mounted. Returns the row's handle. */
  mounted(blockIndex: number, generation: number): RowChurnHandle
  close(): void
}

export interface RowChurnHandle {
  /** The row's laid-out height reached the height index. */
  reported(): void
  /** The row unmounted; `evidence` describes it as it goes. */
  unmounted(evidence: () => Fields): void
}

/** Watches the rows one transcript viewport of `sessionId` mounts. A row of a
 *  block and generation that unmounts CHURN_UNMOUNTS times without a height
 *  report records once; a later report, a new generation, or the viewport
 *  closing ends its episode. Bookkeeping is per mount and unmount, never per frame. */
export function createRowChurnMonitor(sessionId: string | undefined): RowChurnMonitor {
  // Unmounts without a report, per block of the current generation. A
  // report clears the block, and a new generation clears them all.
  const unreported = new Map<number, number>()
  let generation: number | undefined
  const key = (blockIndex: number) => `${generation}:${blockIndex}`
  const episodes = createEpisodeRecorder({ detected: "tui.row.mount_churn.detected", repeated: "tui.row.mount_churn.repeated", ended: "tui.row.mount_churn.ended" }, sessionId)
  return {
    mounted(blockIndex, rowGeneration) {
      if (rowGeneration !== generation) {
        episodes.end()
        unreported.clear()
        generation = rowGeneration
      }
      let reported = false
      return {
        reported() {
          if (reported) return
          reported = true
          if (unreported.delete(blockIndex)) episodes.end(key(blockIndex))
        },
        unmounted(evidence) {
          if (reported || rowGeneration !== generation) return
          const unmounts = (unreported.get(blockIndex) ?? 0) + 1
          unreported.set(blockIndex, unmounts)
          if (unmounts >= CHURN_UNMOUNTS) episodes.observe(key(blockIndex), { blockIndex, generation }, () => ({ unmounts, ...evidence() }))
        },
      }
    },
    close() {
      unreported.clear()
      episodes.end()
    },
  }
}
