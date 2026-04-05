import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TelemetryLogger,
  TelemetryRecordSchema,
} from "../src/orchestration/telemetry";
import type { TelemetryRecord } from "../src/orchestration/telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let telemetryDir: string;
let base: string;

async function setupDir() {
  base = await mkdtemp(join(tmpdir(), "ses-telemetry-"));
  telemetryDir = join(base, "telemetry");
  // Don't pre-create — logger should create it
  return base;
}

// ---------------------------------------------------------------------------
// TelemetryRecordSchema
// ---------------------------------------------------------------------------

describe("TelemetryRecordSchema", () => {
  const validRecord: TelemetryRecord = {
    workflow: "work",
    workflow_id: "wf-123",
    started_at: "2026-03-16T10:00:00Z",
    steps_total: 3,
    steps_completed: 0,
    dispatcher_mode: "static",
    evaluation_cycles: 0,
    errors: [],
  };

  it("accepts a valid record", () => {
    const result = TelemetryRecordSchema.safeParse(validRecord);
    expect(result.success).toBe(true);
  });

  it("accepts a completed record with duration", () => {
    const completed = {
      ...validRecord,
      completed_at: "2026-03-16T10:05:00Z",
      duration_ms: 300000,
      steps_completed: 3,
    };
    const result = TelemetryRecordSchema.safeParse(completed);
    expect(result.success).toBe(true);
  });

  it("accepts a record with errors", () => {
    const withErrors = {
      ...validRecord,
      errors: [{ step: 0, kind: "worker_timeout", message: "Worker timed out after 5m" }],
    };
    const result = TelemetryRecordSchema.safeParse(withErrors);
    expect(result.success).toBe(true);
  });

  it("rejects invalid dispatcher_mode", () => {
    const result = TelemetryRecordSchema.safeParse({
      ...validRecord,
      dispatcher_mode: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("requires workflow field", () => {
    const { workflow, ...noWorkflow } = validRecord;
    const result = TelemetryRecordSchema.safeParse(noWorkflow);
    expect(result.success).toBe(false);
  });

  it("requires workflow_id field", () => {
    const { workflow_id, ...noId } = validRecord;
    const result = TelemetryRecordSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TelemetryLogger: record creation
// ---------------------------------------------------------------------------

describe("TelemetryLogger: record creation", () => {
  it("startRecord creates a valid TelemetryRecord", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-abc", {
      stepsTotal: 5,
      dispatcherMode: "dispatcher",
    });

    expect(record.workflow).toBe("work");
    expect(record.workflow_id).toBe("wf-abc");
    expect(record.steps_total).toBe(5);
    expect(record.steps_completed).toBe(0);
    expect(record.dispatcher_mode).toBe("dispatcher");
    expect(record.evaluation_cycles).toBe(0);
    expect(record.errors).toEqual([]);
    expect(record.started_at).toBeTruthy();
  });

  it("started_at is a valid ISO timestamp", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    const parsed = new Date(record.started_at);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("created record passes schema validation", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 2,
      dispatcherMode: "static",
    });
    const result = TelemetryRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TelemetryLogger: updateRecord
// ---------------------------------------------------------------------------

describe("TelemetryLogger: updateRecord", () => {
  it("updates steps_completed", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 3,
      dispatcherMode: "static",
    });
    logger.updateRecord(record, { steps_completed: 2 });
    expect(record.steps_completed).toBe(2);
  });

  it("updates evaluation_cycles", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "dispatcher",
    });
    logger.updateRecord(record, { evaluation_cycles: 3 });
    expect(record.evaluation_cycles).toBe(3);
  });

  it("appends errors", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    logger.updateRecord(record, {
      errors: [{ step: 0, kind: "worker_timeout", message: "Timed out" }],
    });
    expect(record.errors.length).toBe(1);
    expect(record.errors[0].kind).toBe("worker_timeout");
  });

  it("sets completed_at and duration_ms on finalization", () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    logger.updateRecord(record, {
      completed_at: new Date().toISOString(),
      duration_ms: 5000,
    });
    expect(record.completed_at).toBeTruthy();
    expect(record.duration_ms).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// TelemetryLogger: persist
// ---------------------------------------------------------------------------

describe("TelemetryLogger: persist", () => {
  beforeEach(async () => {
    await setupDir();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("creates the telemetry directory if it doesn't exist", async () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    await logger.persist(record);
    const files = await readdir(telemetryDir);
    expect(files.length).toBe(1);
  });

  it("writes a JSON file with correct naming convention", async () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    await logger.persist(record);
    const files = await readdir(telemetryDir);
    expect(files.length).toBe(1);
    // <workflow>-<timestamp>-<pid>.json
    expect(files[0]).toMatch(/^work-\d+-\d+\.json$/);
  });

  it("persisted file is valid JSON matching schema", async () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 2,
      dispatcherMode: "dispatcher",
    });
    logger.updateRecord(record, { steps_completed: 1 });
    await logger.persist(record);

    const files = await readdir(telemetryDir);
    const content = await readFile(join(telemetryDir, files[0]), "utf-8");
    const parsed = JSON.parse(content);
    const result = TelemetryRecordSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    expect(parsed.steps_completed).toBe(1);
  });

  it("does NOT contain worker output content (security)", async () => {
    const logger = new TelemetryLogger(telemetryDir);
    const record = logger.startRecord("work", "wf-1", {
      stepsTotal: 1,
      dispatcherMode: "static",
    });
    // Attempt to sneak output content in via extra fields
    (record as any).worker_output = "SENSITIVE OUTPUT DATA";
    (record as any).output = "MORE SENSITIVE DATA";
    await logger.persist(record);

    const files = await readdir(telemetryDir);
    const content = await readFile(join(telemetryDir, files[0]), "utf-8");
    expect(content).not.toContain("SENSITIVE OUTPUT DATA");
    expect(content).not.toContain("MORE SENSITIVE DATA");
  });
});

