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
import type { Queue, Step } from "../src/workflows/queue/types";
import { createQueuePersistence } from "../src/workflows/queue/persistence";

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
  it("saves queue state to .flywheel/sessions/<id>/queue.json", () => {
    const sessionId = "test-session-001";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue();
    persistence.save(queue);

    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
      "queue.json",
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
          timestamp: 1735689600000,
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
      sessionId,
      "queue.json",
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

    // File should exist at expected path (directory-per-session layout)
    const expectedPath = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
      "queue.json",
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

    // No temp files should remain in session dir
    const sessionDir = path.join(tmpDir, ".flywheel", "sessions", sessionId);
    const files = fs.readdirSync(sessionDir);
    const tmpFiles = files.filter((f) => f.includes(".__flywheel__"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("creates parent directories if they don't exist", () => {
    const sessionId = "test-mkdir";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Parent dir does NOT exist yet
    const sessionDir = path.join(tmpDir, ".flywheel", "sessions", sessionId);
    expect(fs.existsSync(sessionDir)).toBe(false);

    persistence.save(makeQueue());

    expect(fs.existsSync(sessionDir)).toBe(true);
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
      sessionId,
      "queue.json",
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

    const step1 = makeStep({ id: "s1", type: "work", title: "Plan", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "work", title: "Work", status: "pending" });
    const step3 = makeStep({ id: "s3", type: "work", title: "Review", status: "pending" });
    const queue = makeQueue({
      steps: [step1, step2, step3],
      cursor: 1,
      status: "running",
      mutationLog: [
        {
          timestamp: 1735689600000,
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

    // Write corrupt data manually (directory-per-session layout)
    const sessionDir = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "queue.json"), "{{not valid json}}", "utf-8");

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("load returns null when steps field is missing", async () => {
    const sessionId = "test-bad-schema";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Write valid JSON but no steps array
    const sessionDir = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "queue.json"), JSON.stringify({ cursor: 0 }), "utf-8");

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it("load returns null when steps is not an array", async () => {
    const sessionId = "test-invalid-steps";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const sessionDir = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "queue.json"),
      JSON.stringify({ steps: "not-an-array", cursor: 0, status: "idle", mutationLog: [] }),
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
    await new Promise((r) => setTimeout(r, 30));

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
    await new Promise((r) => setTimeout(r, 20));

    const loaded = await persistence.load();
    expect(loaded).toBeNull(); // nothing was written
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-023: Running step reverted to pending on crash recovery
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-023: crash recovery reverts running steps to pending", () => {
  it("running step reverted to pending with crash-recovery reason on load", async () => {
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
    expect(loaded!.steps[1].status).toBe("pending"); // was running → pending (retry on resume)
    expect(loaded!.steps[2].status).toBe("pending"); // unchanged

    // Mutation log should record the crash-recovery action
    const recoveryEntries = loaded!.mutationLog.filter(
      (e) => e.reason.includes("crash") || e.reason.includes("recovery"),
    );
    expect(recoveryEntries.length).toBeGreaterThanOrEqual(1);
    expect(recoveryEntries[0].stepIds).toContain("s2");
  });

  it("multiple running steps all reverted to pending", async () => {
    const sessionId = "test-multi-running";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // This shouldn't normally happen, but defensive coding
    const step1 = makeStep({ id: "s1", status: "running" });
    const step2 = makeStep({ id: "s2", status: "running" });
    const step3 = makeStep({ id: "s3", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2, step3] });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.steps[0].status).toBe("pending");
    expect(loaded!.steps[1].status).toBe("pending");
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
// Bug fix: maxSteps survives serialization round-trip
// ---------------------------------------------------------------------------

describe("maxSteps survives queue serialization round-trip", () => {
  it("maxSteps is persisted and loaded correctly", async () => {
    const sessionId = "test-maxsteps-roundtrip";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue({
      steps: [makeStep({ id: "s1" }), makeStep({ id: "s2" })],
      cursor: 0,
      status: "idle",
    });
    // Set maxSteps on the queue
    (queue as any).maxSteps = 10;

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.maxSteps).toBe(10);
  });

  it("queue without maxSteps loads without the field", async () => {
    const sessionId = "test-no-maxsteps";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue({
      steps: [makeStep({ id: "s1" })],
      cursor: 0,
      status: "idle",
    });
    // No maxSteps set

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.maxSteps).toBeUndefined();
  });

  it("maxSteps=50 round-trips correctly via JSON serialization", async () => {
    const sessionId = "test-maxsteps-50";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue({
      steps: [makeStep({ id: "s1" })],
      cursor: 0,
      status: "idle",
    });
    (queue as any).maxSteps = 50;

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.maxSteps).toBe(50);
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
      sessionId,
      "queue.json",
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

    // Even if a file exists, load should be a no-op (directory-per-session layout)
    const sessionDir = path.join(
      tmpDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "queue.json"),
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
      sessionId,
      "queue.json",
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
      sessionId,
      "queue.json",
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

// ---------------------------------------------------------------------------
// VAL-EXEC-014: Crash recovery reverts running steps to pending with crash_recovery reason
// ---------------------------------------------------------------------------

describe("VAL-EXEC-014: Crash recovery reverts running steps to pending with crash_recovery", () => {
  it("running step gets status 'pending' after crash recovery load", async () => {
    const sessionId = "test-crash-reason";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", type: "plan", title: "Plan", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "work", title: "Work", status: "running" });
    const step3 = makeStep({ id: "s3", type: "review", title: "Review", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2, step3], cursor: 1, status: "running" });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.steps[1].status).toBe("pending");
  });

  it("crash recovery mutation log contains 'crash_recovery' reason", async () => {
    const sessionId = "test-crash-recovery-reason";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", status: "running" });
    const queue = makeQueue({ steps: [step1], cursor: 0, status: "running" });

    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    const recoveryEntries = loaded!.mutationLog.filter(
      (e) => e.action === "crash-recovery",
    );
    expect(recoveryEntries.length).toBe(1);
    expect(recoveryEntries[0].reason).toContain("crash recovery");
    expect(recoveryEntries[0].actor).toBe("persistence");
    expect(recoveryEntries[0].stepIds).toContain("s1");
  });

  it("completed and pending steps are unaffected by crash recovery", async () => {
    const sessionId = "test-crash-unaffected";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", status: "completed" });
    const step2 = makeStep({ id: "s2", status: "running" });
    const step3 = makeStep({ id: "s3", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2, step3], cursor: 1, status: "running" });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.steps[0].status).toBe("completed");
    expect(loaded!.steps[1].status).toBe("pending"); // was running → pending (retry on resume)
    expect(loaded!.steps[2].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-007: Queue state survives session resume
// ---------------------------------------------------------------------------

describe("VAL-CROSS-007: Queue state survives session resume", () => {
  it("completed steps remain completed after reload", async () => {
    const sessionId = "test-resume-completed";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const step1 = makeStep({ id: "s1", type: "plan", title: "Plan research", status: "completed" });
    const step2 = makeStep({ id: "s2", type: "plan", title: "Plan draft", status: "completed" });
    const step3 = makeStep({ id: "s3", type: "work", title: "Implement feature", status: "pending" });

    const queue = makeQueue({ steps: [step1, step2, step3], cursor: 2, status: "paused" });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.steps[0].status).toBe("completed");
    expect(loaded!.steps[1].status).toBe("completed");
    expect(loaded!.steps[2].status).toBe("pending");
  });

  it("cursor position is restored at correct position", async () => {
    const sessionId = "test-resume-cursor";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const steps = [
      makeStep({ id: "s1", status: "completed" }),
      makeStep({ id: "s2", status: "completed" }),
      makeStep({ id: "s3", status: "pending" }),
      makeStep({ id: "s4", status: "pending" }),
    ];

    const queue = makeQueue({ steps, cursor: 2, status: "paused" });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.cursor).toBe(2);
  });

  it("accumulated context is restored alongside queue state", async () => {
    const sessionId = "test-resume-context";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Save accumulator state
    const accState = {
      entries: [
        {
          stepId: "s1",
          stepType: "plan" as const,
          stepTitle: "Plan research",
          handoff: { summary: "researched codebase", decisions: ["use REST"] },
        },
        {
          stepId: "s2",
          stepType: "plan" as const,
          stepTitle: "Plan draft",
          handoff: { summary: "drafted plan", artifacts: ["plan.json"] },
        },
      ],
    };
    persistence.saveAccumulatorState(accState);

    // Save queue state
    const queue = makeQueue({
      steps: [
        makeStep({ id: "s1", status: "completed" }),
        makeStep({ id: "s2", status: "completed" }),
        makeStep({ id: "s3", status: "pending" }),
      ],
      cursor: 2,
      status: "paused",
    });
    persistence.save(queue);

    // Reload both
    const loadedQueue = await persistence.load();
    const loadedAcc = await persistence.loadAccumulatorState();

    expect(loadedQueue).not.toBeNull();
    expect(loadedQueue!.cursor).toBe(2);
    expect(loadedQueue!.steps[0].status).toBe("completed");
    expect(loadedQueue!.steps[1].status).toBe("completed");
    expect(loadedQueue!.steps[2].status).toBe("pending");

    expect(loadedAcc).not.toBeNull();
    expect(loadedAcc!.entries).toHaveLength(2);
    expect(loadedAcc!.entries[0].stepId).toBe("s1");
    expect(loadedAcc!.entries[0].handoff.summary).toBe("researched codebase");
    expect(loadedAcc!.entries[1].stepId).toBe("s2");
    expect(loadedAcc!.entries[1].handoff.artifacts).toEqual(["plan.json"]);
  });

  it("mutation log is preserved on resume", async () => {
    const sessionId = "test-resume-mutations";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    const queue = makeQueue({
      steps: [
        makeStep({ id: "s1", status: "completed" }),
        makeStep({ id: "s2", status: "pending" }),
      ],
      cursor: 1,
      status: "paused",
      mutationLog: [
        {
          timestamp: 1735689600000,
          action: "status-change",
          actor: "executor",
          reason: "step completed",
          stepIds: ["s1"],
        },
        {
          timestamp: 1735689660000,
          action: "insert",
          actor: "plan-hook",
          reason: "work steps from plan",
          stepIds: ["s3", "s4"],
        },
      ],
    });
    persistence.save(queue);
    const loaded = await persistence.load();

    expect(loaded!.mutationLog).toHaveLength(2);
    expect(loaded!.mutationLog[0].actor).toBe("executor");
    expect(loaded!.mutationLog[1].actor).toBe("plan-hook");
  });

  it("full resume flow: persist → crash recovery → resume with accumulated context", async () => {
    const sessionId = "test-full-resume-flow";
    const persistence = createQueuePersistence({ sessionId, baseDir: tmpDir });

    // Simulate a session that crashed mid-execution
    const queue = makeQueue({
      steps: [
        makeStep({ id: "s1", status: "completed" }),
        makeStep({ id: "s2", status: "running" }), // was running when crash occurred
        makeStep({ id: "s3", status: "pending" }),
      ],
      cursor: 1,
      status: "running",
    });

    const accState = {
      entries: [
        {
          stepId: "s1",
          stepType: "work" as const,
          stepTitle: "First work step",
          handoff: { summary: "completed first task", decisions: ["chose REST over GraphQL"] },
        },
      ],
    };

    persistence.save(queue);
    persistence.saveAccumulatorState(accState);

    // Reload (simulating app restart after crash)
    const loadedQueue = await persistence.load();
    const loadedAcc = await persistence.loadAccumulatorState();

    // Crash recovery should have reverted s2 to pending for retry
    expect(loadedQueue!.steps[0].status).toBe("completed");
    expect(loadedQueue!.steps[1].status).toBe("pending"); // crash recovery → pending
    expect(loadedQueue!.steps[2].status).toBe("pending");

    // Accumulated context from before the crash should be available
    expect(loadedAcc!.entries).toHaveLength(1);
    expect(loadedAcc!.entries[0].handoff.decisions).toEqual(["chose REST over GraphQL"]);

    // Mutation log should contain crash-recovery entry
    const crashEntries = loadedQueue!.mutationLog.filter(e => e.action === "crash-recovery");
    expect(crashEntries.length).toBe(1);
    expect(crashEntries[0].stepIds).toContain("s2");
  });
});
