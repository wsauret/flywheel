// ---------------------------------------------------------------------------
// Integration Tests — Sprint Hook Wiring (Phase 6)
// ---------------------------------------------------------------------------
//
// Validates end-to-end sprint hook wiring through the executor:
//   1. Sprint queue: work fails -> hook inserts retry -> passes on retry -> done
//   2. Sprint queue: all iterations fail -> escalation steps inserted
//   3. Non-sprint queue: sprint hook is NOT attached (no side effects)
//   4. externalHooks wired through buildExecutorDeps composite hook
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";
import { createCompositeHook } from "../src/workflows/queue/shared/hooks";
import { createSprintHook } from "../src/workflows/queue/steps/sprint/hooks";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types";

describe("sprint hook wiring", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Work fails -> sprint hook inserts retry -> passes on retry -> done
  // -------------------------------------------------------------------------

  test("sprint hook inserts retry step after failure, succeeds on retry", async () => {
    resetStepCounter();

    // Create a sprint-hinted work step
    const sprintStep = makeStep({
      id: "sprint-work-1",
      type: "work",
      title: "Sprint work (iteration 1)",
      dispatcherHint: SPRINT_HINT,
    });

    // Create sprint hook with config
    const { hook, getState } = createSprintHook({
      max_iterations: 3,
      escalate_to_full: true,
      escalate_on_stuck: false,
    });

    // Worker fails on first sprint step, succeeds on all others (including retry)
    harness = createHarness({
      steps: [sprintStep],
      worker: { failOnStepIds: new Set(["sprint-work-1"]) },
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // The sprint hook should have inserted a retry step
    expect(harness.queue.steps.length).toBeGreaterThanOrEqual(2);

    // The retry step should have SPRINT_HINT
    const retryStep = harness.queue.steps[1];
    expect(retryStep).toBeDefined();
    expect(retryStep.dispatcherHint).toBe(SPRINT_HINT);
    expect(retryStep.status).toBe("completed");

    // Sprint state: completed on retry (iteration 2 passed)
    const state = getState();
    expect(state.iterationCount).toBe(2);
    expect(state.status).toBe("completed");

    // Overall execution completed
    expect(result.completed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. All iterations fail -> escalation steps inserted
  // -------------------------------------------------------------------------

  test("sprint hook escalates after max iterations exhausted", async () => {
    resetStepCounter();

    const sprintStep = makeStep({
      id: "sprint-work-1",
      type: "work",
      title: "Sprint work (iteration 1)",
      dispatcherHint: SPRINT_HINT,
    });

    const { hook, getState } = createSprintHook({
      max_iterations: 2,
      escalate_to_full: true,
      escalate_on_stuck: false,
    });

    // Evaluator fails ONLY sprint-hinted steps. Escalation steps (plan, work, review)
    // have no dispatcherHint, so the evaluator passes them.
    harness = createHarness({
      steps: [sprintStep],
      onStepCompleted: hook,
      evaluatorFn: async (step, _output, _criteria, _handoff) => {
        if (step.dispatcherHint === SPRINT_HINT) {
          return {
            passed: false,
            skipped: false,
            transportError: false,
            reason: "Sprint work not good enough",
            feedback: "Try again with a different approach",
            suggestions: [],
            cyclesUsed: 1,
          };
        }
        return {
          passed: true,
          skipped: false,
          transportError: false,
          reason: null,
          feedback: null,
          suggestions: [],
          cyclesUsed: 1,
        };
      },
      maxRevisions: 0, // No revisions — fail immediately
    });

    const result = await harness.executor.run();

    // Sprint state: escalated after 2 iterations
    const state = getState();
    expect(state.iterationCount).toBe(2);
    expect(state.status).toBe("escalated");
    expect(state.reason).toBe("Max iterations reached");

    // Escalation steps should have been inserted (plan, work, review)
    const escalationSteps = harness.queue.steps.filter(
      (s) => s.title.startsWith("Escalation:"),
    );
    expect(escalationSteps.length).toBe(3);
    expect(escalationSteps.map((s) => s.type)).toEqual(["plan", "work", "review"]);

    // Sprint pauses after exhausting iterations — escalation steps are pending for resume
    expect(result.completed).toBe(false);
    expect(escalationSteps.every((s) => s.status === "pending")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Non-sprint steps are ignored by the sprint hook
  // -------------------------------------------------------------------------

  test("sprint hook ignores non-sprint steps", async () => {
    resetStepCounter();

    const normalStep = makeStep({
      id: "normal-work-1",
      type: "work",
      title: "Normal work step",
      // No dispatcherHint — not a sprint step
    });

    const { hook, getState } = createSprintHook({
      max_iterations: 3,
      escalate_to_full: true,
      escalate_on_stuck: false,
    });

    harness = createHarness({
      steps: [normalStep],
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Sprint hook should not have fired
    const state = getState();
    expect(state.iterationCount).toBe(0);
    expect(state.status).toBe("running");

    // Normal step should have completed
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. compositeHook with externalHooks wires through correctly
  // -------------------------------------------------------------------------

  test("createCompositeHook passes external hooks to composite", async () => {
    resetStepCounter();

    const sprintStep = makeStep({
      id: "sprint-work-1",
      type: "work",
      title: "Sprint work (iteration 1)",
      dispatcherHint: SPRINT_HINT,
    });

    const { hook: sprintHook, getState } = createSprintHook({
      max_iterations: 3,
      escalate_to_full: true,
      escalate_on_stuck: false,
    });

    // Simulate what buildExecutorDeps does: create composite with external hooks
    const compositeHook = createCompositeHook([sprintHook]);

    harness = createHarness({
      steps: [sprintStep],
      worker: { failOnStepIds: new Set(["sprint-work-1"]) },
      onStepCompleted: compositeHook,
    });

    const result = await harness.executor.run();

    // Sprint hook should have been triggered via composite
    const state = getState();
    expect(state.iterationCount).toBeGreaterThanOrEqual(1);

    // Retry should have been inserted and completed
    expect(harness.queue.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.completed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Mixed queue: sprint + non-sprint steps coexist
  // -------------------------------------------------------------------------

  test("mixed queue with sprint and non-sprint steps", async () => {
    resetStepCounter();

    const planStep = makeStep({
      id: "plan-1",
      type: "plan",
      title: "Plan step",
    });
    const sprintStep = makeStep({
      id: "sprint-work-1",
      type: "work",
      title: "Sprint work (iteration 1)",
      dispatcherHint: SPRINT_HINT,
    });
    const reviewStep = makeStep({
      id: "review-1",
      type: "review",
      title: "Review step",
    });

    const { hook, getState } = createSprintHook({
      max_iterations: 3,
      escalate_to_full: true,
      escalate_on_stuck: false,
    });

    // Worker fails only on the original sprint step
    harness = createHarness({
      steps: [planStep, sprintStep, reviewStep],
      worker: { failOnStepIds: new Set(["sprint-work-1"]) },
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Sprint hook should have inserted a retry after sprint-work-1
    const state = getState();
    expect(state.iterationCount).toBe(2);
    expect(state.status).toBe("completed");

    // Queue should have grown: plan, sprint-work-1(failed), retry(completed), review
    expect(harness.queue.steps.length).toBe(4);

    // Plan and review should be completed
    expect(harness.queue.steps[0].status).toBe("completed");
    expect(harness.queue.steps[harness.queue.steps.length - 1].status).toBe("completed");

    // All steps processed
    expect(result.completed).toBe(true);
  });
});
