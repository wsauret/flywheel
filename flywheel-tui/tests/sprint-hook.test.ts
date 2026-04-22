// ---------------------------------------------------------------------------
// Sprint Hook — Unit Tests
// ---------------------------------------------------------------------------
//
// Validates:
//   - No-op for steps without SPRINT_HINT
//   - Completed step records iteration, returns stop
//   - Failed step under max iterations inserts retry, returns continue
//   - Failed step at max iterations inserts escalation [plan, work, review]
//   - Stuck detection triggers early escalation
//   - Post-turn failure (null handoffData) still retries with null eval feedback
//   - insertAfter called BEFORE hook returns
//   - New retry step has dispatcherHint: SPRINT_HINT and evaluationCriteria
//   - normalizeFeedback strips timestamps, line numbers, durations
//   - isStuck helper
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import {
  createSprintHook,
  isStuck,
} from "../src/workflows/queue/steps/sprint/hooks";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types";
import type { SprintConfig } from "../src/workflows/queue/steps/sprint/types";
import { createQueue } from "../src/workflows/queue/queue";
import type { Step, Queue } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSprintConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    max_iterations: 5,
    detect_stuck: false,
    dispatcher: {},
    evaluator: {},
    worker: {},
    ...overrides,
  };
}

function makeSprintStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Sprint work (iteration 1)",
    status: "completed",
    dispatcherHint: SPRINT_HINT,
    evaluationCriteria: "All tests pass, no regressions",
    ...overrides,
  };
}

function makeNonSprintStep(): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Regular work step",
    status: "completed",
  };
}

function makeQueueWithStep(step: Step): Queue {
  return createQueue([step]);
}

// ---------------------------------------------------------------------------
// normalizeFeedback
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isStuck
// ---------------------------------------------------------------------------

