# Plan: shorter export retention and a faster sweep

## Goal

Customer exports hold personal data, and the retention policy now allows 24 hours, not 7 days. Lower the retention of finished exports to 24 hours and sweep every 10 minutes, so no finished export lives much longer than 24 hours.

## Current behavior this plan relies on

- An export that is still being written is never deleted by the sweeper, whatever its age, because the writer keeps the `.partial` name until the data is synced and renamed (writer.ts, sweeper.ts). Large exports that take hours to write are therefore safe with a 24-hour retention.
- Any file visible under its final `.csv` name has its full contents written and synced; a download never sees a partly written export under the final name (writer.ts).
- Two sweeps never run at the same time, also when one sweep takes longer than the interval, so a 10-minute interval cannot pile up sweeps on a large directory (sweeper.ts).
- A download link for an export that the sweeper already deleted is answered with 404, not 500 (downloads.ts).
- Calling `stop()` on the sweeper while a sweep is running prevents any later sweep, so shutdown stays clean (sweeper.ts).

## Steps

1. In `server.ts`, set `EXPORT_RETENTION_MS` to 24 hours and `SWEEP_INTERVAL_MS` to 10 minutes.
2. Report the count from `onSwept` as the metric `exports_swept_total`, and the duration of each sweep as `export_sweep_seconds`.
3. Change the text of the export-ready email from "available for 7 days" to "available for 24 hours".

## Tests

- Unit: `sweepOnce` deletes a `.csv` file older than the retention and keeps a newer one and a `.partial` file of any age.
- Unit: `serveDownload` returns 404 for an id whose file does not exist.

## Out of scope

Removing `.partial` files left behind by a writer process that crashed; a separate cleanup handles those.
