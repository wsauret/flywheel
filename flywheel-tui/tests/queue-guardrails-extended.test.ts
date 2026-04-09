// ---------------------------------------------------------------------------
// Integration Tests — Guardrails, Mutations, and Immutability (ADR-003)
// ---------------------------------------------------------------------------
//
// Validates guardrail enforcement at the executor integration level:
//   1. Max inserted steps per session guardrail
//   2. Skip mutation via dispatcher
//   3. Remove mutation via dispatcher
//   4. Completed steps are immutable to mutations
//   5. Provenance fields on mutation log entries
//   6. Dispatcher unavailable — step fails
//   7. (TODO) Convergence detection — not yet wired in executor
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";
import type { OnStepCompletedHook } from "../src/workflows/queue/shared/hooks";
import { removeStep } from "../src/workflows/queue/queue";
import type { Step } from "../src/workflows/queue/types";

/**
 * Build a Step literal without touching the shared counter.
 * Use this for steps passed into mutation configs *before* the harness
 * creates its own steps via makeSteps / makeStep, so the counter stays
 * predictable (step-1, step-2, ...).
 */
function plainStep(overrides: Partial<Step> & { id: string; title: string }): Step {
  return {
    type: "work",
    status: "pending",
    ...overrides,
  } as Step;
}