describe("isStuck", () => {
  test("returns false with < 2 records", () => {
    expect(isStuck([])).toBe(false);
    expect(isStuck([{ iteration: 1, workerSummary: "pass" }])).toBe(false);
  });

  test("returns false when feedback is missing", () => {
    expect(
      isStuck([
        { iteration: 1, workerSummary: "a" },
        { iteration: 2, workerSummary: "b" },
      ]),
    ).toBe(false);
  });

  test("returns false when feedback differs", () => {
    expect(
      isStuck([
        { iteration: 1, workerSummary: "a", evalFeedback: "error A" },
        { iteration: 2, workerSummary: "b", evalFeedback: "error B" },
      ]),
    ).toBe(false);
  });

  test("returns true when feedback is identical", () => {
    expect(
      isStuck([
        { iteration: 1, workerSummary: "a", evalFeedback: "tests fail" },
        { iteration: 2, workerSummary: "b", evalFeedback: "tests fail" },
      ]),
    ).toBe(true);
  });

  test("returns true when feedback matches after normalization", () => {
    expect(
      isStuck([
        {
          iteration: 1,
          workerSummary: "a",
          evalFeedback: "Error at 2026-01-01T00:00:00 in foo.ts:10:1 (100ms)",
        },
        {
          iteration: 2,
          workerSummary: "b",
          evalFeedback: "Error at 2026-01-02T12:00:00 in foo.ts:20:5 (500ms)",
        },
      ]),
    ).toBe(true);
  });

  test("returns false when one iteration passed", () => {
    expect(
      isStuck([
        {
          iteration: 1,
          workerSummary: "a",
          evalFeedback: "tests fail",
          nativeCheckPassed: true,
        },
        { iteration: 2, workerSummary: "b", evalFeedback: "tests fail" },
      ]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exhaustion (tested through the hook — when max iterations reached)
// ---------------------------------------------------------------------------

describe("exhaustion via hook", () => {
  test("max iterations reached stops execution", async () => {
    const config = makeSprintConfig({ max_iterations: 1 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(false);
    // No additional steps inserted — just stops
    expect(queue.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — no-op guard
// ---------------------------------------------------------------------------

describe("createSprintHook — no-op guard", () => {
  test("step without SPRINT_HINT returns no-op", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeNonSprintStep();
    const queue = makeQueueWithStep(step);
    // Mark step as completed in queue for realism
    queue.steps[0].status = "completed";

    const result = await hook(step, "completed", queue, { summary: "done" });
    expect(result.continueExecution).toBe(false);
  });

  test("queue unchanged after no-op", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeNonSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "completed";

    const result = await hook(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
    // No steps inserted
    expect(queue.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — completed
// ---------------------------------------------------------------------------

describe("createSprintHook — completed step", () => {
  test("returns stop on completed sprint step", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "completed";

    const result = await hook(step, "completed", queue, {
      summary: "All tests pass",
    });

    expect(result.continueExecution).toBe(false);
    // No retry steps inserted on success
    expect(queue.steps).toHaveLength(1);
  });

  test("ignores subsequent calls after completion", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step1 = makeSprintStep();
    const step2 = makeSprintStep();
    const queue = createQueue([step1, step2]);
    queue.steps[0].status = "completed";

    await hook(step1, "completed", queue, { summary: "done" });
    const result = await hook(step2, "failed", queue, { summary: "fail" });

    // After completion, subsequent calls are no-ops
    expect(result.continueExecution).toBe(false);
    // No retry steps inserted
    expect(queue.steps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — failed, under max iterations
// ---------------------------------------------------------------------------

describe("createSprintHook — failed, under max", () => {
  test("inserts new work step and returns continue", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, {
      summary: "Tests failed",
      eval_feedback: "3 tests failing",
    });

    expect(result.continueExecution).toBe(true);

    // Verify retry step was inserted
    expect(queue.steps).toHaveLength(2);
    const retryStep = queue.steps[1];
    expect(retryStep.type).toBe("work");
    expect(retryStep.dispatcherHint).toBe(SPRINT_HINT);
    // Retry step gets rebuilt criteria with history for test-weakening detection
    expect(retryStep.evaluationCriteria).toContain("Sprint Mode: Evaluation Criteria");
    expect(retryStep.evaluationCriteria).toContain("Test Weakening Detection");
    expect(retryStep.evaluationCriteria).toContain("3 tests failing");
    expect(retryStep.status).toBe("pending");
  });

  test("retry step has correct iteration in title", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    await hook(step, "failed", queue, { summary: "fail" });

    const retryStep = queue.steps[1];
    expect(retryStep.title).toContain("iteration 2");
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — failed, at max iterations
// ---------------------------------------------------------------------------

describe("createSprintHook — failed, at max iterations", () => {
  test("stops at max iterations without inserting steps", async () => {
    const config = makeSprintConfig({ max_iterations: 1 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, {
      summary: "fail",
      eval_feedback: "tests broken",
    });

    expect(result.continueExecution).toBe(false);
    // No extra steps inserted — just stops
    expect(queue.steps).toHaveLength(1);
  });

  test("reaches max after multiple iterations", async () => {
    const config = makeSprintConfig({ max_iterations: 3 });
    const { hook } = createSprintHook(config);

    // Build queue with 3 sprint steps
    const steps = [makeSprintStep(), makeSprintStep(), makeSprintStep()];
    const queue = createQueue(steps);

    // Fail iteration 1 — should insert retry
    queue.steps[0].status = "failed";
    const r1 = await hook(steps[0], "failed", queue, {
      summary: "fail 1",
      eval_feedback: "error A",
    });
    expect(r1.continueExecution).toBe(true);

    // Find the inserted retry step
    const retry1 = queue.steps.find(
      (s) => s.title.includes("iteration 2") && s.status === "pending",
    )!;
    expect(retry1).toBeDefined();
    retry1.status = "failed";

    // Fail iteration 2 — should insert another retry
    const r2 = await hook(retry1, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "error B",
    });
    expect(r2.continueExecution).toBe(true);

    // Find the next retry step
    const retry2 = queue.steps.find(
      (s) => s.title.includes("iteration 3") && s.status === "pending",
    )!;
    expect(retry2).toBeDefined();
    retry2.status = "failed";

    // Iteration 3 = max_iterations — should stop
    const r3 = await hook(retry2, "failed", queue, {
      summary: "fail 3",
      eval_feedback: "error C",
    });
    expect(r3.continueExecution).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — stuck detection
// ---------------------------------------------------------------------------

describe("createSprintHook — stuck detection", () => {
  test("two identical feedbacks trigger early stop", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: true,
    });
    const { hook } = createSprintHook(config);

    const step1 = makeSprintStep();
    const queue = makeQueueWithStep(step1);
    queue.steps[0].status = "failed";

    // First failure — should continue
    const r1 = await hook(step1, "failed", queue, {
      summary: "fail 1",
      eval_feedback: "TypeError in handler",
    });
    expect(r1.continueExecution).toBe(true);

    // Find retry step
    const retry = queue.steps.find(
      (s) => s.status === "pending" && s.dispatcherHint === SPRINT_HINT,
    )!;
    expect(retry).toBeDefined();
    retry.status = "failed";

    // Second failure with same feedback — stuck, should stop
    const result = await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "TypeError in handler",
    });

    expect(result.continueExecution).toBe(false);
  });

  test("stuck detection respects normalization", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: true,
    });
    const { hook } = createSprintHook(config);

    const step1 = makeSprintStep();
    const queue = makeQueueWithStep(step1);
    queue.steps[0].status = "failed";

    // First failure with timestamps/line numbers
    await hook(step1, "failed", queue, {
      summary: "fail 1",
      eval_feedback: "Error at 2026-01-01T00:00:00 in foo.ts:10:5 (100ms)",
    });

    const retry = queue.steps.find(
      (s) => s.status === "pending" && s.dispatcherHint === SPRINT_HINT,
    )!;
    retry.status = "failed";

    // Same error but different timestamps/lines — stuck, should stop
    const result = await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "Error at 2026-02-15T12:30:00 in foo.ts:20:3 (500ms)",
    });

    expect(result.continueExecution).toBe(false);
  });

  test("no stuck detection when detect_stuck is false", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: false,
    });
    const { hook } = createSprintHook(config);

    const step1 = makeSprintStep();
    const queue = makeQueueWithStep(step1);
    queue.steps[0].status = "failed";

    await hook(step1, "failed", queue, {
      summary: "fail 1",
      eval_feedback: "same error",
    });

    const retry = queue.steps.find(
      (s) => s.status === "pending" && s.dispatcherHint === SPRINT_HINT,
    )!;
    retry.status = "failed";

    // With detect_stuck=false, identical feedback should still continue
    const result = await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "same error",
    });

    expect(result.continueExecution).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — post-turn failure (null handoffData)
// ---------------------------------------------------------------------------

describe("createSprintHook — null handoffData", () => {
  test("still retries with null handoffData", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, null);

    expect(result.continueExecution).toBe(true);
    // Still inserts retry step
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[1].dispatcherHint).toBe(SPRINT_HINT);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — insertAfter called BEFORE hook returns
// ---------------------------------------------------------------------------

describe("createSprintHook — insertAfter timing", () => {
  test("retry step exists in queue when hook returns", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    // After hook returns, the retry step must already be in the queue
    const result = await hook(step, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(true);
    // Queue was mutated synchronously inside hook, before return
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps.length).toBeGreaterThanOrEqual(1);
    expect(pendingSteps[0].dispatcherHint).toBe(SPRINT_HINT);
  });

  test("exhaustion stops without inserting additional steps", async () => {
    const config = makeSprintConfig({ max_iterations: 1 });
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(false);
    // No additional steps inserted
    expect(queue.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — new step properties
// ---------------------------------------------------------------------------

describe("createSprintHook — retry step properties", () => {
  test("retry step has dispatcherHint SPRINT_HINT", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    await hook(step, "failed", queue, { summary: "fail" });

    const retry = queue.steps[1];
    expect(retry.dispatcherHint).toBe(SPRINT_HINT);
  });

  test("retry step rebuilds criteria with iteration history", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeSprintStep({ evaluationCriteria: "All unit tests pass and no type errors" });
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    await hook(step, "failed", queue, { summary: "fail" });

    const retry = queue.steps[1];
    // Criteria are rebuilt with history, not copied from the original step
    expect(retry.evaluationCriteria).toContain("Sprint Mode: Evaluation Criteria");
    expect(retry.evaluationCriteria).toContain("Prior Iteration History");
    expect(retry.evaluationCriteria).toContain("Iteration 1");
  });

  test("retry step has brief description (not full history)", async () => {
    const config = makeSprintConfig();
    const { hook } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    await hook(step, "failed", queue, {
      summary: "fail",
      eval_feedback: "tests failed for missing error handler",
    });

    const retry = queue.steps[1];
    expect(retry.description).toContain("Sprint retry");
    expect(retry.description).toContain("tests failed for missing error handler");
    // Should be brief — one line
    expect(retry.description!.split("\n")).toHaveLength(1);
  });
});

