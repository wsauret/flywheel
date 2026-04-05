// ---------------------------------------------------------------------------
// Integration Tests — Queue Crash Recovery and Resume (Ticket 1.4)
// ---------------------------------------------------------------------------
//
// Validates crash recovery and resume behavior of the step executor:
//   1. Resume from step 3 — skips already-completed steps
//   2. Resume after abort — re-executes interrupted step
//   3. Resume preserves accumulated context — seeded data flows to dispatcher
//   4. Queue file corruption recovery — returns null, does not crash
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";
import type { Queue } from "../src/queue/types";
import { resolveSessionFile } from "../src/config/paths";

describe("queue crash recovery and resume", () => {
  const harnesses: Harness[] = [];

  function tracked(h: Harness): Harness {
    harnesses.push(h);
    return h;
  }

  afterEach(() => {
    for (const h of harnesses) {
      h.cleanup();
    }
    harnesses.length = 0;
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Resume from step 3 — only pending steps are executed
  // -------------------------------------------------------------------------

  test("resume from step 3 — skips completed steps, executes remaining", async () => {
    resetStepCounter();
    const steps = makeSteps(5);

    const queue: Queue = {
      steps: [
        { ...steps[0], status: "completed" },
        { ...steps[1], status: "completed" },
        { ...steps[2], status: "pending" },
        { ...steps[3], status: "pending" },
        { ...steps[4], status: "pending" },
      ],
      cursor: 2,
      status: "running",
      mutationLog: [],
    };

    const harness = tracked(createHarness({ queue }));
    const result = await harness.executor.run();

    // Execution should complete successfully
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);
    expect(result.stepsTotal).toBe(5);

    // Dispatcher should only be called for steps 3-5 (the 3 pending ones)
    expect(harness.dispatcherOpts.calls).toHaveLength(3);

    // Worker should only be called for steps 3-5
    expect(harness.workerOpts.calls).toHaveLength(3);

    // Steps 1-2 should remain completed (not re-executed)
    expect(harness.queue.steps[0].status).toBe("completed");
    expect(harness.queue.steps[1].status).toBe("completed");

    // Steps 3-5 should now be completed
    expect(harness.queue.steps[2].status).toBe("completed");
    expect(harness.queue.steps[3].status).toBe("completed");
    expect(harness.queue.steps[4].status).toBe("completed");

    // All 5 steps should be completed
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Queue overall status should be completed
    expect(harness.queue.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 2. Resume after abort — interrupted step re-executes
  // -------------------------------------------------------------------------

  test("resume after abort — step 3 re-executes, steps 1-2 are not re-run", async () => {
    resetStepCounter();

    // First run: 5 steps, step 3 is slow so we can abort mid-execution
    const harness1 = tracked(
      createHarness({
        stepCount: 5,
        worker: {
          delayByStepId: { "step-3": 200 },
        },
      }),
    );

    // Abort after 50ms — step 3 should be in-flight
    const abortTimer = setTimeout(() => harness1.executor.abort(), 50);

    const result1 = await harness1.executor.run();
    clearTimeout(abortTimer);

    // First run should NOT have completed
    expect(result1.completed).toBe(false);

    // Steps 1-2 should be completed
    expect(harness1.queue.steps[0].status).toBe("completed");
    expect(harness1.queue.steps[1].status).toBe("completed");

    // Step 3 should be reverted to pending by abort handler
    expect(harness1.queue.steps[2].status).toBe("pending");

    // Steps 4-5 should still be pending
    expect(harness1.queue.steps[3].status).toBe("pending");
    expect(harness1.queue.steps[4].status).toBe("pending");

    // Load the persisted queue (crash recovery marks running -> pending)
    const loadedQueue = await harness1.persistence.load();
    expect(loadedQueue).not.toBeNull();

    // Create a second executor with the persisted queue
    const harness2 = tracked(createHarness({ queue: loadedQueue! }));
    const result2 = await harness2.executor.run();

    // Second run should complete successfully
    expect(result2.completed).toBe(true);
    expect(result2.stepsCompleted).toBe(5);

    // Dispatcher in the second harness should be called for steps 3-5 only
    expect(harness2.dispatcherOpts.calls).toHaveLength(3);

    // All steps should now be completed
    for (const step of harness2.queue.steps) {
      expect(step.status).toBe("completed");
    }
  });

  // -------------------------------------------------------------------------
  // 3. Resume preserves accumulated context
  // -------------------------------------------------------------------------

  test("resume preserves accumulated context — step 3 dispatcher receives seeded data", async () => {
    resetStepCounter();
    const steps = makeSteps(5);

    // Build a queue where steps 1-2 are completed, steps 3-5 pending
    const queue: Queue = {
      steps: [
        { ...steps[0], status: "completed" },
        { ...steps[1], status: "completed" },
        { ...steps[2], status: "pending" },
        { ...steps[3], status: "pending" },
        { ...steps[4], status: "pending" },
      ],
      cursor: 2,
      status: "running",
      mutationLog: [],
    };

    const harness = tracked(createHarness({ queue }));

    // Seed the accumulator with data from steps 1-2 (simulating a resumed
    // session where steps 1-2 already ran and produced handoff data)
    harness.accumulator.accumulate({
      stepId: "step-1",
      stepType: "work",
      stepTitle: "Step 1",
      handoff: { result: "step-1-output" },
    });
    harness.accumulator.accumulate({
      stepId: "step-2",
      stepType: "work",
      stepTitle: "Step 2",
      handoff: { result: "step-2-output" },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(5);

    // Dispatcher should be called 3 times (steps 3-5 only)
    const calls = harness.dispatcherOpts.calls!;
    expect(calls).toHaveLength(3);

    // Step 3's dispatcher context should include accumulated data from steps 1-2
    const step3Context = calls[0].context as {
      totalSteps: number;
      recentHandoffs: Array<{ stepId: string; handoff: Record<string, unknown> }>;
    };

    // totalSteps should be at least 2 (the seeded entries)
    expect(step3Context.totalSteps).toBeGreaterThanOrEqual(2);

    // recentHandoffs should contain data from steps 1-2
    expect(step3Context.recentHandoffs.length).toBeGreaterThanOrEqual(2);
    const recentIds = step3Context.recentHandoffs.map((h) => h.stepId);
    expect(recentIds).toContain("step-1");
    expect(recentIds).toContain("step-2");

    // Verify the actual handoff data from the seeded steps
    const step1Handoff = step3Context.recentHandoffs.find((h) => h.stepId === "step-1");
    expect(step1Handoff?.handoff).toEqual({ result: "step-1-output" });

    const step2Handoff = step3Context.recentHandoffs.find((h) => h.stepId === "step-2");
    expect(step2Handoff?.handoff).toEqual({ result: "step-2-output" });
  });

  // -------------------------------------------------------------------------
  // 4. Queue file corruption recovery — returns null
  // -------------------------------------------------------------------------

  test("corrupt queue file returns null from persistence.load()", async () => {
    resetStepCounter();

    // Create a harness just for its persistence instance and session directory
    const harness = tracked(createHarness({ stepCount: 1 }));

    // Write invalid JSON to the queue file path
    const queuePath = resolveSessionFile(
      harness.sessionId,
      "queue",
      harness.tmpDir,
    );
    await Bun.write(queuePath, "not valid json {{{");

    // persistence.load() should return null, not throw
    const loaded = await harness.persistence.load();
    expect(loaded).toBeNull();
  });
});
