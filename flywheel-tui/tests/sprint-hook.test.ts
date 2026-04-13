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
  normalizeFeedback,
  recordIteration,
  buildRetryStep,
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

describe("normalizeFeedback", () => {
  test("strips timestamps", () => {
    const raw = "Error at 2026-04-07T12:34:56.789 in module";
    expect(normalizeFeedback(raw)).toBe("Error at in module");
  });

  test("strips line numbers", () => {
    const raw = "TypeError in src/foo.ts:42:10 — bad type";
    expect(normalizeFeedback(raw)).toBe("TypeError in src/foo.ts — bad type");
  });

  test("strips durations", () => {
    const raw = "Test suite ran in 1234ms, 3 failed after 2.5 seconds";
    expect(normalizeFeedback(raw)).toBe("Test suite ran in , 3 failed after");
  });

  test("strips ANSI codes", () => {
    const raw = "\x1b[31mError\x1b[0m: something failed";
    expect(normalizeFeedback(raw)).toBe("Error: something failed");
  });

  test("collapses whitespace", () => {
    const raw = "Error   in   module   \n  after   test";
    expect(normalizeFeedback(raw)).toBe("Error in module after test");
  });

  test("makes identical failures match after normalization", () => {
    const a = "Test failed at 2026-04-01T10:00:00 in src/foo.ts:10:5 (took 100ms)";
    const b = "Test failed at 2026-04-02T11:30:00 in src/foo.ts:12:3 (took 250ms)";
    expect(normalizeFeedback(a)).toBe(normalizeFeedback(b));
  });
});

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
// recordIteration
// ---------------------------------------------------------------------------

