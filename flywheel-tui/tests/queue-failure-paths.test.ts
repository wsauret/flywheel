import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";

describe("queue executor failure paths", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Worker crash on step 3 of 5
  // -------------------------------------------------------------------------

  test("worker crash on step 3 marks it failed and stops queue", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
      makeStep({ id: "step-4" }),
      makeStep({ id: "step-5" }),
    ];

    harness = createHarness({
      steps,
      worker: { failOnStepIds: new Set(["step-3"]) },
    });

    const result = await harness.executor.run();

    // Step 3 is failed
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("failed");

    // Queue is failed
    expect(harness.queue.status).toBe("failed");

    // Steps 4 and 5 remain pending
    const step4 = harness.queue.steps.find((s) => s.id === "step-4")!;
    const step5 = harness.queue.steps.find((s) => s.id === "step-5")!;
    expect(step4.status).toBe("pending");
    expect(step5.status).toBe("pending");

    // Queue was persisted
    const persisted = await harness.persistence.load();
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("failed");

    // Events emitted
    const stepFailed = harness.events.ofType("queue:step-failed");
    expect(stepFailed.length).toBeGreaterThanOrEqual(1);
    expect(stepFailed.some((e) => e.stepId === "step-3")).toBe(true);

    const queueFailed = harness.events.ofType("queue:failed");
    expect(queueFailed.length).toBeGreaterThanOrEqual(1);

    // Result
    expect(result.completed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Evaluator fails, revision succeeds
  // -------------------------------------------------------------------------

  test("evaluator fails once then passes on revision", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
    ];

    const evalCalls: typeof harness.evaluatorOpts extends null ? never : NonNullable<typeof harness.evaluatorOpts>["calls"] = [];

    harness = createHarness({
      steps,
      evaluator: { failCountByStepId: { "step-2": 1 }, calls: evalCalls },
      maxRevisions: 2,
      worker: {
        handoffByStepId: {
          "step-1": { result: "alpha" },
          "step-2": { result: "beta" },
          "step-3": { result: "gamma" },
        },
      },
    });

    const result = await harness.executor.run();

    // Step 2 completes (after 1 revision)
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("completed");

    // evaluator:revision-requested was emitted
    const revisionEvents = harness.events.ofType("evaluator:revision-requested");
    expect(revisionEvents.length).toBeGreaterThanOrEqual(1);

    // All 3 steps complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Worker called 4 times total: 1 for step-1, 2 for step-2 (original + revision), 1 for step-3
    expect(harness.workerOpts.calls!.length).toBe(4);

    // Evaluator tracks all 4 parameters — verify evaluationCriteria and handoffData
    expect(evalCalls!.length).toBeGreaterThanOrEqual(3); // 3 steps evaluated (step-2 evaluated twice)

    // evaluationCriteria comes from the mock dispatcher which returns null
    for (const call of evalCalls!) {
      expect(call).toHaveProperty("evaluationCriteria");
      expect(call.evaluationCriteria).toBeNull();
    }

    // handoffData should contain the data the mock worker wrote
    for (const call of evalCalls!) {
      expect(call).toHaveProperty("handoffData");
    }
    // step-2 evaluator calls should receive the handoff data from step-2's worker
    const step2EvalCalls = evalCalls!.filter((c) => c.step.id === "step-2");
    expect(step2EvalCalls.length).toBe(2); // fail + pass
    for (const call of step2EvalCalls) {
      expect(call.handoffData).toEqual({ result: "beta" });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Evaluator fails, all revisions exhausted
  // -------------------------------------------------------------------------

  test("evaluator always fails exhausts revisions and marks step failed", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
    ];

    harness = createHarness({
      steps,
      evaluator: { failOnStepIds: new Set(["step-2"]) },
      maxRevisions: 2,
    });

    const result = await harness.executor.run();

    // Worker invoked 3 times for step-2: original + 2 revisions
    const step2Calls = harness.workerOpts.calls!.filter(
      (c) => c.step.id === "step-2",
    );
    expect(step2Calls.length).toBe(3);

    // Step 2 is failed
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("failed");

    // Queue stopped
    expect(result.completed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Evaluator transport error (graceful degradation)
  // -------------------------------------------------------------------------

  test("evaluator transport error degrades gracefully and continues", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
    ];

    harness = createHarness({
      steps,
      evaluator: { transportErrorOnStepIds: new Set(["step-2"]) },
    });

    const result = await harness.executor.run();

    // Step 2 completes anyway
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("completed");

    // evaluator:failed event emitted
    const evalFailed = harness.events.ofType("evaluator:failed");
    expect(evalFailed.length).toBeGreaterThanOrEqual(1);

    // Step 3 proceeds and completes
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("completed");

    // All 3 steps complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 5. Budget exhaustion before step 3
  // -------------------------------------------------------------------------

  test("budget exhaustion pauses queue before step 3", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
      makeStep({ id: "step-4" }),
      makeStep({ id: "step-5" }),
    ];

    harness = createHarness({
      steps,
      budgetChecker: { exhaustAfterChecks: 2 },
    });

    const result = await harness.executor.run();

    // Steps 1-2 complete
    const step1 = harness.queue.steps.find((s) => s.id === "step-1")!;
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step1.status).toBe("completed");
    expect(step2.status).toBe("completed");

    // Step 3 never started
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("pending");

    // Queue status paused
    expect(harness.queue.status).toBe("paused");

    // queue:failed event with budget_exhausted reason
    const queueFailed = harness.events.ofType("queue:failed");
    expect(queueFailed.length).toBeGreaterThanOrEqual(1);
    expect(queueFailed.some((e) => e.reason.includes("budget_exhausted"))).toBe(true);

    // Result
    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 6. Abort mid-step
  // -------------------------------------------------------------------------

  test("abort mid-step reverts running step to pending and pauses", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
      makeStep({ id: "step-4" }),
      makeStep({ id: "step-5" }),
    ];

    harness = createHarness({
      steps,
      worker: { delayByStepId: { "step-2": 200 } },
    });

    const runPromise = harness.executor.run();
    setTimeout(() => harness.executor.abort(), 50);
    const result = await runPromise;

    // Step 2 reverted to pending (not failed)
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("pending");

    // Queue paused
    expect(harness.queue.status).toBe("paused");

    // Result
    expect(result.completed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. Graceful shutdown between steps
  // -------------------------------------------------------------------------

  test("graceful shutdown finishes current step then stops", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1" }),
      makeStep({ id: "step-2" }),
      makeStep({ id: "step-3" }),
      makeStep({ id: "step-4" }),
      makeStep({ id: "step-5" }),
    ];

    harness = createHarness({
      steps,
      worker: { delayByStepId: { "step-2": 100 } },
    });

    const runPromise = harness.executor.run();
    setTimeout(() => harness.executor.requestShutdown(), 50);
    const result = await runPromise;

    // Step 2 completes normally
    const step2 = harness.queue.steps.find((s) => s.id === "step-2")!;
    expect(step2.status).toBe("completed");

    // Step 3 never starts
    const step3 = harness.queue.steps.find((s) => s.id === "step-3")!;
    expect(step3.status).toBe("pending");

    // Queue paused
    expect(harness.queue.status).toBe("paused");

    // Result
    expect(result.stepsCompleted).toBe(2);
  });
});
