// ---------------------------------------------------------------------------
// Integration Tests — Queue Executor Linear Execution (Ticket 1.2)
// ---------------------------------------------------------------------------
//
// Validates the happy-path linear execution of the step executor:
//   1. 5-step queue runs to completion
//   2. Context accumulates across steps
//   3. Events emitted in correct order
//   4. Persistence after every step
//   5. Handoff chaining between steps
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  resetStepCounter,
  type Harness,
} from "./queue-executor-harness";

describe("queue linear execution", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. 5-step queue runs to completion
  // -------------------------------------------------------------------------

  test("5-step queue runs to completion", async () => {
    harness = createHarness({ stepCount: 5 });
    const result = await harness.executor.run();

    // Result assertions
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);
    expect(result.stepsTotal).toBe(5);

    // All steps should have status "completed"
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Queue overall status should be "completed"
    expect(harness.queue.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 2. Context accumulates across steps
  // -------------------------------------------------------------------------

  test("context accumulates across steps", async () => {
    harness = createHarness({
      stepCount: 5,
      worker: {
        handoffByStepId: {
          "step-1": { result: "alpha", decisions: ["use-typescript"] },
          "step-2": { result: "beta", artifacts: ["src/main.ts"] },
          "step-3": { result: "gamma", issues: ["lint-warning"] },
          "step-4": { result: "delta", decisions: ["add-tests"] },
          "step-5": { result: "epsilon" },
        },
      },
    });

    await harness.executor.run();

    // The dispatcher should have been called 5 times
    const calls = harness.dispatcherOpts.calls!;
    expect(calls).toHaveLength(5);

    // By step 5 (index 4), the accumulator should have context from steps 1-4
    const lastContext = calls[4].context as {
      totalSteps: number;
      recentHandoffs: Array<{ stepId: string; handoff: Record<string, unknown> }>;
      summaries: Array<{ stepId: string }>;
    };
    expect(lastContext.totalSteps).toBeGreaterThanOrEqual(4);

    // recentHandoffs should contain data from recent steps (window size is 3)
    expect(lastContext.recentHandoffs.length).toBeGreaterThan(0);

    // Verify recent handoffs contain actual handoff data from prior steps
    const recentIds = lastContext.recentHandoffs.map((h) => h.stepId);
    // The most recent handoff should be from step-4 (the last completed before step 5 runs)
    expect(recentIds).toContain("step-4");

    // First call (step 1) should have no accumulated context
    const firstContext = calls[0].context as { totalSteps: number };
    expect(firstContext.totalSteps).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Events emitted in correct order
  // -------------------------------------------------------------------------

  test("events emitted in correct order", async () => {
    harness = createHarness({ stepCount: 5 });
    await harness.executor.run();

    const allEvents = harness.events.events;

    // Count each event type
    const initialized = harness.events.ofType("queue:initialized");
    const stepStarted = harness.events.ofType("queue:step-started");
    const stepCompleted = harness.events.ofType("queue:step-completed");
    const queueCompleted = harness.events.ofType("queue:completed");

    expect(initialized).toHaveLength(1);
    expect(stepStarted).toHaveLength(5);
    expect(stepCompleted).toHaveLength(5);
    expect(queueCompleted).toHaveLength(1);

    // First event should be queue:initialized
    expect(allEvents[0].type).toBe("queue:initialized");

    // Last event should be queue:completed
    expect(allEvents[allEvents.length - 1].type).toBe("queue:completed");

    // Verify ordering: each step-started must come before its corresponding step-completed
    for (let i = 0; i < 5; i++) {
      const startIdx = allEvents.findIndex(
        (e) => e.type === "queue:step-started" && (e as { stepId: string }).stepId === stepStarted[i].stepId,
      );
      const completeIdx = allEvents.findIndex(
        (e) => e.type === "queue:step-completed" && (e as { stepId: string }).stepId === stepStarted[i].stepId,
      );
      expect(startIdx).toBeLessThan(completeIdx);
    }

    // Verify sequential ordering: step N completes before step N+1 starts
    for (let i = 0; i < 4; i++) {
      const completeIdx = allEvents.indexOf(stepCompleted[i]);
      const nextStartIdx = allEvents.indexOf(stepStarted[i + 1]);
      expect(completeIdx).toBeLessThan(nextStartIdx);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Persistence after every step
  // -------------------------------------------------------------------------

  test("persistence after every step completion", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "s1", title: "Step 1" }),
      makeStep({ id: "s2", title: "Step 2" }),
      makeStep({ id: "s3", title: "Step 3" }),
      makeStep({ id: "s4", title: "Step 4" }),
      makeStep({ id: "s5", title: "Step 5" }),
    ];
    harness = createHarness({ steps });

    await harness.executor.run();

    const pc = harness.persistCalls;

    // Each step produces at least 2 persist calls (running + completed),
    // plus 1 final persist when the queue itself completes.
    expect(pc.length).toBeGreaterThanOrEqual(10);

    // First persist: step s1 transitions to "running"
    expect(pc[0].steps.filter((s) => s.status === "running").length).toBe(1);
    expect(pc[0].steps.find((s) => s.id === "s1")!.status).toBe("running");

    // Second persist: step s1 transitions to "completed"
    expect(pc[1].steps.filter((s) => s.status === "completed").length).toBe(1);
    expect(pc[1].steps.find((s) => s.id === "s1")!.status).toBe("completed");

    // After step 3 completes (6th persist call — pairs: [0,1], [2,3], [4,5])
    expect(pc[5].steps.filter((s) => s.status === "completed").length).toBe(3);

    // After step 5 completes (10th persist call — pairs: [0..1], [2..3], [4..5], [6..7], [8..9])
    expect(pc[9].steps.filter((s) => s.status === "completed").length).toBe(5);

    // Final persist call sets queue status to "completed"
    const last = pc[pc.length - 1];
    expect(last.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 5. Handoff chaining between steps
  // -------------------------------------------------------------------------

  test("handoff chaining — each dispatcher receives previous step handoff", async () => {
    const handoffs: Record<string, Record<string, unknown>> = {
      "step-1": { artifact: "schema.sql", status: "created" },
      "step-2": { artifact: "migrations.ts", status: "generated" },
      "step-3": { artifact: "api-routes.ts", status: "scaffolded" },
      "step-4": { artifact: "tests.spec.ts", status: "written" },
      "step-5": { artifact: "deploy.yml", status: "configured" },
    };

    harness = createHarness({
      stepCount: 5,
      worker: { handoffByStepId: handoffs },
    });

    await harness.executor.run();

    const calls = harness.dispatcherOpts.calls!;
    expect(calls).toHaveLength(5);

    // First dispatcher call should have no previousHandoff
    expect(calls[0].context).not.toHaveProperty("previousHandoff");

    // Each subsequent dispatcher call should receive the previous step's handoff data
    for (let i = 1; i < 5; i++) {
      const ctx = calls[i].context as { previousHandoff: Record<string, unknown> };
      expect(ctx.previousHandoff).toBeDefined();

      const prevStepId = `step-${i}`; // step-1 for calls[1], step-2 for calls[2], etc.
      expect(ctx.previousHandoff).toEqual(handoffs[prevStepId]);
    }
  });
});
