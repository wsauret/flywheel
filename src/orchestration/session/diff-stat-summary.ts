import { parseProjectionFact } from "../../infra/event-projection.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { parseFileMutationFact } from "./file-mutation-facts.js"
import type { FileLineStats } from "./file-mutation-types.js"

export const DIFF_STAT_FACT_TYPES = ["file.changed"] as const

export type DiffStatSummary = FileLineStats

/** Per-event accumulation for the background summary index. `null` means no
 * line stats observed yet, which the catalog renders as an absent column. */
export function foldDiffStatEvent(current: DiffStatSummary | null, event: StoredFact): DiffStatSummary | null {
  const fact = parseProjectionFact(event, parseFileMutationFact)
  if (fact.type !== "file.changed" || !fact.payload.lineStats) return current
  return {
    added: (current?.added ?? 0) + fact.payload.lineStats.added,
    modified: (current?.modified ?? 0) + fact.payload.lineStats.modified,
    removed: (current?.removed ?? 0) + fact.payload.lineStats.removed,
  }
}
