import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import {
  createQueue,
  transitionStep,
  insertAfter,
  removeStep,
  skipStep,
  reorderSteps,
  replaceStep,
  advanceCursor,
  isFinished,
} from "../src/queue/queue";

import type { Step, Queue } from "../src/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Test step",
    status: "pending",
    ...overrides,
  };
}

function makeQueue(steps: Step[], opts?: { maxSteps?: number }): Queue {
  return createQueue(steps, opts);
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-001 (partial): createQueue() — creation
// ---------------------------------------------------------------------------

describe("createQueue", () => {
  test("creates queue with all steps pending and cursor at 0", () => {
    const steps = [
      makeStep({ type: "plan", title: "Plan" }),
      makeStep({ type: "work", title: "Work" }),
      makeStep({ type: "review", title: "Review" }),
    ];
    const q = createQueue(steps);
    expect(q.steps).toHaveLength(3);
    expect(q.cursor).toBe(0);
    expect(q.status).toBe("idle");
    expect(q.mutationLog).toEqual([]);
    for (const s of q.steps) {
      expect(s.status).toBe("pending");
    }
  });

  test("creates queue with empty steps array", () => {
    const q = createQueue([]);
    expect(q.steps).toHaveLength(0);
    expect(q.cursor).toBe(0);
    expect(q.status).toBe("idle");
  });

  test("preserves step IDs, types, and titles", () => {
    const step = makeStep({ type: "gate", title: "Approval gate" });
    const q = createQueue([step]);
    expect(q.steps[0].id).toBe(step.id);
    expect(q.steps[0].type).toBe("gate");
    expect(q.steps[0].title).toBe("Approval gate");
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-002: Step lifecycle — pending → running
// VAL-QUEUE-003: Step lifecycle — running → completed
// VAL-QUEUE-004: Step lifecycle — running → failed
// VAL-QUEUE-005: Step lifecycle — pending → skipped
// ---------------------------------------------------------------------------

describe("transitionStep", () => {
  test("pending → running is valid", () => {
    const s = makeStep({ status: "pending" });
    const q = makeQueue([s]);
    const result = transitionStep(q, s.id, "running", {
      actor: "executor",
      reason: "Starting execution",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.queue.steps.find((st) => st.id === s.id);
      expect(step?.status).toBe("running");
    }
  });

  test("running → completed is valid", () => {
    const s = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s];
    const result = transitionStep(q, s.id, "completed", {
      actor: "executor",
      reason: "Step finished successfully",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.queue.steps.find((st) => st.id === s.id);
      expect(step?.status).toBe("completed");
    }
  });

  test("running → failed is valid", () => {
    const s = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s];
    const result = transitionStep(q, s.id, "failed", {
      actor: "executor",
      reason: "Worker crashed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.queue.steps.find((st) => st.id === s.id);
      expect(step?.status).toBe("failed");
    }
  });

  test("pending → skipped is valid", () => {
    const s = makeStep({ status: "pending" });
    const q = makeQueue([s]);
    const result = transitionStep(q, s.id, "skipped", {
      actor: "user",
      reason: "User skipped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.queue.steps.find((st) => st.id === s.id);
      expect(step?.status).toBe("skipped");
    }
  });

  test("completed → running is invalid", () => {
    const s = makeStep({ status: "completed" });
    const q = createQueue([]);
    q.steps = [s];
    const result = transitionStep(q, s.id, "running", {
      actor: "executor",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("failed → running is invalid", () => {
    const s = makeStep({ status: "failed" });
    const q = createQueue([]);
    q.steps = [s];
    const result = transitionStep(q, s.id, "running", {
      actor: "executor",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("skipped → running is invalid", () => {
    const s = makeStep({ status: "skipped" });
    const q = createQueue([]);
    q.steps = [s];
    const result = transitionStep(q, s.id, "running", {
      actor: "executor",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("pending → completed is invalid (must go through running)", () => {
    const s = makeStep({ status: "pending" });
    const q = makeQueue([s]);
    const result = transitionStep(q, s.id, "completed", {
      actor: "executor",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("pending → failed is invalid (must go through running)", () => {
    const s = makeStep({ status: "pending" });
    const q = makeQueue([s]);
    const result = transitionStep(q, s.id, "failed", {
      actor: "executor",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("logs provenance on successful transition", () => {
    const s = makeStep({ status: "pending" });
    const q = makeQueue([s]);
    const result = transitionStep(q, s.id, "running", {
      actor: "executor",
      reason: "Starting",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.mutationLog).toHaveLength(1);
      const entry = result.queue.mutationLog[0];
      expect(entry.action).toBe("status-change");
      expect(entry.actor).toBe("executor");
      expect(entry.reason).toBe("Starting");
      expect(entry.stepIds).toEqual([s.id]);
      expect(entry.timestamp).toBeTruthy();
    }
  });

  test("returns error for non-existent step ID", () => {
    const q = makeQueue([makeStep()]);
    const result = transitionStep(q, "nonexistent", "running", {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-008: Queue cursor advances correctly
// ---------------------------------------------------------------------------

describe("advanceCursor", () => {
  test("advances to next pending step", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "pending" });
    const s3 = makeStep({ status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2, s3];
    q.cursor = 0;
    advanceCursor(q);
    expect(q.cursor).toBe(1);
  });

  test("skips completed/failed/skipped steps", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "failed" });
    const s3 = makeStep({ status: "skipped" });
    const s4 = makeStep({ status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2, s3, s4];
    q.cursor = 0;
    advanceCursor(q);
    expect(q.cursor).toBe(3);
  });

  test("cursor stays at end when no pending steps remain", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "failed" });
    const q = createQueue([]);
    q.steps = [s1, s2];
    q.cursor = 0;
    advanceCursor(q);
    expect(q.cursor).toBe(2); // past end
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-009: Queue reports finished when no pending steps remain
// ---------------------------------------------------------------------------

describe("isFinished", () => {
  test("returns true when all steps completed", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "completed" });
    const q = createQueue([]);
    q.steps = [s1, s2];
    expect(isFinished(q)).toBe(true);
  });

  test("returns true when all steps completed/failed/skipped (no pending)", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "failed" });
    const s3 = makeStep({ status: "skipped" });
    const q = createQueue([]);
    q.steps = [s1, s2, s3];
    expect(isFinished(q)).toBe(true);
  });

  test("returns false when pending steps remain", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2];
    expect(isFinished(q)).toBe(false);
  });

  test("returns false when a step is running", () => {
    const s1 = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s1];
    expect(isFinished(q)).toBe(false);
  });

  test("returns true for empty queue", () => {
    const q = createQueue([]);
    expect(isFinished(q)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-010: Insert step(s) after a specific step ID
// ---------------------------------------------------------------------------

describe("insertAfter", () => {
  test("inserts steps after a given step ID", () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const q = makeQueue([s1, s2]);
    const newStep = makeStep({ title: "Inserted" });
    const result = insertAfter(q, s1.id, [newStep], {
      actor: "executor",
      reason: "Plan output",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps).toHaveLength(3);
      expect(result.queue.steps[0].id).toBe(s1.id);
      expect(result.queue.steps[1].id).toBe(newStep.id);
      expect(result.queue.steps[2].id).toBe(s2.id);
    }
  });

  test("inserts multiple steps in order", () => {
    const s1 = makeStep({ title: "Step 1" });
    const q = makeQueue([s1]);
    const new1 = makeStep({ title: "New 1" });
    const new2 = makeStep({ title: "New 2" });
    const result = insertAfter(q, s1.id, [new1, new2], {
      actor: "executor",
      reason: "Inserting work steps",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps.map((s) => s.title)).toEqual([
        "Step 1",
        "New 1",
        "New 2",
      ]);
    }
  });

  test("inserted steps have pending status", () => {
    const s1 = makeStep();
    const q = makeQueue([s1]);
    const newStep = makeStep({ status: "pending" });
    const result = insertAfter(q, s1.id, [newStep], {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].status).toBe("pending");
    }
  });

  test("returns error for non-existent target step ID", () => {
    const q = makeQueue([makeStep()]);
    const result = insertAfter(q, "nonexistent", [makeStep()], {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  test("logs provenance on insert", () => {
    const s1 = makeStep();
    const q = makeQueue([s1]);
    const newStep = makeStep();
    const result = insertAfter(q, s1.id, [newStep], {
      actor: "sprint-hook",
      reason: "Retry pair",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog.find(
        (e) => e.action === "insert"
      );
      expect(entry).toBeDefined();
      expect(entry!.actor).toBe("sprint-hook");
      expect(entry!.reason).toBe("Retry pair");
      expect(entry!.stepIds).toEqual([newStep.id]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-017: Max steps limit enforced
// ---------------------------------------------------------------------------

describe("max_steps enforcement", () => {
  test("rejects insert that would exceed max_steps", () => {
    const steps = Array.from({ length: 5 }, () => makeStep());
    const q = makeQueue(steps, { maxSteps: 5 });
    const result = insertAfter(q, steps[0].id, [makeStep()], {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("max_steps");
    }
  });

  test("allows insert when under max_steps", () => {
    const steps = Array.from({ length: 3 }, () => makeStep());
    const q = makeQueue(steps, { maxSteps: 5 });
    const result = insertAfter(q, steps[0].id, [makeStep()], {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(true);
  });

  test("allows insert exactly at max_steps", () => {
    const steps = Array.from({ length: 4 }, () => makeStep());
    const q = makeQueue(steps, { maxSteps: 5 });
    const result = insertAfter(q, steps[0].id, [makeStep()], {
      actor: "executor",
      reason: "test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-011: Remove a pending step by ID
// VAL-QUEUE-012: Cannot remove completed or running steps
// ---------------------------------------------------------------------------

describe("removeStep", () => {
  test("removes a pending step", () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const s3 = makeStep({ title: "Step 3" });
    const q = makeQueue([s1, s2, s3]);
    const result = removeStep(q, s2.id, {
      actor: "user",
      reason: "Not needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps).toHaveLength(2);
      expect(result.queue.steps.map((s) => s.id)).toEqual([s1.id, s3.id]);
    }
  });

  test("rejects removing a completed step", () => {
    const s1 = makeStep({ status: "completed" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = removeStep(q, s1.id, {
      actor: "user",
      reason: "cleanup",
    });
    expect(result.success).toBe(false);
  });

  test("rejects removing a running step", () => {
    const s1 = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = removeStep(q, s1.id, {
      actor: "user",
      reason: "cleanup",
    });
    expect(result.success).toBe(false);
  });

  test("returns error for non-existent step ID", () => {
    const q = makeQueue([makeStep()]);
    const result = removeStep(q, "nonexistent", {
      actor: "user",
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  test("adjusts cursor when removing step before cursor", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "pending" });
    const s3 = makeStep({ status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2, s3];
    q.cursor = 2;
    // Remove s2 (index 1, before cursor 2) → cursor should decrease
    const result = removeStep(q, s2.id, {
      actor: "user",
      reason: "test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.cursor).toBe(1);
    }
  });

  test("logs provenance on remove", () => {
    const s1 = makeStep();
    const q = makeQueue([s1]);
    const result = removeStep(q, s1.id, {
      actor: "user",
      reason: "Not needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog.find(
        (e) => e.action === "remove"
      );
      expect(entry).toBeDefined();
      expect(entry!.actor).toBe("user");
      expect(entry!.stepIds).toEqual([s1.id]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-013: Skip a pending step
// ---------------------------------------------------------------------------

describe("skipStep", () => {
  test("sets pending step to skipped", () => {
    const s1 = makeStep({ status: "pending" });
    const q = makeQueue([s1]);
    const result = skipStep(q, s1.id, {
      actor: "user",
      reason: "Skipping",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[0].status).toBe("skipped");
    }
  });

  test("rejects skipping a completed step", () => {
    const s1 = makeStep({ status: "completed" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = skipStep(q, s1.id, {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("rejects skipping a running step", () => {
    const s1 = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = skipStep(q, s1.id, {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("cursor advances past skipped step", () => {
    const s1 = makeStep({ status: "pending" });
    const s2 = makeStep({ status: "pending" });
    const q = makeQueue([s1, s2]);
    q.cursor = 0;
    const result = skipStep(q, s1.id, {
      actor: "user",
      reason: "Skip it",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Cursor should advance past the skipped step
      expect(result.queue.cursor).toBe(1);
    }
  });

  test("logs provenance on skip", () => {
    const s1 = makeStep();
    const q = makeQueue([s1]);
    const result = skipStep(q, s1.id, {
      actor: "user",
      reason: "Not needed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog.find(
        (e) => e.action === "skip"
      );
      expect(entry).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-014: Reorder pending steps
// ---------------------------------------------------------------------------

describe("reorderSteps", () => {
  test("reorders pending steps by IDs", () => {
    const s1 = makeStep({ title: "A", status: "pending" });
    const s2 = makeStep({ title: "B", status: "pending" });
    const s3 = makeStep({ title: "C", status: "pending" });
    const q = makeQueue([s1, s2, s3]);
    // Reorder: C, A, B
    const result = reorderSteps(q, [s3.id, s1.id, s2.id], {
      actor: "user",
      reason: "Reorder",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps.map((s) => s.title)).toEqual(["C", "A", "B"]);
    }
  });

  test("does not affect completed/running/skipped steps", () => {
    const s1 = makeStep({ title: "Done", status: "completed" });
    const s2 = makeStep({ title: "A", status: "pending" });
    const s3 = makeStep({ title: "B", status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2, s3];
    // Reorder only the pending: B, A
    const result = reorderSteps(q, [s3.id, s2.id], {
      actor: "user",
      reason: "Reorder pending",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[0].id).toBe(s1.id); // completed stays
      expect(result.queue.steps[1].id).toBe(s3.id); // B now first pending
      expect(result.queue.steps[2].id).toBe(s2.id); // A now second pending
    }
  });

  test("rejects reorder including non-pending step IDs", () => {
    const s1 = makeStep({ status: "completed" });
    const s2 = makeStep({ status: "pending" });
    const q = createQueue([]);
    q.steps = [s1, s2];
    // Try to reorder completed step
    const result = reorderSteps(q, [s1.id, s2.id], {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("logs provenance on reorder", () => {
    const s1 = makeStep({ status: "pending" });
    const s2 = makeStep({ status: "pending" });
    const q = makeQueue([s1, s2]);
    const result = reorderSteps(q, [s2.id, s1.id], {
      actor: "user",
      reason: "Reorder",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog.find(
        (e) => e.action === "reorder"
      );
      expect(entry).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-015: Replace a pending step
// VAL-QUEUE-016: Cannot mutate completed steps
// ---------------------------------------------------------------------------

describe("replaceStep", () => {
  test("replaces a pending step with a new step at the same position", () => {
    const s1 = makeStep({ title: "Old" });
    const s2 = makeStep({ title: "After" });
    const q = makeQueue([s1, s2]);
    const replacement = makeStep({ title: "New" });
    const result = replaceStep(q, s1.id, replacement, {
      actor: "user",
      reason: "Better step",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps).toHaveLength(2);
      expect(result.queue.steps[0].id).toBe(replacement.id);
      expect(result.queue.steps[0].title).toBe("New");
      expect(result.queue.steps[1].id).toBe(s2.id);
    }
  });

  test("rejects replacing a completed step", () => {
    const s1 = makeStep({ status: "completed" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = replaceStep(q, s1.id, makeStep(), {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("rejects replacing a running step", () => {
    const s1 = makeStep({ status: "running" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = replaceStep(q, s1.id, makeStep(), {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("rejects replacing a failed step", () => {
    const s1 = makeStep({ status: "failed" });
    const q = createQueue([]);
    q.steps = [s1];
    const result = replaceStep(q, s1.id, makeStep(), {
      actor: "user",
      reason: "attempt",
    });
    expect(result.success).toBe(false);
  });

  test("logs provenance on replace", () => {
    const s1 = makeStep();
    const q = makeQueue([s1]);
    const replacement = makeStep();
    const result = replaceStep(q, s1.id, replacement, {
      actor: "user",
      reason: "Better step",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog.find(
        (e) => e.action === "replace"
      );
      expect(entry).toBeDefined();
      expect(entry!.stepIds).toContain(s1.id);
      expect(entry!.stepIds).toContain(replacement.id);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-018: Mutation provenance recorded
// ---------------------------------------------------------------------------

describe("mutation provenance", () => {
  test("each mutation records actor, reason, and timestamp", () => {
    const s1 = makeStep();
    const s2 = makeStep();
    const q = makeQueue([s1, s2]);

    // Perform a mutation
    const result = insertAfter(q, s1.id, [makeStep()], {
      actor: "sprint-hook",
      reason: "Retry pair insertion",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.queue.mutationLog[0];
      expect(entry.actor).toBe("sprint-hook");
      expect(entry.reason).toBe("Retry pair insertion");
      expect(entry.timestamp).toBeTruthy();
      // Timestamp should be valid ISO string
      expect(() => new Date(entry.timestamp)).not.toThrow();
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    }
  });

  test("multiple mutations accumulate in log", () => {
    const s1 = makeStep();
    const s2 = makeStep();
    let q = makeQueue([s1, s2]);

    // First mutation: transition
    const r1 = transitionStep(q, s1.id, "running", {
      actor: "executor",
      reason: "Start",
    });
    expect(r1.success).toBe(true);
    if (r1.success) q = r1.queue;

    const r2 = transitionStep(q, s1.id, "completed", {
      actor: "executor",
      reason: "Done",
    });
    expect(r2.success).toBe(true);
    if (r2.success) q = r2.queue;

    expect(q.mutationLog).toHaveLength(2);
    expect(q.mutationLog[0].reason).toBe("Start");
    expect(q.mutationLog[1].reason).toBe("Done");
  });
});