describe("guardrails, mutations, and immutability", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Max inserted steps per session guardrail
  // -------------------------------------------------------------------------

  test("max inserted steps per session guardrail enforced", async () => {
    const insertedStep1 = plainStep({ id: "ins-1", title: "Inserted 1" });
    const insertedStep2 = plainStep({ id: "ins-2", title: "Inserted 2" });
    const insertedStep3 = plainStep({ id: "ins-3", title: "Inserted 3" });

    harness = createHarness({
      stepCount: 3,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            { type: "insert_after", targetStepId: "step-1", steps: [insertedStep1], reason: "insert 1" },
          ],
          "step-2": [
            { type: "insert_after", targetStepId: "step-2", steps: [insertedStep2], reason: "insert 2" },
          ],
          "step-3": [
            { type: "insert_after", targetStepId: "step-3", steps: [insertedStep3], reason: "insert 3" },
          ],
        },
      },
      guardrails: { maxInsertedStepsPerSession: 2 },
    });

    const result = await harness.executor.run();

    // First 2 inserts succeed, 3rd is rejected by session insert budget
    // Queue should have 5 steps (3 original + 2 inserted), not 6
    expect(harness.queue.steps).toHaveLength(5);

    // All 5 steps should complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);
    expect(result.stepsTotal).toBe(5);

    // Verify the first 2 inserted steps are present
    const stepIds = harness.queue.steps.map((s) => s.id);
    expect(stepIds).toContain("ins-1");
    expect(stepIds).toContain("ins-2");

    // The third insertion should have been rejected
    expect(stepIds).not.toContain("ins-3");
  });

  // -------------------------------------------------------------------------
  // 2. Skip mutation via dispatcher
  // -------------------------------------------------------------------------

  test("skip mutation via dispatcher marks step as skipped", async () => {
    harness = createHarness({
      stepCount: 5,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            { type: "skip", targetStepId: "step-3", reason: "not needed" },
          ],
        },
      },
      guardrails: {},
    });

    const result = await harness.executor.run();

    // Step 3 should be skipped
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("skipped");

    // Steps 1, 2, 4, 5 should be completed
    for (const id of ["step-1", "step-2", "step-4", "step-5"]) {
      const step = harness.queue.steps.find((s) => s.id === id)!;
      expect(step.status).toBe("completed");
    }

    // 4 steps completed (step 3 skipped)
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 3. Remove mutation via dispatcher
  // -------------------------------------------------------------------------

  test("remove mutation via dispatcher removes step from queue", async () => {
    harness = createHarness({
      stepCount: 5,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            { type: "remove", targetStepId: "step-4", reason: "redundant" },
          ],
        },
      },
      guardrails: {},
    });

    const result = await harness.executor.run();

    // Queue should have 4 steps (step 4 removed)
    expect(harness.queue.steps).toHaveLength(4);

    // All 4 remaining steps should be completed
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(4);
    expect(result.stepsTotal).toBe(4);

    // Step 4 should not be present
    const stepIds = harness.queue.steps.map((s) => s.id);
    expect(stepIds).not.toContain("step-4");

    // Remaining steps should all be completed
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }
  });

  // -------------------------------------------------------------------------
  // 4. Completed steps are immutable to mutations
  // -------------------------------------------------------------------------

  test("completed steps are immutable to remove mutations", async () => {
    const hookResults: Array<{ success: boolean; error?: string }> = [];

    const hook: OnStepCompletedHook = async (step, status, queue, _handoff) => {
      if (step.id === "step-3" && status === "completed") {
        // Try to remove step-1 which is already completed
        const result = removeStep(queue, "step-1", {
          actor: "test-hook",
          reason: "try to remove completed step",
        });
        hookResults.push(
          result.success
            ? { success: true }
            : { success: false, error: "error" in result ? result.error : "unknown" },
        );
      }
      return { continueExecution: false };
    };

    harness = createHarness({
      stepCount: 5,
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // The remove operation should have been rejected
    expect(hookResults).toHaveLength(1);
    expect(hookResults[0].success).toBe(false);
    expect(hookResults[0].error).toContain("completed");

    // Step 1 should still be in the queue
    const step1 = harness.queue.steps.find((s) => s.id === "step-1");
    expect(step1).toBeDefined();
    expect(step1!.status).toBe("completed");

    // All 5 steps should complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);
    expect(result.stepsTotal).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 5. Provenance fields on mutation log entries
  // -------------------------------------------------------------------------

  test("mutation log entries have provenance fields", async () => {
    const insertedStep = plainStep({ id: "prov-inserted", title: "Provenance Test" });

    harness = createHarness({
      stepCount: 3,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            {
              type: "insert_after",
              targetStepId: "step-1",
              steps: [insertedStep],
              reason: "provenance test insertion",
            },
          ],
        },
      },
      guardrails: {},
    });

    await harness.executor.run();

    // Find the insert mutation log entry from the dispatcher
    const insertEntries = harness.queue.mutationLog.filter(
      (e) => e.action === "insert" && e.actor === "dispatcher",
    );
    expect(insertEntries).toHaveLength(1);

    const entry = insertEntries[0];

    // Verify provenance fields
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe("number");
    // Should be a valid epoch ms timestamp
    expect(entry.timestamp).toBeGreaterThan(0);

    expect(entry.action).toBe("insert");
    expect(entry.actor).toBe("dispatcher");
    expect(entry.reason).toBeDefined();
    expect(typeof entry.reason).toBe("string");
    expect(entry.reason.length).toBeGreaterThan(0);

    expect(entry.stepIds).toBeDefined();
    expect(Array.isArray(entry.stepIds)).toBe(true);
    expect(entry.stepIds).toContain("prov-inserted");
  });

  // -------------------------------------------------------------------------
  // 6. Dispatcher unavailable — step fails
  // -------------------------------------------------------------------------

  test("dispatcher error causes step to fail", async () => {
    harness = createHarness({
      stepCount: 3,
      dispatcher: { failOnStepIds: new Set(["step-2"]) },
    });

    const result = await harness.executor.run();

    // Execution should stop due to step 2 failing
    expect(result.completed).toBe(false);

    // Step 1 should be completed
    const step1 = harness.queue.steps.find((s) => s.id === "step-1")!;
    expect(step1.status).toBe("completed");

    // Step 2 should be failed
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("failed");

    // Step 3 should still be pending (never reached)
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("pending");

    // Only 1 step completed
    expect(result.stepsCompleted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7. (TODO) Convergence detection
  // -------------------------------------------------------------------------
  // NOTE: The executor does not currently call guardrails.recordIssueDescription()
  // or guardrails.checkConvergence(), so convergence detection cannot be tested
  // at the integration level. The guardrails unit tests cover this behavior.
  // This is a known gap — when the executor integrates convergence detection,
  // an integration test should be added here.
});
