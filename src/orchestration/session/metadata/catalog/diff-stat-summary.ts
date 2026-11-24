import { parseProjectionFact } from "../../../../infra/event-projection.js"
import type { StoredFact } from "../../../../infra/event-store-types.js"
import { parseFileMutationFact } from "../../file-mutations/file-mutation-facts.js"

export const DIFF_STAT_FACT_TYPES = ["file.changed", "file.artifact.recorded"] as const

/** Exclusive line columns: a line that one edit replaced counts as modified,
 *  and only the rest counts as added or removed. */
export interface DiffStatSummary {
  readonly added: number
  readonly modified: number
  readonly removed: number
}

/** A session's diff stat, and the mutation whose historical `file.changed`
 *  `lineStats` the fold counted last. */
export interface DiffStatState {
  readonly stats: DiffStatSummary | null
  readonly lineStatsMutationId: string | null
}

/** Whether a diff-stat row can change the counts. Artifact versions before v4
 *  carry no line counts, so the fold neither decodes them nor reports their
 *  damage. */
export function carriesDiffStats(row: { readonly type: string; readonly version: number }): boolean {
  return row.type !== "file.artifact.recorded" || row.version === 4
}

/** Per-event accumulation for the background summary index. A null `stats`
 *  means no line counts observed yet, which the catalog renders as an absent
 *  column.
 *
 *  Each mutation counts once. The `file.artifact.recorded` v4 evidence of an
 *  applied edit holds its added and removed lines. Writers before 2026-11-16
 *  also set `lineStats` on the `file.changed` of a created file, and sessions
 *  recorded before v4 evidence have only those. A writer records a change and
 *  its v4 artifact together, change first, so the artifact of the mutation
 *  whose `lineStats` the fold counted last is already counted, and such a
 *  session keeps the counts that it showed before. */
export function foldDiffStatEvent(current: DiffStatState, event: StoredFact): DiffStatState {
  if (!carriesDiffStats(event)) return current
  const fact = parseProjectionFact(event, parseFileMutationFact)
  if (fact.type === "file.changed") {
    if (!fact.payload.lineStats) return current
    return {
      stats: add(current.stats, fact.payload.lineStats),
      lineStatsMutationId: fact.version === 1 ? null : fact.payload.mutationId,
    }
  }
  if (fact.type !== "file.artifact.recorded" || fact.version !== 4) return current
  if (fact.payload.mutationId === current.lineStatsMutationId) return current
  // The evidence has per-file totals, so the modified column pairs the file's
  // added and removed lines, as one hunk of a unified diff would.
  const { addedLines, removedLines } = fact.payload.evidence
  const modified = Math.min(addedLines, removedLines)
  return {
    stats: add(current.stats, { added: addedLines - modified, modified, removed: removedLines - modified }),
    lineStatsMutationId: current.lineStatsMutationId,
  }
}

function add(current: DiffStatSummary | null, next: DiffStatSummary): DiffStatSummary {
  return {
    added: (current?.added ?? 0) + next.added,
    modified: (current?.modified ?? 0) + next.modified,
    removed: (current?.removed ?? 0) + next.removed,
  }
}
