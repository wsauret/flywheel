import type { ChangesSummaryState } from "../../../src/protocol/client/session-changes.js"

/** Whole-session count only, from the last known count, never the request
 *  status, as the terminal's label reads it: a reread after a reconnect keeps
 *  the count it had instead of falling back to "Changes" for a moment.
 *  Missing counts are never presented as zero. */
export function changesLabel(summary: ChangesSummaryState | undefined): string {
  const data = summary !== undefined && "data" in summary ? summary.data : undefined
  if (data === undefined) return "Changes"
  return summary?.status === "incomplete" ? `${data.fileCount} known changed (incomplete)` : `${data.fileCount} changed`
}
