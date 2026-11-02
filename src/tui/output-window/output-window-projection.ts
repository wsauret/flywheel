import type { FrontendOutputBlock } from "../../protocol/app-service-types.js"
import { closesToolStretch, type TranscriptRow } from "../../protocol/client/transcript-model.js"
import type { TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { terminalTranscript, type PresentedTerminalRow, type TerminalTranscript } from "../output-blocks/visible-output-blocks.js"

/** Every render transform OutputWindow needs, computed in one O(window) pass over
 *  the hydrated window's blocks: the shared transcript fold decides the rows and
 *  the terminal presentation splits each stretch of tool work into runs. The
 *  cache owns only navigation metadata, so grouping, pending, and divider
 *  derivation happens here, scoped to the window, and a slice is
 *  seeded with its predecessor so it projects identically to the full
 *  transcript. */
export interface TranscriptWindowProjection {
  /** The grouped, visible blocks of the window (tool runs collapsed, hidden
   *  thinking filtered). The rows OutputWindow mounts. */
  readonly timelineBlocks: readonly PresentedTerminalRow[]
  /** Parallel boolean[] of implicit dividers before each timeline row,
   *  precomputed once (O(window)) so <Index> children read flags[i] not a per-row
   *  scan. */
  readonly hasBoundaryBefore: readonly boolean[]
  /** Absolute source block index for each mounted timeline row. Grouped tools and
   *  hidden thinking mean this is not equivalent to window.start + rowIndex. */
  readonly timelineBlockIndices: readonly number[]
  /** Source blocks represented by no mounted row in this projection. The height
   *  index records them as zero rows so spacer math tracks rendered output. */
  readonly zeroHeightBlockIndices: readonly number[]
  /** Pending (queued) user messages, pinned as an overlay below the timeline. */
  readonly pendingBlocks: TerminalTranscript["pendingBlocks"]
}

/** Resolve an entry to the mounted row that represents it. Tool-run children
 * share their grouped row's absolute source index. */
export function targetTimelineBlockIndex(
  projection: TranscriptWindowProjection,
  entryId: string,
): number | undefined {
  const rowIndex = projection.timelineBlocks.findIndex((block) => {
    if (block.kind === "toolRun") return block.children.some((child) => child.id === entryId)
    if (block.kind === "tool") return block.id === entryId
    if (block.kind === "agentGroup") return block.id === entryId || block.toolUseId === entryId
    if (block.kind === "question") return block.toolUseId === entryId
    return false
  })
  return rowIndex < 0 ? undefined : projection.timelineBlockIndices[rowIndex]
}

const EMPTY: TranscriptWindowProjection = {
  timelineBlocks: [],
  hasBoundaryBefore: [],
  timelineBlockIndices: [],
  zeroHeightBlockIndices: [],
  pendingBlocks: [],
}

/** The composable unit: fold and present ONE contiguous slice of the window.
 *  `sliceStart` is the slice's offset inside the window's block list; the
 *  predecessor block and row seed the shared fold exactly as a whole-window
 *  pass would have seen them, so a prefix projection
 *  concatenated with a suffix projection equals the whole-window projection
 *  whenever the seam never splits a stretch of tool work. */
interface SliceProjection {
  readonly timelineBlocks: PresentedTerminalRow[]
  readonly hasBoundaryBefore: boolean[]
  readonly timelineBlockIndices: number[]
  readonly zeroHeightBlockIndices: number[]
  readonly pendingBlocks: (PresentedTerminalRow & { kind: "userMessage" })[]
  /** The last row the fold produced: the boundary predecessor of the next slice. */
  lastRow: TranscriptRow | null
}

function projectSlice(
  blocks: readonly FrontendOutputBlock[],
  sliceStart: number,
  sliceEnd: number,
  windowStart: number,
  showThinking: boolean | undefined,
  predecessorBlock: FrontendOutputBlock | null,
  predecessorRow: TranscriptRow | null,
): SliceProjection {
  const terminal = terminalTranscript(blocks.slice(sliceStart, sliceEnd), showThinking, { startBlockIndex: windowStart + sliceStart, predecessorBlock, predecessorRow })
  const { model } = terminal
  return {
    timelineBlocks: [...terminal.timelineBlocks],
    hasBoundaryBefore: [...terminal.hasBoundaryBefore],
    timelineBlockIndices: [...terminal.timelineBlockIndices],
    // Sorted per slice: slices cover disjoint ascending ranges, so slice-wise
    // concatenation stays globally sorted and prefix+suffix equals one pass.
    zeroHeightBlockIndices: [...terminal.zeroHeightBlockIndices],
    pendingBlocks: [...terminal.pendingBlocks],
    lastRow: model.rows.at(-1) ?? predecessorRow,
  }
}

/** The settled prefix ends after the SECOND-to-last block that closes a stretch
 *  of tool work: the last one can still be a streaming block (its replacement
 *  would only invalidate the cache), and everything after it - the open stretch
 *  and the live tail - is volatile by definition. Thoughts never close a
 *  stretch, so the seam never falls on one. */
function settledPrefixLength(blocks: readonly FrontendOutputBlock[]): number {
  let terminators = 0
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    // SAFETY: i ranges in [0, blocks.length).
    if (!closesToolStretch(blocks[i]!)) continue
    terminators += 1
    if (terminators === 2) return i + 1
  }
  return 0
}

