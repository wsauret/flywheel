import { PRODUCTION_VALIDATORS } from "./registry.ts";
import type { BackfillReport, EventKind, WebhookEvent } from "./types.ts";

/** The kinds the nightly job replays from the provider archive. A kind joins
 *  the backfill only when it is listed here. Archive events of any other kind
 *  are skipped, not failed, because the archive also carries kinds this
 *  service never consumes. */
export const BACKFILLED_KINDS: readonly EventKind[] = ["order.placed", "order.cancelled", "refund.issued"];

/** Nightly recovery path: re-validate archived events so gaps caused by
 *  webhook outages are healed. Runs from a scheduled job, not the HTTP path. */
export function runBackfill(archive: readonly WebhookEvent[]): BackfillReport {
  const replayed = new Set<EventKind>(BACKFILLED_KINDS);
  const report: BackfillReport = { accepted: [], invalid: [], skipped: [] };
  for (const event of archive) {
    if (!replayed.has(event.kind)) {
      report.skipped.push(event.id);
      continue;
    }
    const validator = PRODUCTION_VALIDATORS.get(event.kind);
    if (!validator) {
      throw new Error(`Backfill kind ${event.kind} has no validator registered`);
    }
    const issues = validator.validate(event.payload);
    if (issues.length > 0) {
      report.invalid.push(event.id);
    } else {
      report.accepted.push(event.id);
    }
  }
  return report;
}
