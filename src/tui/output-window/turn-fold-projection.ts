import { createTurnFolds, turnFoldSummary, type TurnFold, type TurnFoldPresentation } from "../../protocol/client/turn-folds.js"
import type { PresentedTerminalRow, TimelineRow } from "../output-blocks/visible-output-blocks.js"
import type { TranscriptWindowProjection } from "./output-window-projection.js"

/** A row the shared fold reads: any presented row but a fold. */
type FoldOutputRow = Extract<TimelineRow, { readonly kind: "turnFold" }>
const isInputRow = (row: PresentedTerminalRow | TurnFold<PresentedTerminalRow>): row is PresentedTerminalRow => row.kind !== "turnFold"

type TurnFoldProjector = ReturnType<typeof createTurnFoldProjector>

const residents = new WeakMap<TurnFoldPresentation, Map<string, TurnFoldProjector>>()

/** The projector of one session's transcript under `presentation`. It stays with the session, not with the window that
 *  mounts it, because the window remounts on every switch of tabs and a fold that settled must stay folded while the
 *  next turn runs (PI-INTERACTION-053). A presentation serves the one session of its module's tab, so the map stays
 *  small. */
export function turnFoldProjector(presentation: TurnFoldPresentation, sessionId: string): TurnFoldProjector {
  let sessions = residents.get(presentation)
  if (sessions === undefined) {
    sessions = new Map()
    residents.set(presentation, sessions)
  }
  let projector = sessions.get(sessionId)
  if (projector === undefined) {
    projector = createTurnFoldProjector(presentation)
    sessions.set(sessionId, projector)
  }
  return projector
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** Presents one session's projected window as its module asks (PI-LEAD-011): the calls that `presentation` hides are
 *  rows of no height, and each finished turn folds through the shared rule into one mounted row that holds its line
 *  and the rows that render under it. The fold row takes the place of the first row it holds, and every other row it
 *  holds measures as no height, so the window's height index stays one row per source block.
 *
 *  The fold memory lives as long as the returned function. A frame that changes nothing hands back the arrays of the
 *  previous frame, as the window projector does. */
function createTurnFoldProjector(presentation: TurnFoldPresentation) {
  const folds = createTurnFolds(presentation)
  const runs = new WeakMap<PresentedTerminalRow, PresentedTerminalRow>()
  const foldRows = new Map<string, FoldOutputRow>()
  let last: TranscriptWindowProjection | undefined

  /** The row without its hidden calls; undefined when nothing of it shows. */
  const shown = (row: TimelineRow): PresentedTerminalRow | undefined => {
    if (row.kind === "turnFold") throw new Error("a window projection holds no turn folds")
    if (row.kind === "tool") return presentation.hidden.has(row.name) ? undefined : row
    if (row.kind !== "toolRun") return row
    const children = row.children.filter((child) => !presentation.hidden.has(child.name))
    if (children.length === row.children.length) return row
    if (children.length === 0) return undefined
    const cached = runs.get(row)
    if (cached?.kind === "toolRun" && sameItems(cached.children, children)) return cached
    const run = { ...row, children }
    runs.set(row, run)
    return run
  }

  const foldRow = (fold: TurnFold<PresentedTerminalRow>, rows: readonly PresentedTerminalRow[], boundaryBefore: readonly boolean[]): FoldOutputRow => {
    const { label, failed } = turnFoldSummary(fold, undefined, presentation.phrases)
    const cached = foldRows.get(fold.id)
    if (cached && cached.open === fold.open && cached.timestamp === fold.timestamp && cached.label === label && cached.failed === failed && sameItems(cached.rows, rows) && sameItems(cached.boundaryBefore, boundaryBefore)) return cached
    // SAFETY: the marker records admission through this presenter and adds no runtime fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: only presentation admits rows to the renderer.
    const row = { kind: "turnFold", id: fold.id, open: fold.open, timestamp: fold.timestamp, label, failed, rows, boundaryBefore } as FoldOutputRow
    foldRows.set(fold.id, row)
    return row
  }

  return (projection: TranscriptWindowProjection, atRest: boolean, choice: (id: string) => boolean | undefined): TranscriptWindowProjection => {
    const rows: PresentedTerminalRow[] = []
    const boundaries: boolean[] = []
    const indexOf = new Map<PresentedTerminalRow, number>()
    const zeroHeight = [...projection.zeroHeightBlockIndices]
    for (const [i, row] of projection.timelineBlocks.entries()) {
      // SAFETY: the projection's arrays are parallel by construction.
      const index = projection.timelineBlockIndices[i]!
      const visible = shown(row)
      if (visible === undefined) { zeroHeight.push(index); continue }
      rows.push(visible)
      boundaries.push(projection.hasBoundaryBefore[i] ?? false)
      indexOf.set(visible, index)
    }
    const folded = folds({ rows, boundaryBefore: boundaries }, atRest, choice)
    const timelineBlocks: TimelineRow[] = []
    const hasBoundaryBefore: boolean[] = []
    const timelineBlockIndices: number[] = []
    for (let i = 0; i < folded.rows.length; i += 1) {
      // SAFETY: i ranges over the folded rows.
      const row = folded.rows[i]!
      if (row.kind !== "turnFold") {
        timelineBlocks.push(row)
        hasBoundaryBefore.push(folded.boundaryBefore[i] ?? false)
        // SAFETY: every row the fold passes on came from the input rows, each indexed above.
        timelineBlockIndices.push(indexOf.get(row)!)
        continue
      }
      const end = i + 1 + row.held
      const held = folded.rows.slice(i + 1, end).filter(isInputRow)
      // An open fold holds its work rows in both lists; a closed one holds only the rows that stay in view after it.
      // SAFETY: a fold holds input rows only, each indexed above.
      const indices = [...new Set([...row.rows, ...held])].map((member) => indexOf.get(member)!).sort((a, b) => a - b)
      timelineBlocks.push(foldRow(row, held, folded.boundaryBefore.slice(i + 1, end)))
      hasBoundaryBefore.push(folded.boundaryBefore[i] ?? false)
      // SAFETY: a fold holds at least one row of work.
      timelineBlockIndices.push(indices[0]!)
      zeroHeight.push(...indices.slice(1))
      i = end - 1
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
