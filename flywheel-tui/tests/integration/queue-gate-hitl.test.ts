import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  resetStepCounter,
  type Harness,
} from "./queue-executor-harness";

describe("queue executor — gate steps and HITL", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // Gate steps
  // -------------------------------------------------------------------------

  test("gate step with 'Continue' — all steps complete", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "gate", title: "Approval Gate" }),
      makeStep({ type: "work", title: "Work 2" }),
    ];
    harness = createHarness({
      steps,
      questionService: { defaultAnswer: "Continue" },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsTotal).toBe(3);

    // Gate step should have transitioned through running to completed
    const gateStep = harness.queue.steps[1];
    expect(gateStep.status).toBe("completed");

    // All steps completed
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Question service was called once (for the gate step)
    expect(harness.questionServiceOpts!.calls).toHaveLength(1);
  });

  test("gate step with 'Stop' — queue fails, remaining steps stay pending", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "gate", title: "Approval Gate" }),
      makeStep({ type: "work", title: "Work 2" }),
    ];
    harness = createHarness({
      steps,
      questionService: { defaultAnswer: "Stop" },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(false);
    expect(result.reason).toContain("stopped at gate");

    // Gate step should be failed
    const gateStep = harness.queue.steps[1];
    expect(gateStep.status).toBe("failed");

    // Queue should be failed
    expect(harness.queue.status).toBe("failed");

    // Step after gate remains pending
    const lastStep = harness.queue.steps[2];
    expect(lastStep.status).toBe("pending");

    // First step completed before the gate
    expect(harness.queue.steps[0].status).toBe("completed");
  });

  test("gate step with 'Pause' — gate completes, queue pauses before next step", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "gate", title: "Approval Gate" }),
      makeStep({ type: "work", title: "Work 2" }),
    ];
    harness = createHarness({
      steps,
      questionService: { defaultAnswer: "Pause" },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(false);

    // Gate step itself should be completed (pause completes the gate)
    const gateStep = harness.queue.steps[1];
    expect(gateStep.status).toBe("completed");

    // Queue should be paused
    expect(harness.queue.status).toBe("paused");

    // Next step should not have started
    const lastStep = harness.queue.steps[2];
    expect(lastStep.status).toBe("pending");

    // First step completed before the gate
    expect(harness.queue.steps[0].status).toBe("completed");
  });

  test("gate step with no question service — auto-resolves as continue", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "gate", title: "Approval Gate" }),
      makeStep({ type: "work", title: "Work 2" }),
    ];
    harness = createHarness({
      steps,
      questionService: null,
    });

    const result = await harness.executor.run();

    // Gate auto-resolves: all steps should complete
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsTotal).toBe(3);

    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // No question service means no calls to track
    expect(harness.questionServiceOpts).toBeNull();
  });

  // -------------------------------------------------------------------------
  // HITL (Human-in-the-Loop) on regular steps
  // -------------------------------------------------------------------------

  test("HITL enabled — user response is passed to dispatcher context", async () => {
    resetStepCounter();
    const steps = [
      makeStep({
        type: "work",
        title: "HITL Step",
        hitl: { enabled: true, prompt: "Review this output" },
      }),
      makeStep({ type: "work", title: "Next Step" }),
    ];
    harness = createHarness({
      steps,
      questionService: {
        answersByStepId: { "HITL Step": "Looks good, proceed" },
        defaultAnswer: "Continue",
      },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2);

    // Question service was called once for the HITL step
    // (HITL uses step.title as header, so answersByStepId keyed by title works)
    expect(harness.questionServiceOpts!.calls).toHaveLength(1);
    const call = harness.questionServiceOpts!.calls![0];
    expect(call.questions[0].header).toBe("HITL Step");
    expect(call.questions[0].question).toBe("Review this output");

    // Dispatcher should have received the HITL response in context
    const dispatcherCall = harness.dispatcherOpts.calls![0];
    expect(dispatcherCall.context.hitlResponse).toBe("Looks good, proceed");
  });

  test("HITL disabled — question service is never called", async () => {
    resetStepCounter();
    const steps = [
      makeStep({
        type: "work",
        title: "Auto Step",
        hitl: { enabled: false, prompt: "Should not appear" },
      }),
    ];
    harness = createHarness({
      steps,
      questionService: { calls: [] },
    });

    const result = await harness.executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);

    // Question service should never have been called
    expect(harness.questionServiceOpts!.calls).toHaveLength(0);

    // Step completed normally (autonomously)
    expect(harness.queue.steps[0].status).toBe("completed");
  });
});
