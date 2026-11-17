import { gatherCallStretches, turnFoldSummary, type CallStretch, type CallStretchPresentation } from "../../protocol/client/turn-folds.js"
import type { PresentedTerminalRow, TimelineRow } from "../output-blocks/visible-output-blocks.js"
import type { TranscriptWindowProjection } from "./output-window-projection.js"

type HeadingRow = Extract<TimelineRow, { readonly kind: "callStretch" }>

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** Presents one session's projected window as its module asks (PI-LEAD-017): the calls that `presentation` hides are
 *  rows of no height, and each stretch of calls gathers through the shared rule into one mounted row that holds its
 *  heading and, while it is open, its rows beneath. The heading row takes the place of the first row of its stretch,
 *  and every other row of the stretch measures as no height, so the window's height index stays one row per source
 *  block.
 *
 *  A frame that changes nothing hands back the arrays of the previous frame, as the window projector does. */
export function createCallStretchProjector(presentation: CallStretchPresentation) {
  const runs = new WeakMap<PresentedTerminalRow, PresentedTerminalRow>()
  const headings = new Map<string, HeadingRow>()
  let last: TranscriptWindowProjection | undefined

  /** The row without its hidden calls; undefined when nothing of it shows. */
  const shown = (row: TimelineRow): PresentedTerminalRow | undefined => {
    if (row.kind === "callStretch") throw new Error("a window projection holds no call stretches")
    if (row.kind === "tool") return presentation.hidden.has(row.name) ? undefined : row
    if (row.kind !== "toolRun") return row
    const children = row.children.filter((child) => !presentation.hidden.has(child.name))
    if (children.length === row.children.length) return row
    if (children.length === 0) return undefined
    const cached = runs.get(row)
    if (cached?.kind === "toolRun" && sameItems(cached.children, children)) return cached
    // The run starts where its first shown call starts, so its time never comes from bookkeeping. It keeps its id,
    // which names its stretch and must hold as the run grows.
    // SAFETY: children holds at least one call, checked above.
    const run = { ...row, children, timestamp: children[0]!.timestamp }
    runs.set(row, run)
    return run
  }

  const heading = (stretch: CallStretch<PresentedTerminalRow>): HeadingRow => {
    const { label, failed } = turnFoldSummary(stretch, undefined, presentation.phrases)
    const cached = headings.get(stretch.id)
    if (cached && cached.open === stretch.open && cached.timestamp === stretch.timestamp && cached.label === label && cached.failed === failed && sameItems(cached.rows, stretch.rows)) return cached
    // SAFETY: the marker records admission through this presenter and adds no runtime fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: only presentation admits rows to the renderer.
    const row = { kind: "callStretch", id: stretch.id, open: stretch.open, timestamp: stretch.timestamp, label, failed, rows: stretch.rows } as HeadingRow
    headings.set(stretch.id, row)
    return row
  }

  return (projection: TranscriptWindowProjection, running: boolean, choice: (id: string) => boolean | undefined): TranscriptWindowProjection => {
    const rows: PresentedTerminalRow[] = []
    const boundaries: boolean[] = []
    const indexOf = new Map<PresentedTerminalRow, number>()
    const zeroHeight = [...projection.zeroHeightBlockIndices]
    for (const [i, row] of projection.timelineBlocks.entries()) {
      // SAFETY: the projection's arrays are parallel by construction.
      const index = projection.timelineBlockIndices[i]!
      const visible = shown(row)
      if (visible === undefined) { zeroHeight.push(index); continue }
      const boundary = projection.hasBoundaryBefore[i] ?? false
      rows.push(visible)
      boundaries.push(boundary)
      indexOf.set(visible, index)
    }
    const gathered = gatherCallStretches({ rows, boundaryBefore: boundaries }, running, choice)
    const timelineBlocks: TimelineRow[] = []
    const hasBoundaryBefore: boolean[] = []
    const timelineBlockIndices: number[] = []
    for (const row of gathered.rows) {
      // The headings already part the lead's words from its calls, so no divider repeats that (PI-LEAD-017).
      hasBoundaryBefore.push(false)
      if (row.kind !== "callStretch") {
        timelineBlocks.push(row)
        // SAFETY: every row the rule passes on came from the input rows, each indexed above.
        timelineBlockIndices.push(indexOf.get(row)!)
        continue
      }
      timelineBlocks.push(heading(row))
      // SAFETY: a stretch holds input rows only, each indexed above.
      const indices = row.rows.map((member) => indexOf.get(member)!)
      // SAFETY: a stretch holds at least one row.
      timelineBlockIndices.push(indices[0]!)
      zeroHeight.push(...indices.slice(1))
    }
    zeroHeight.sort((a, b) => a - b)
    const previous = last
    const result: TranscriptWindowProjection = {
      timelineBlocks: previous && sameItems(previous.timelineBlocks, timelineBlocks) ? previous.timelineBlocks : timelineBlocks,
      hasBoundaryBefore: previous && sameItems(previous.hasBoundaryBefore, hasBoundaryBefore) ? previous.hasBoundaryBefore : hasBoundaryBefore,
      timelineBlockIndices: previous && sameItems(previous.timelineBlockIndices, timelineBlockIndices) ? previous.timelineBlockIndices : timelineBlockIndices,
      zeroHeightBlockIndices: previous && sameItems(previous.zeroHeightBlockIndices, zeroHeight) ? previous.zeroHeightBlockIndices : zeroHeight,
      pendingBlocks: projection.pendingBlocks,
    }
    last = result
    return result
  }
}
