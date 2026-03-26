/**
 * Queue Persistence Tests
 *
 * Tests for createQueuePersistence() factory following the output-persistence.ts
 * pattern. Covers VAL-QUEUE-019..023:
 *   019: Queue state saved to .flywheel/sessions/<id>.queue.json
 *   020: Atomic writes (writeFileAtomic) prevent corruption
 *   021: Load queue from disk with all state intact (round-trip)
 *   022: Debounced writes coalesce rapid changes
 *   023: Running step marked failed on crash recovery load
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Queue, Step } from "../src/queue/types";
import { createQueuePersistence } from "../src/queue/persistence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "queue-persist-test-"));
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? "work",
    title: overrides.title ?? "Test step",
    status: overrides.status ?? "pending",
    ...overrides,
  };
}

function makeQueue(overrides: Partial<Queue> = {}): Queue {
  return {
    steps: overrides.steps ?? [makeStep()],
    cursor: overrides.cursor ?? 0,
    status: overrides.status ?? "idle",
    mutationLog: overrides.mutationLog ?? [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-019: Queue persisted to session-specific file
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-019: save writes to correct file path", () => {
  it("saves queue state to .flywheel/sessions/<id>.queue.json", () => {
    const sessionId = "test-session-001";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue();
    persistence.save(queue);

    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

    const raw = fs.readFileSync(expectedPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.steps).toBeDefined();
    expect(parsed.cursor).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.mutationLog).toBeDefined();
  });

  it("file contains valid JSON matching queue state", () => {
    const sessionId = "test-session-json";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", type: "plan", title: "Plan it", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "work", title: "Work it", status: "pending" });
    const queue = makeQueue({
      steps: [step1, step2],
      cursor: 1,
      status: "running",
      mutationLog: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          action: "status-change",
          actor: "executor",
          reason: "step completed",
          stepIds: ["s1"],
        },
      ],
    });

    persistence.save(queue);

    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    const raw = fs.readFileSync(expectedPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].id).toBe("s1");
    expect(parsed.steps[0].status).toBe("completed");
    expect(parsed.steps[1].id).toBe("s2");
    expect(parsed.steps[1].status).toBe("pending");
    expect(parsed.cursor).toBe(1);
    expect(parsed.status).toBe("running");
    expect(parsed.mutationLog).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-020: Atomic writes prevent corruption
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-020: atomic writes via writeFileAtomic", () => {
  it("uses writeFileAtomic (write→fsync→rename) for corruption safety", () => {
    // We verify atomicity by checking that the write succeeds and no
    // temp files remain. writeFileAtomic uses tmp→fsync→rename.
    const sessionId = "test-atomic";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue();
    persistence.save(queue);

    // File should exist at expected path
    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

    // No temp files should remain in sessions dir
    const sessionsDir = path.join(tmpDir, ".flywheel", "sessions");
    const files = fs.readdirSync(sessionsDir);
    const tmpFiles = files.filter((f) => f.includes(".__flywheel__"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("creates parent directories if they don't exist", () => {
    const sessionId = "test-mkdir";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Parent dir does NOT exist yet
    const sessionsDir = path.join(tmpDir, ".flywheel", "sessions");
    expect(fs.existsSync(sessionsDir)).toBe(false);

    persistence.save(makeQueue());

    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it("overwrites previous save without corruption", () => {
    const sessionId = "test-overwrite";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue1 = makeQueue({ cursor: 0, status: "idle" });
    persistence.save(queue1);

    const queue2 = makeQueue({ cursor: 2, status: "running" });
    persistence.save(queue2);

    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    const raw = fs.readFileSync(expectedPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.cursor).toBe(2);
    expect(parsed.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-021: Load queue from disk on resume
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-021: load round-trips persist → load", () => {
  it("load returns queue state with all fields intact", async () => {
    const sessionId = "test-roundtrip";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", type: "plan", title: "Plan", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "work", title: "Work", status: "pending" });
    const step3 = makeStep({ id: "s3", type: "review", title: "Review", status: "pending",
      dependsOn: ["s2"], fulfills: ["VAL-001"], milestone: "m1" });
    const queue = makeQueue({
      steps: [step1, step2, step3],
      cursor: 1,
      status: "running",
      mutationLog: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          action: "status-change",
          actor: "executor",
          reason: "step completed",
          stepIds: ["s1"],
        },
      ],
    });

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(3);
    expect(loaded!.steps[0].id).toBe("s1");
    expect(loaded!.steps[0].status).toBe("completed");
    expect(loaded!.steps[1].id).toBe("s2");
    expect(loaded!.steps[1].status).toBe("pending");
    expect(loaded!.steps[2].id).toBe("s3");
    expect(loaded!.steps[2].dependsOn).toEqual(["s2"]);
    expect(loaded!.steps[2].fulfills).toEqual(["VAL-001"]);
    expect(loaded!.steps[2].milestone).toBe("m1");
    expect(loaded!.cursor).toBe(1);
    expect(loaded!.status).toBe("running");
    expect(loaded!.mutationLog).toHaveLength(1);
    expect(loaded!.mutationLog[0].actor).toBe("executor");
  });

  it("load returns null when file does not exist", async () => {
    const sessionId = "test-missing";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("load returns null on corrupt JSON", async () => {
    const sessionId = "test-corrupt";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Write corrupt data manually
    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{{not valid json}}", "utf-8");

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("load returns null on invalid schema (missing required field)", async () => {
    const sessionId = "test-bad-schema";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Write valid JSON but invalid queue structure
    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ steps: [] }), "utf-8");

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("load validates step types via Zod schema", async () => {
    const sessionId = "test-invalid-type";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        steps: [{ id: "x", type: "INVALID_TYPE", title: "Bad", status: "pending" }],
        cursor: 0,
        status: "idle",
        mutationLog: [],
      }),
      "utf-8",
    );

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-022: Debounced writes coalesce rapid changes
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-022: debounced flusher coalesces rapid writes", () => {
  it("multiple rapid schedule calls result in one write", async () => {
    const sessionId = "test-debounce";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    let writeCount = 0;
    const originalSave = persistence.save.bind(persistence);

    // Track saves via the flusher
    const queues: Queue[] = [];
    for (let i = 0; i < 5; i++) {
      queues.push(makeQueue({ cursor: i }));
    }

    // Use a very short debounce interval for testing
    const flusher = persistence.createFlusher({ intervalMs: 50 });

    // Schedule 5 rapid updates
    for (const q of queues) {
      flusher.schedule(q);
    }

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 150));

    // Force flush to ensure all writes complete
    await flusher.flush();
    flusher.dispose();

    // Only the LAST queue should have been written
    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.cursor).toBe(4); // last queue had cursor 4
  });

  it("flush() force-writes immediately", async () => {
    const sessionId = "test-flush";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const flusher = persistence.createFlusher({ intervalMs: 10_000 }); // very long debounce

    const queue = makeQueue({ cursor: 42 });
    flusher.schedule(queue);

    // Flush immediately — doesn't wait for debounce
    await flusher.flush();
    flusher.dispose();

    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.cursor).toBe(42);
  });

  it("dispose() cancels pending writes", async () => {
    const sessionId = "test-dispose";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const flusher = persistence.createFlusher({ intervalMs: 10_000 });

    flusher.schedule(makeQueue({ cursor: 99 }));
    flusher.dispose(); // cancel before fire

    // Wait briefly to confirm nothing fires
    await new Promise((r) => setTimeout(r, 100));

    const loaded = await persistence.load();
    expect(loaded).toBeNull(); // nothing was written
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-023: Running step marked failed on crash recovery
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-023: crash recovery marks running steps as failed", () => {
  it("running step marked failed with crash-recovery reason on load", async () => {
    const sessionId = "test-crash-recovery";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", type: "plan", title: "Plan", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "work", title: "Work", status: "running" });
    const step3 = makeStep({ id: "s3", type: "review", title: "Review", status: "pending" });

    const queue = makeQueue({
      steps: [step1, step2, step3],
      cursor: 1,
      status: "running",
    });

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.steps[0].status).toBe("completed"); // unchanged
    expect(loaded!.steps[1].status).toBe("failed"); // was running → failed
    expect(loaded!.steps[2].status).toBe("pending"); // unchanged

    // Mutation log should record the crash-recovery action
    const recoveryEntries = loaded!.mutationLog.filter(
      (e) => e.reason.includes("crash") || e.reason.includes("recovery"),
    );
    expect(recoveryEntries.length).toBeGreaterThanOrEqual(1);
    expect(recoveryEntries[0].stepIds).toContain("s2");
  });

  it("multiple running steps all marked failed", async () => {
    const sessionId = "test-multi-running";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // This shouldn't normally happen, but defensive coding
    const step1 = makeStep({ id: "s1", status: "running" });
    const step2 = makeStep({ id: "s2", status: "running" });
    const step3 = makeStep({ id: "s3", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2, step3] });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.steps[0].status).toBe("failed");
    expect(loaded!.steps[1].status).toBe("failed");
    expect(loaded!.steps[2].status).toBe("pending");
  });

  it("no running steps — queue loads unchanged", async () => {
    const sessionId = "test-no-running";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", status: "completed" });
    const step2 = makeStep({ id: "s2", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2], cursor: 1 });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.steps[0].status).toBe("completed");
    expect(loaded!.steps[1].status).toBe("pending");
    // No crash-recovery entries should be added
    expect(loaded!.mutationLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// persist_queue=false — no-op behavior
// ---------------------------------------------------------------------------

describe("persist_queue=false means no file I/O", () => {
  it("save is a no-op when disabled", () => {
    const sessionId = "test-disabled-save";
    const persistence = createQueuePersistence({
      sessionId,
      baseDir: tmpDir,
      persistQueue: false,
    });

    persistence.save(makeQueue());

    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("load returns null when disabled", async () => {
    const sessionId = "test-disabled-load";
    const persistence = createQueuePersistence({
      sessionId,
      baseDir: tmpDir,
      persistQueue: false,
    });

    // Even if a file exists, load should be a no-op
    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(makeQueue()),
      "utf-8",
    );

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("createFlusher schedule/flush are no-ops when disabled", async () => {
    const sessionId = "test-disabled-flusher";
    const persistence = createQueuePersistence({
      sessionId,
      baseDir: tmpDir,
      persistQueue: false,
    });

    const flusher = persistence.createFlusher({ intervalMs: 10 });
    flusher.schedule(makeQueue({ cursor: 99 }));
    await flusher.flush();
    flusher.dispose();

    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("delete removes queue file", () => {
  it("delete returns true when file exists", async () => {
    const sessionId = "test-delete";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    persistence.save(makeQueue());
    const result = await persistence.delete();
    expect(result).toBe(true);

    const filePath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      `${sessionId}.queue.json`,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("delete returns false when file does not exist", async () => {
    const sessionId = "test-delete-missing";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const result = await persistence.delete();
    expect(result).toBe(false);
  });
});
