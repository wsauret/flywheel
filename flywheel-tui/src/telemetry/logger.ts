/**
 * Telemetry logger — persists timing/count metrics for workflow runs.
 *
 * SECURITY: No worker output content is included. Only timing, counts, and error kinds.
 *
 * Files: `<workflow>-<timestamp>-<pid>.json`
 * Directory: `.flywheel/telemetry/`
 * Rotation: 50-file max, oldest-first eviction.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TelemetryRecordSchema = z.object({
  workflow: z.string(),
  workflow_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  duration_ms: z.number().optional(),
  steps_total: z.number(),
  steps_completed: z.number(),
  dispatcher_mode: z.enum(["static", "dispatcher"]),
  evaluation_cycles: z.number(),
  errors: z.array(
    z.object({
      step: z.number(),
      kind: z.string(),
      message: z.string(),
    }),
  ),
});

export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>;

// ---------------------------------------------------------------------------
// Allowed keys — only these are persisted (security: no worker output)
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set<string>([
  "workflow",
  "workflow_id",
  "started_at",
  "completed_at",
  "duration_ms",
  "steps_total",
  "steps_completed",
  "dispatcher_mode",
  "evaluation_cycles",
  "errors",
]);

// ---------------------------------------------------------------------------
// TelemetryLogger
// ---------------------------------------------------------------------------

export class TelemetryLogger {
  private readonly dir: string;
  private readonly maxFiles: number;

  constructor(dir: string, maxFiles: number = 50) {
    this.dir = dir;
    this.maxFiles = maxFiles;
  }

  /**
   * Start a telemetry record for a workflow run.
   * Returns a mutable record object that can be updated in-place.
   */
  startRecord(
    workflow: string,
    workflowId: string,
    options: {
      stepsTotal: number;
      dispatcherMode: "static" | "dispatcher";
    },
  ): TelemetryRecord {
    return {
      workflow,
      workflow_id: workflowId,
      started_at: new Date().toISOString(),
      steps_total: options.stepsTotal,
      steps_completed: 0,
      dispatcher_mode: options.dispatcherMode,
      evaluation_cycles: 0,
      errors: [],
    };
  }

  /**
   * Update the current record with partial data.
   * For errors, the update array is appended (not replaced).
   */
  updateRecord(record: TelemetryRecord, update: Partial<TelemetryRecord>): void {
    if (update.errors && update.errors.length > 0) {
      record.errors.push(...update.errors);
    }

    // Apply non-error fields (including optional fields like completed_at, duration_ms)
    for (const [key, value] of Object.entries(update)) {
      if (key === "errors") continue;
      if (ALLOWED_KEYS.has(key)) {
        (record as any)[key] = value;
      }
    }
  }

  /**
   * Finalize and persist the record to disk.
   * Strips any fields not in the allowed set (security: no worker output).
   */
  async persist(record: TelemetryRecord): Promise<void> {
    mkdirSync(this.dir, { recursive: true });

    // Strip to allowed keys only (security)
    const safe: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in record) {
        safe[key] = (record as any)[key];
      }
    }

    // Validate before writing
    const validated = TelemetryRecordSchema.parse(safe);

    // Generate filename: <workflow>-<timestamp>-<pid>.json
    const timestamp = Date.now();
    const pid = process.pid;
    const filename = `${validated.workflow}-${timestamp}-${pid}.json`;
    const filePath = join(this.dir, filename);

    writeFileSync(filePath, JSON.stringify(validated, null, 2) + "\n", "utf-8");

    // Evict oldest if over limit
    await this.evict();
  }

  /**
   * Evict oldest files if count exceeds maxFiles.
   */
  private async evict(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }

    if (files.length <= this.maxFiles) return;

    // Sort by modification time ascending (oldest first)
    const withStats = files.map((f) => {
      const path = join(this.dir, f);
      try {
        const stat = statSync(path);
        return { file: f, mtime: stat.mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    });
    withStats.sort((a, b) => a.mtime - b.mtime);

    // Remove oldest files until we're at the limit
    const toRemove = withStats.length - this.maxFiles;
    for (let i = 0; i < toRemove; i++) {
      try {
        unlinkSync(join(this.dir, withStats[i].file));
      } catch {
        // Skip unremovable files
      }
    }
  }
}