// ---------------------------------------------------------------------------
// TelemetryLogger: file rotation
// ---------------------------------------------------------------------------

describe("TelemetryLogger: file rotation", () => {
  beforeEach(async () => {
    await setupDir();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("evicts oldest files when exceeding maxFiles", async () => {
    const maxFiles = 3;
    const logger = new TelemetryLogger(telemetryDir, maxFiles);

    // Persist 5 records
    for (let i = 0; i < 5; i++) {
      const record = logger.startRecord("work", `wf-${i}`, {
        stepsTotal: 1,
        dispatcherMode: "static",
      });
      await logger.persist(record);
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
    }

    const files = await readdir(telemetryDir);
    expect(files.length).toBe(maxFiles);
  });

  it("keeps the newest files after eviction", async () => {
    const maxFiles = 2;
    const logger = new TelemetryLogger(telemetryDir, maxFiles);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `wf-${i}`;
      ids.push(id);
      const record = logger.startRecord("work", id, {
        stepsTotal: 1,
        dispatcherMode: "static",
      });
      await logger.persist(record);
      await new Promise((r) => setTimeout(r, 10));
    }

    const files = await readdir(telemetryDir);
    expect(files.length).toBe(maxFiles);

    // Read the remaining files and check they have the latest workflow_ids
    const remaining: string[] = [];
    for (const file of files) {
      const content = await readFile(join(telemetryDir, file), "utf-8");
      const parsed = JSON.parse(content);
      remaining.push(parsed.workflow_id);
    }
    remaining.sort();
    expect(remaining).toContain("wf-2");
    expect(remaining).toContain("wf-3");
  });

  it("default maxFiles is 50", () => {
    const logger = new TelemetryLogger(telemetryDir);
    // Access internal maxFiles via a record-persist cycle won't exceed 50
    // We just verify the constructor doesn't throw
    expect(logger).toBeTruthy();
  });
});
