import { startSweeper } from "./sweeper.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention and cadence of the export sweeper. */
export const EXPORT_RETENTION_MS = 7 * DAY_MS;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function startExportMaintenance(directory: string) {
  return startSweeper(
    directory,
    EXPORT_RETENTION_MS,
    SWEEP_INTERVAL_MS,
    (deleted) => {
      if (deleted > 0) console.info(`export sweep deleted ${deleted} files`);
    },
    (error) => console.error("export sweep failed", error),
  );
}
