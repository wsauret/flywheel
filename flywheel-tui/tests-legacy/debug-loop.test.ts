// ---------------------------------------------------------------------------
// Debug Queue Handler — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for createDebugQueueHandler(), the queue-based debug fix-verify loop.
// Covers: verify pass, verify fail with retry insertion, max iterations,
// stuck detection, hypothesis tracking, no-op on non-debug steps, and
// inserted step evaluation criteria correctness.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import type { Step, Queue } from "../src/workflows/queue/types";
import { createQueue } from "../src/workflows/queue/queue";
import { createDebugQueueHandler } from "../src/workflows/queue/steps/debug-fix/hooks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Test",
    status: "pending",
    ...overrides,
  };
}

function makeDebugQueue(): Queue {
  return createQueue([
    makeStep({ type: "debug", title: "Investigate", dispatcherHint: "investigate" }),
    makeStep({ type: "debug", title: "Fix", dispatcherHint: "fix" }),
    makeStep({ type: "verify", title: "Verify fix", dispatcherHint: "debug-verify" }),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDebugQueueHandler", () => {
  test("verify step pass → marks debug completed", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();
    const verifyStep = queue.steps[2];

    const result = await handler.onStepCompleted(
      verifyStep,
      "completed",
      queue,
      {
        summary: "All tests pass",
        verification: {
          tests_passed: true,
          test_output_summary: "42/42 pass",
        },
      },
    );

    expect(result.continueExecution).toBe(false);
    expect(handler.getState().completed).toBe(true);
  });

  test("verify step fail → inserts retry [fix, verify] pair", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();
    const fixStep = queue.steps[1];
    const verifyStep = queue.steps[2];

    // First provide fix step handoff
    await handler.onStepCompleted(fixStep, "completed", queue, {
      summary: "Applied fix",
      hypothesis: "Race condition",
    });

    // Then verify fails
    const result = await handler.onStepCompleted(verifyStep, "completed", queue, {
      summary: "Tests still fail",
      verification: {
        tests_passed: false,
        test_output_summary: "1 fail",
      },
    });

    expect(result.continueExecution).toBe(true);
    // Should have inserted 2 more steps
    expect(queue.steps.length).toBe(5);
    expect(queue.steps[3].type).toBe("debug");
    expect(queue.steps[3].dispatcherHint).toBe("fix");
    expect(queue.steps[4].type).toBe("verify");
    expect(queue.steps[4].dispatcherHint).toBe("debug-verify");
  });

  test("max iterations (5) → stops with maxIterationsReached", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();

    // Simulate 5 iterations using actual queue steps.
    // First iteration uses the original fix (index 1) and verify (index 2) steps.
    // Subsequent iterations use steps inserted by the handler.
    for (let i = 0; i < 5; i++) {
      // Find the last fix and verify steps in the queue
      const fixSteps = queue.steps.filter(s => s.type === "debug" && s.dispatcherHint === "fix");
      const verifySteps = queue.steps.filter(s => s.type === "verify" && s.dispatcherHint === "debug-verify");
      const fixStep = fixSteps[fixSteps.length - 1];
      const verifyStep = verifySteps[verifySteps.length - 1];

      await handler.onStepCompleted(fixStep, "completed", queue, {
        summary: `Fix attempt ${i + 1}`,
      });
      const result = await handler.onStepCompleted(verifyStep, "completed", queue, {
        summary: `Fail ${i + 1}`,
        verification: {
          tests_passed: false,
          test_output_summary: `Fail ${i + 1}`,
        },
      });

      if (i < 4) {
        // Should continue (insert retry)
        expect(result.continueExecution).toBe(true);
      } else {
        // 5th iteration → stop
        expect(result.continueExecution).toBe(false);
        expect(handler.getState().maxIterationsReached).toBe(true);
      }
    }

    expect(handler.getState().iterationCount).toBe(5);
  });

  test("stuck detection — identical consecutive failures → early stop", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();

    const sameOutput = {
      summary: "Same error",
      verification: {
        tests_passed: false,
        test_output_summary: "Same error",
      },
    };

    // Iteration 1: use actual queue steps
    const fixStep1 = queue.steps[1]; // original fix step
    const verifyStep1 = queue.steps[2]; // original verify step

    await handler.onStepCompleted(fixStep1, "completed", queue, { summary: "Fix 1" });
    await handler.onStepCompleted(verifyStep1, "completed", queue, sameOutput);

    // After iteration 1 failure, handler inserts new fix+verify pair
    // Iteration 2 — same output, use the newly inserted steps
    const fixStep2 = queue.steps[3]; // inserted fix step
    const verifyStep2 = queue.steps[4]; // inserted verify step

    await handler.onStepCompleted(fixStep2, "completed", queue, { summary: "Fix 2" });
    const result = await handler.onStepCompleted(verifyStep2, "completed", queue, sameOutput);

    expect(result.continueExecution).toBe(false);
    expect(handler.getState().maxIterationsReached).toBe(true);
  });

  test("hypothesis history accumulates across iterations", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();

    // Iteration 1: use actual queue steps
    await handler.onStepCompleted(
      queue.steps[1], // fix step
      "completed",
      queue,
      { summary: "Fix 1", hypothesis: "Race condition in handler" },
    );
    await handler.onStepCompleted(
      queue.steps[2], // verify step
      "completed",
      queue,
      {
        summary: "Fail",
        verification: {
          tests_passed: false,
          test_output_summary: "Fail",
        },
      },
    );

    // Iteration 2: use newly inserted fix step
    await handler.onStepCompleted(
      queue.steps[3], // inserted fix step
      "completed",
      queue,
      { summary: "Fix 2", hypothesis: "Missing await" },
    );

    const state = handler.getState();
    expect(state.iterationHistory).toHaveLength(2);
    expect(state.iterationHistory[0].hypothesis).toBe("Race condition in handler");
    expect(state.iterationHistory[1].hypothesis).toBe("Missing await");
  });

  test("no-op on non-debug/verify steps", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();
    const step = makeStep({ type: "work" });
    const result = await handler.onStepCompleted(step, "completed", queue, {});
    expect(result.continueExecution).toBe(false);
  });

  test("inserted fix steps have correct evaluationCriteria", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();

    await handler.onStepCompleted(
      makeStep({ type: "debug", dispatcherHint: "fix" }),
      "completed",
      queue,
      { summary: "Fix" },
    );
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Fail",
      verification: {
        tests_passed: false,
        test_output_summary: "Fail",
      },
    });

    const insertedFix = queue.steps[3];
    expect(insertedFix.evaluationCriteria).toBe(
      "Fix applied with references documenting the change",
    );
    const insertedVerify = queue.steps[4];
    expect(insertedVerify.evaluationCriteria).toBe(
      "Verification command output shows the issue is resolved",
    );
  });

  test("verify step completed without verification data → treated as pass", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();
    const verifyStep = queue.steps[2];

    const result = await handler.onStepCompleted(verifyStep, "completed", queue, {
      summary: "Looks good",
    });

    expect(result.continueExecution).toBe(false);
    expect(handler.getState().completed).toBe(true);
  });

  test("investigate step is a no-op (no dispatcherHint=fix)", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();
    const investigateStep = queue.steps[0];

    const result = await handler.onStepCompleted(investigateStep, "completed", queue, {
      summary: "Found root cause",
    });

    expect(result.continueExecution).toBe(false);
    expect(handler.getState().iterationCount).toBe(0);
  });

  test("inserted fix steps have correct toolScoping", async () => {
    const handler = createDebugQueueHandler();
    const queue = makeDebugQueue();

    await handler.onStepCompleted(
      makeStep({ type: "debug", dispatcherHint: "fix" }),
      "completed",
      queue,
      { summary: "Fix" },
    );
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Fail",
      verification: { tests_passed: false, test_output_summary: "Fail" },
    });

    const insertedFix = queue.steps[3];
    expect(insertedFix.toolScoping).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
      task: false,
    });
    const insertedVerify = queue.steps[4];
    expect(insertedVerify.toolScoping).toEqual({
      read: true,
      bash: true,
      write: false,
      edit: false,
      task: false,
    });
  });

  test("getState returns a copy of iterationHistory (not a reference)", async () => {
    const handler = createDebugQueueHandler();
    const state1 = handler.getState();
    expect(state1.iterationHistory).toHaveLength(0);

    const queue = makeDebugQueue();
    await handler.onStepCompleted(
      queue.steps[1], // fix step in queue
      "completed",
      queue,
      { summary: "Fix", hypothesis: "test" },
    );

    // state1 should not be mutated
    expect(state1.iterationHistory).toHaveLength(0);
    expect(handler.getState().iterationHistory).toHaveLength(1);
  });
});
