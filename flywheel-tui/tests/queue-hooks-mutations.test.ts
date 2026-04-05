// ---------------------------------------------------------------------------
// Integration Tests — Queue Executor Hooks & Dynamic Mutations (Ticket 1.5)
// ---------------------------------------------------------------------------
//
// Validates hook-driven and dispatcher-driven queue mutations:
//   1. onStepCompleted hook inserts steps mid-execution
//   2. onStepCompleted hook with continueExecution on failure
//   3. Dispatcher mutation requests (insert_after via guardrails)
//   4. Guardrail enforcement — maxMutationsPerStepCompletion
//   5. Max queue length guardrail (queue.maxSteps via insertAfter)
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";
import type { OnStepCompletedHook } from "../src/queue/shared/hooks";
import { insertAfter, createQueue } from "../src/queue/queue";
import type { Step } from "../src/queue/types";

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

describe("queue hooks and dynamic mutations", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. onStepCompleted hook inserts steps after step 2
  // -------------------------------------------------------------------------

  test("onStepCompleted hook inserts steps mid-execution", async () => {
    resetStepCounter();

    const hook: OnStepCompletedHook = async (step, status, queue, _handoff) => {
      if (step.id === "step-2" && status === "completed") {
        const newSteps = [
          makeStep({ id: "inserted-1", title: "Inserted 1" }),
          makeStep({ id: "inserted-2", title: "Inserted 2" }),
        ];
        insertAfter(queue, step.id, newSteps, {
          actor: "test-hook",
          reason: "testing insertion",
        });
      }
      return { continueExecution: false };
    };

    harness = createHarness({
      stepCount: 5,
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Queue should have grown from 5 to 7 steps
    expect(harness.queue.steps).toHaveLength(7);

    // All 7 steps completed
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(7);
    expect(result.stepsTotal).toBe(7);

    // Every step should be completed
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // The inserted steps should appear after step-2 in the queue
    const stepIds = harness.queue.steps.map((s) => s.id);
    const step2Idx = stepIds.indexOf("step-2");
    expect(stepIds[step2Idx + 1]).toBe("inserted-1");
    expect(stepIds[step2Idx + 2]).toBe("inserted-2");

    // Original steps 3-5 should follow the inserted steps
    expect(stepIds[step2Idx + 3]).toBe("step-3");
    expect(stepIds[step2Idx + 4]).toBe("step-4");
    expect(stepIds[step2Idx + 5]).toBe("step-5");

    // The dispatcher should have been called 7 times (once per step)
    expect(harness.dispatcherOpts.calls).toHaveLength(7);

    // Mutation log should contain the insert
    const insertEntries = harness.queue.mutationLog.filter(
      (e) => e.action === "insert" && e.actor === "test-hook",
    );
    expect(insertEntries).toHaveLength(1);
    expect(insertEntries[0].stepIds).toEqual(["inserted-1", "inserted-2"]);
  });

  // -------------------------------------------------------------------------
  // 2. onStepCompleted hook with continueExecution on failure
  // -------------------------------------------------------------------------

  test("onStepCompleted hook continues execution after step failure", async () => {
    resetStepCounter();

    const hook: OnStepCompletedHook = async (_step, status, _queue, _handoff) => {
      return { continueExecution: status === "failed" };
    };

    harness = createHarness({
      stepCount: 5,
      worker: { failOnStepIds: new Set(["step-3"]) },
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Step 3 should be failed
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("failed");

    // Steps 1, 2, 4, 5 should be completed
    for (const id of ["step-1", "step-2", "step-4", "step-5"]) {
      const step = harness.queue.steps.find((s) => s.id === id)!;
      expect(step.status).toBe("completed");
    }

    // The executor should have completed the run (all steps processed)
    expect(result.completed).toBe(true);

    // stepsCompleted counts only successfully completed steps (not "handled")
    expect(result.stepsCompleted).toBe(4);
    expect(result.stepsTotal).toBe(5);

    // Queue status should be completed (all steps processed, loop ended normally)
    expect(harness.queue.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 3. Dispatcher mutation requests (insert_after via guardrails)
  // -------------------------------------------------------------------------

  test("dispatcher mutation requests insert steps through guardrails", async () => {
    resetStepCounter();

    const insertedStep = plainStep({ id: "dispatcher-inserted", title: "Dispatcher Inserted" });

    harness = createHarness({
      stepCount: 3,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            {
              type: "insert_after",
              targetStepId: "step-1",
              steps: [insertedStep],
              reason: "dispatcher mutation test",
            },
          ],
        },
      },
      guardrails: {}, // enable guardrails with defaults
    });

    const result = await harness.executor.run();

    // Queue should have 4 steps (3 original + 1 inserted)
    expect(harness.queue.steps).toHaveLength(4);

    // All 4 steps should be completed
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(4);
    expect(result.stepsTotal).toBe(4);

    // The inserted step should be in the queue after step-1
    const stepIds = harness.queue.steps.map((s) => s.id);
    const step1Idx = stepIds.indexOf("step-1");
    expect(stepIds[step1Idx + 1]).toBe("dispatcher-inserted");

    // Original steps 2-3 should follow
    expect(stepIds[step1Idx + 2]).toBe("step-2");
    expect(stepIds[step1Idx + 3]).toBe("step-3");

    // The inserted step should have been executed
    const dispatcherInserted = harness.queue.steps.find(
      (s) => s.id === "dispatcher-inserted",
    )!;
    expect(dispatcherInserted.status).toBe("completed");

    // Mutation log should record the insert with dispatcher provenance
    const insertEntries = harness.queue.mutationLog.filter(
      (e) => e.action === "insert" && e.actor === "dispatcher",
    );
    expect(insertEntries).toHaveLength(1);
    expect(insertEntries[0].stepIds).toEqual(["dispatcher-inserted"]);
  });

  // -------------------------------------------------------------------------
  // 4. Guardrail enforcement — maxMutationsPerStepCompletion
  // -------------------------------------------------------------------------

  test("guardrails reject mutations beyond per-step budget", async () => {
    resetStepCounter();

    harness = createHarness({
      stepCount: 3,
      dispatcher: {
        mutationsByStepId: {
          "step-1": [
            {
              type: "insert_after",
              targetStepId: "step-1",
              steps: [plainStep({ id: "m1", title: "Mutation 1" })],
              reason: "mutation 1",
            },
            {
              type: "insert_after",
              targetStepId: "step-1",
              steps: [plainStep({ id: "m2", title: "Mutation 2" })],
              reason: "mutation 2",
            },
            {
              type: "insert_after",
              targetStepId: "step-1",
              steps: [plainStep({ id: "m3", title: "Mutation 3" })],
              reason: "mutation 3",
            },
          ],
        },
      },
      guardrails: { maxMutationsPerStepCompletion: 2 },
    });

    const result = await harness.executor.run();

    // Only first 2 mutations should be applied: 3 original + 2 inserted = 5 steps
    expect(harness.queue.steps).toHaveLength(5);

    // All 5 steps should complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);
    expect(result.stepsTotal).toBe(5);

    // Verify the first 2 inserted steps are present
    const stepIds = harness.queue.steps.map((s) => s.id);
    expect(stepIds).toContain("m1");
    expect(stepIds).toContain("m2");

    // The third mutation (m3) should have been rejected
    expect(stepIds).not.toContain("m3");

    // Mutation log should show 2 inserts from the dispatcher
    const insertEntries = harness.queue.mutationLog.filter(
      (e) => e.action === "insert" && e.actor === "dispatcher",
    );
    expect(insertEntries).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 5. Max queue length guardrail (queue.maxSteps via insertAfter)
  // -------------------------------------------------------------------------

  test("insertAfter respects queue.maxSteps and rejects overflow", async () => {
    resetStepCounter();

    const hook: OnStepCompletedHook = async (step, status, queue, _handoff) => {
      if (step.id === "step-2" && status === "completed") {
        const s1 = makeStep({ id: "extra-1", title: "Extra 1" });
        const s2 = makeStep({ id: "extra-2", title: "Extra 2" });

        // First insert: 5 -> 6 (at maxSteps limit, should succeed)
        const r1 = insertAfter(queue, step.id, [s1], {
          actor: "hook",
          reason: "insert 1",
        });
        expect(r1.success).toBe(true);

        // Second insert: 6 -> 7 (exceeds maxSteps=6, should fail)
        const r2 = insertAfter(queue, step.id, [s2], {
          actor: "hook",
          reason: "insert 2",
        });
        expect(r2.success).toBe(false);
        if (!r2.success) {
          expect(r2.error).toContain("exceed max_steps");
        }
      }
      return { continueExecution: false };
    };

    // Create a queue with maxSteps=6 and pass it to the harness
    resetStepCounter();
    const steps = makeSteps(5);
    const queue = createQueue(steps, { maxSteps: 6 });

    harness = createHarness({
      queue,
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Queue should have exactly 6 steps (5 original + 1 inserted)
    expect(harness.queue.steps).toHaveLength(6);

    // All 6 steps should complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(6);
    expect(result.stepsTotal).toBe(6);

    // extra-1 should be present (first insert succeeded)
    const stepIds = harness.queue.steps.map((s) => s.id);
    expect(stepIds).toContain("extra-1");

    // extra-2 should NOT be present (second insert was rejected)
    expect(stepIds).not.toContain("extra-2");

    // maxSteps should still be 6 on the queue
    expect(harness.queue.maxSteps).toBe(6);

    // Mutation log should have exactly 1 insert from the hook
    const hookInserts = harness.queue.mutationLog.filter(
      (e) => e.action === "insert" && e.actor === "hook",
    );
    expect(hookInserts).toHaveLength(1);
    expect(hookInserts[0].stepIds).toEqual(["extra-1"]);
  });
});