/** Cache the settled prefix's projection and extend it while each 16ms flush
 *  re-projects only the volatile suffix. Validity requires the same showThinking
 *  value, window origin, and seedEpoch (seed reconciliation can mutate blocks
 *  under stable identities), plus pointer identity for every prefix block. Any
 *  mismatch pays one whole-window projection. */
export function createTranscriptWindowProjector(): (snapshot: TranscriptSnapshot | undefined, showThinking: boolean | undefined) => TranscriptWindowProjection {
  let cached: {
    showThinking: boolean | undefined
    windowStart: number
    seedEpoch: number
    prefixBlocks: FrontendOutputBlock[]
    prefix: SliceProjection
  } | null = null
  // Consumers key caches and Solid memos on each array's identity, so a flush
  // that changes only a streaming block's text must hand back the previous
  // arrays for every field whose items did not change. The prefix epoch counts
  // rebuilds: an extended prefix changes its length, a rebuilt one its epoch.
  let prefixEpoch = 0
  let last: { prefixEpoch: number; prefixLength: number; suffix: SliceProjection; result: TranscriptWindowProjection } | null = null

  const prefixValid = (blocks: readonly FrontendOutputBlock[], windowStart: number, seedEpoch: number, showThinking: boolean | undefined): boolean => {
    if (!cached) return false
    if (cached.showThinking !== showThinking || cached.windowStart !== windowStart || cached.seedEpoch !== seedEpoch) return false
    if (cached.prefixBlocks.length > blocks.length) return false
    for (let i = 0; i < cached.prefixBlocks.length; i += 1) if (blocks[i] !== cached.prefixBlocks[i]) return false
    return true
  }

  return (snapshot, showThinking) => {
    if (!snapshot) { cached = null; last = null; return EMPTY }
    const blocks: readonly FrontendOutputBlock[] = snapshot.blocks
    const windowStart = snapshot.window.startBlockIndex ?? 0
    const boundary = settledPrefixLength(blocks)

    if (!prefixValid(blocks, windowStart, snapshot.seedEpoch, showThinking)) {
      prefixEpoch += 1
      cached = boundary > 0
        ? {
          showThinking,
          windowStart,
          seedEpoch: snapshot.seedEpoch,
          prefixBlocks: blocks.slice(0, boundary),
          prefix: projectSlice(blocks, 0, boundary, windowStart, showThinking, null, null),
        }
        : null
    } else if (cached && boundary > cached.prefixBlocks.length) {
      const from = cached.prefixBlocks.length
      const extension = projectSlice(blocks, from, boundary, windowStart, showThinking, blocks[from - 1] ?? null, cached.prefix.lastRow)
      cached.prefix.timelineBlocks.push(...extension.timelineBlocks)
      cached.prefix.hasBoundaryBefore.push(...extension.hasBoundaryBefore)
      cached.prefix.timelineBlockIndices.push(...extension.timelineBlockIndices)
      cached.prefix.zeroHeightBlockIndices.push(...extension.zeroHeightBlockIndices)
      cached.prefix.pendingBlocks.push(...extension.pendingBlocks)
      cached.prefix.lastRow = extension.lastRow
      cached.prefixBlocks.push(...blocks.slice(from, boundary))
    }

    const prefix = cached?.prefix
    const from = cached?.prefixBlocks.length ?? 0
    const suffix = projectSlice(blocks, from, blocks.length, windowStart, showThinking, blocks[from - 1] ?? null, prefix?.lastRow ?? null)
    const previous = last !== null && last.prefixEpoch === prefixEpoch && last.prefixLength === from ? last : null
    const field = <K extends keyof TranscriptWindowProjection>(key: K): TranscriptWindowProjection[K] => {
      if (previous && sameItems(previous.suffix[key], suffix[key])) return previous.result[key]
      // SAFETY: both records hold arrays of the same element type under the same key; TypeScript cannot carry that through a generic key into the spread.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic field concatenation over parallel record types
      return (prefix ? [...prefix[key], ...suffix[key]] : suffix[key]) as TranscriptWindowProjection[K]
    }
    const result: TranscriptWindowProjection = {
      timelineBlocks: field("timelineBlocks"),
      hasBoundaryBefore: field("hasBoundaryBefore"),
      timelineBlockIndices: field("timelineBlockIndices"),
      zeroHeightBlockIndices: field("zeroHeightBlockIndices"),
      pendingBlocks: field("pendingBlocks"),
    }
    last = { prefixEpoch, prefixLength: from, suffix, result }
    return result
  }
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