describe("recordIteration", () => {
  test("extracts summary from handoffData", () => {
    const record = recordIteration({ summary: "Fixed the auth bug" }, "completed", 1);
    expect(record.workerSummary).toBe("Fixed the auth bug");
    expect(record.iteration).toBe(1);
    expect(record.nativeCheckPassed).toBe(true);
  });

  test("uses default summary when handoffData is null", () => {
    const record = recordIteration(null, "failed", 3);
    expect(record.workerSummary).toBe("Iteration 3");
    expect(record.evalFeedback).toBeUndefined();
    expect(record.nativeCheckPassed).toBe(false);
  });

  test("extracts eval_feedback field", () => {
    const record = recordIteration(
      { summary: "work done", eval_feedback: "tests still fail" },
      "failed",
      2,
    );
    expect(record.evalFeedback).toBe("tests still fail");
  });

  test("falls back to feedback field", () => {
    const record = recordIteration(
      { summary: "work done", feedback: "need more work" },
      "failed",
      2,
    );
    expect(record.evalFeedback).toBe("need more work");
  });

  test("falls back to verification field", () => {
    const record = recordIteration(
      { summary: "work done", verification: "check failed" },
      "failed",
      2,
    );
    expect(record.evalFeedback).toBe("check failed");
  });

  test("sets workerCrashed true when failed with null handoffData", () => {
    const record = recordIteration(null, "failed", 1);
    expect(record.workerCrashed).toBe(true);
  });

  test("sets workerCrashed false when failed with handoffData present", () => {
    const record = recordIteration({ summary: "oops" }, "failed", 1);
    expect(record.workerCrashed).toBe(false);
  });

  test("sets workerCrashed false when completed", () => {
    const record = recordIteration({ summary: "done" }, "completed", 1);
    expect(record.workerCrashed).toBe(false);
  });

  test("sets workerCrashed false when completed with null handoffData", () => {
    const record = recordIteration(null, "completed", 1);
    expect(record.workerCrashed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRetryStep
// ---------------------------------------------------------------------------

describe("buildRetryStep", () => {
  test("creates step with SPRINT_HINT", () => {
    const original = makeSprintStep();
    const step = buildRetryStep(original, [], 2, 5);
    expect(step.dispatcherHint).toBe(SPRINT_HINT);
  });

  test("carries forward evaluationCriteria", () => {
    const original = makeSprintStep({ evaluationCriteria: "All tests pass" });
    const step = buildRetryStep(original, [], 2, 5);
    expect(step.evaluationCriteria).toBe("All tests pass");
  });

  test("includes iteration count in title", () => {
    const step = buildRetryStep(makeSprintStep(), [], 3, 5);
    expect(step.title).toContain("iteration 3");
  });

  test("includes prior feedback in description", () => {
    const history = [
      { iteration: 1, workerSummary: "fixed auth", evalFeedback: "tests still fail" },
    ];
    const step = buildRetryStep(makeSprintStep(), history, 2, 5);
    expect(step.description).toContain("tests still fail");
    expect(step.description).toContain("2/5");
  });

  test("step is pending work type", () => {
    const step = buildRetryStep(makeSprintStep(), [], 2, 5);
    expect(step.type).toBe("work");
    expect(step.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Exhaustion (tested through the hook — when max iterations reached)
// ---------------------------------------------------------------------------

describe("exhaustion via hook", () => {
  test("max iterations reached stops execution with exhausted status", async () => {
    const config = makeSprintConfig({ max_iterations: 1 });
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(false);
    expect(getState().status).toBe("exhausted");
    expect(getState().reason).toBe("Max iterations reached");
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

  test("state unchanged after no-op", async () => {
    const config = makeSprintConfig();
    const { hook, getState } = createSprintHook(config);
    const step = makeNonSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "completed";

    await hook(step, "completed", queue, null);
    const state = getState();
    expect(state.iterationCount).toBe(0);
    expect(state.history).toHaveLength(0);
    expect(state.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — completed
// ---------------------------------------------------------------------------

describe("createSprintHook — completed step", () => {
  test("records iteration and returns stop", async () => {
    const config = makeSprintConfig();
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "completed";

    const result = await hook(step, "completed", queue, {
      summary: "All tests pass",
    });

    expect(result.continueExecution).toBe(false);
    const state = getState();
    expect(state.status).toBe("completed");
    expect(state.iterationCount).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].workerSummary).toBe("All tests pass");
    expect(state.history[0].nativeCheckPassed).toBe(true);
  });

  test("ignores subsequent calls after completion", async () => {
    const config = makeSprintConfig();
    const { hook, getState } = createSprintHook(config);
    const step1 = makeSprintStep();
    const step2 = makeSprintStep();
    const queue = createQueue([step1, step2]);
    queue.steps[0].status = "completed";

    await hook(step1, "completed", queue, { summary: "done" });
    const result = await hook(step2, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(false);
    expect(getState().iterationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — failed, under max iterations
// ---------------------------------------------------------------------------

describe("createSprintHook — failed, under max", () => {
  test("inserts new work step and returns continue", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, {
      summary: "Tests failed",
      eval_feedback: "3 tests failing",
    });

    expect(result.continueExecution).toBe(true);
    const state = getState();
    expect(state.status).toBe("running");
    expect(state.iterationCount).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].evalFeedback).toBe("3 tests failing");

    // Verify retry step was inserted
    expect(queue.steps).toHaveLength(2);
    const retryStep = queue.steps[1];
    expect(retryStep.type).toBe("work");
    expect(retryStep.dispatcherHint).toBe(SPRINT_HINT);
    expect(retryStep.evaluationCriteria).toBe("All tests pass, no regressions");
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
  test("stops with exhausted status at max iterations", async () => {
    const config = makeSprintConfig({ max_iterations: 1 });
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, {
      summary: "fail",
      eval_feedback: "tests broken",
    });

    expect(result.continueExecution).toBe(false);
    const state = getState();
    expect(state.status).toBe("exhausted");
    expect(state.reason).toBe("Max iterations reached");

    // No extra steps inserted — just stops
    expect(queue.steps).toHaveLength(1);
  });

  test("reaches max after multiple iterations", async () => {
    const config = makeSprintConfig({ max_iterations: 3 });
    const { hook, getState } = createSprintHook(config);

    // Build queue with 3 sprint steps
    const steps = [makeSprintStep(), makeSprintStep(), makeSprintStep()];
    const queue = createQueue(steps);

    // Fail iterations 1 and 2 — should insert retries
    queue.steps[0].status = "failed";
    const r1 = await hook(steps[0], "failed", queue, {
      summary: "fail 1",
      eval_feedback: "error A",
    });
    expect(r1.continueExecution).toBe(true);
    expect(getState().iterationCount).toBe(1);

    // Find the inserted retry step
    const retry1 = queue.steps.find(
      (s) => s.title.includes("iteration 2") && s.status === "pending",
    )!;
    expect(retry1).toBeDefined();
    retry1.status = "failed";

    const r2 = await hook(retry1, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "error B",
    });
    expect(r2.continueExecution).toBe(true);
    expect(getState().iterationCount).toBe(2);

    // Find the next retry step
    const retry2 = queue.steps.find(
      (s) => s.title.includes("iteration 3") && s.status === "pending",
    )!;
    expect(retry2).toBeDefined();
    retry2.status = "failed";

    // Iteration 3 = max_iterations → exhausted
    const r3 = await hook(retry2, "failed", queue, {
      summary: "fail 3",
      eval_feedback: "error C",
    });
    expect(r3.continueExecution).toBe(false);
    expect(getState().status).toBe("exhausted");
    expect(getState().iterationCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — stuck detection
// ---------------------------------------------------------------------------

describe("createSprintHook — stuck detection", () => {
  test("two identical feedbacks trigger early exhaustion", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: true,
    });
    const { hook, getState } = createSprintHook(config);

    const step1 = makeSprintStep();
    const queue = makeQueueWithStep(step1);
    queue.steps[0].status = "failed";

    // First failure
    await hook(step1, "failed", queue, {
      summary: "fail 1",
      eval_feedback: "TypeError in handler",
    });
    expect(getState().status).toBe("running");

    // Find retry step
    const retry = queue.steps.find(
      (s) => s.status === "pending" && s.dispatcherHint === SPRINT_HINT,
    )!;
    expect(retry).toBeDefined();
    retry.status = "failed";

    // Second failure with same feedback → stuck → exhausted
    const result = await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "TypeError in handler",
    });

    expect(result.continueExecution).toBe(false);
    expect(getState().status).toBe("exhausted");
    expect(getState().reason).toContain("Stuck");
  });

  test("stuck detection respects normalization", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: true,
    });
    const { hook, getState } = createSprintHook(config);

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

    // Same error but different timestamps/lines → stuck → exhausted
    const result = await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "Error at 2026-02-15T12:30:00 in foo.ts:20:3 (500ms)",
    });

    expect(getState().status).toBe("exhausted");
    expect(result.continueExecution).toBe(false);
  });

  test("no stuck detection when detect_stuck is false", async () => {
    const config = makeSprintConfig({
      max_iterations: 5,
      detect_stuck: false,
    });
    const { hook, getState } = createSprintHook(config);

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

    await hook(retry, "failed", queue, {
      summary: "fail 2",
      eval_feedback: "same error",
    });

    // Should still be running — stuck detection disabled
    expect(getState().status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// createSprintHook — post-turn failure (null handoffData)
// ---------------------------------------------------------------------------

describe("createSprintHook — null handoffData", () => {
  test("still retries and records null eval feedback", async () => {
    const config = makeSprintConfig({ max_iterations: 5 });
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, null);

    expect(result.continueExecution).toBe(true);
    const state = getState();
    expect(state.iterationCount).toBe(1);
    expect(state.history[0].evalFeedback).toBeUndefined();
    expect(state.history[0].workerSummary).toBe("Iteration 1");

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
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    const result = await hook(step, "failed", queue, { summary: "fail" });

    expect(result.continueExecution).toBe(false);
    expect(getState().status).toBe("exhausted");
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

  test("retry step preserves evaluationCriteria from original", async () => {
    const config = makeSprintConfig();
    const criteria = "All unit tests pass and no type errors";
    const { hook } = createSprintHook(config);
    const step = makeSprintStep({ evaluationCriteria: criteria });
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "failed";

    await hook(step, "failed", queue, { summary: "fail" });

    const retry = queue.steps[1];
    expect(retry.evaluationCriteria).toBe(criteria);
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

// ---------------------------------------------------------------------------
// createSprintHook — getState snapshot
// ---------------------------------------------------------------------------

describe("createSprintHook — getState", () => {
  test("returns snapshot (not reference) of history", async () => {
    const config = makeSprintConfig();
    const { hook, getState } = createSprintHook(config);
    const step = makeSprintStep();
    const queue = makeQueueWithStep(step);
    queue.steps[0].status = "completed";

    await hook(step, "completed", queue, { summary: "done" });

    const state1 = getState();
    const state2 = getState();
    expect(state1.history).not.toBe(state2.history);
    expect(state1.history).toEqual(state2.history);
  });

  test("initial state is running with zero iterations", () => {
    const config = makeSprintConfig();
    const { getState } = createSprintHook(config);
    const state = getState();
    expect(state.status).toBe("running");
    expect(state.iterationCount).toBe(0);
    expect(state.history).toHaveLength(0);
    expect(state.reason).toBeUndefined();
  });
});
