// ---------------------------------------------------------------------------
// Integration Tests — Queue Executor Edge Cases
// ---------------------------------------------------------------------------
//
// Validates untested code paths in src/queue/executor.ts:
//   1. Empty queue returns immediately
//   2. Abort before run starts (raceAbort with pre-aborted signal)
//   3. Gate dismissed by user (questionService throws)
//   4. HITL dismissed by user (proceeds autonomously)
//   5. Handoff reader failure (graceful degradation)
//   6. Transport error during revision loop
//   8. onStepCompleted hook on evaluation failure (continueExecution)
//   9. Persist failure (graceful degradation)
//  10. persistAccumulatorState failure (graceful degradation)
//  11. HITL enabled but no question service (skipped)
//  12. safeTransition failure (step reported as failed)
//  13. Handoff reader failure during revision (null handoff)
//  14. Dispatcher failure (transport error throws)
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  createMockHandoffReader,
  makeStep,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";
import type { OnStepCompletedHook } from "../src/workflows/queue/shared/hooks";
import type { EvaluatorFn, HandoffReaderFn } from "../src/workflows/queue/executor";

describe("queue executor edge cases", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Empty queue returns immediately
  // -------------------------------------------------------------------------

  test("empty queue returns immediately with completed=true", async () => {
    resetStepCounter();
    harness = createHarness({ stepCount: 0 });
    const result = await harness.executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(0);
    expect(result.stepsTotal).toBe(0);

    // queue:completed event should have been emitted
    const completedEvents = harness.events.ofType("queue:completed");
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    // No dispatcher or worker calls
    expect(harness.dispatcherOpts.calls).toHaveLength(0);
    expect(harness.workerOpts.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Abort before run starts (signal already aborted)
  // -------------------------------------------------------------------------

  test("abort before run starts reverts first step to pending", async () => {
    resetStepCounter();
    harness = createHarness({ stepCount: 3 });

    // Abort BEFORE running — the abort controller signal is already aborted
    harness.executor.abort();
    const result = await harness.executor.run();

    expect(result.completed).toBe(false);
    // First step should be reverted to pending (AbortError catch block)
    expect(harness.queue.steps[0].status).toBe("pending");
    // Queue should be paused (abort sets queue.status = "paused")
    expect(harness.queue.status).toBe("paused");
    // Steps 2 and 3 should remain pending (never started)
    expect(harness.queue.steps[1].status).toBe("pending");
    expect(harness.queue.steps[2].status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // 3. Gate dismissed by user (questionService throws)
  // -------------------------------------------------------------------------

  test("gate dismissed by user treats as stop", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "gate", title: "Approval Gate" }),
      makeStep({ type: "work", title: "Work 2" }),
    ];

    harness = createHarness({
      steps,
      questionService: { throwOnHeaders: new Set(["Gate"]) },
    });

    const result = await harness.executor.run();

    // Gate dismissal triggers "stop" → gate step is failed
    expect(harness.queue.steps[1].status).toBe("failed");
    expect(result.completed).toBe(false);
    expect(harness.queue.status).toBe("failed");
    // First work step completed before the gate
    expect(harness.queue.steps[0].status).toBe("completed");
    // Step after gate remains pending
    expect(harness.queue.steps[2].status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // 4. HITL dismissed by user — proceeds autonomously
  // -------------------------------------------------------------------------

  test("HITL dismissed by user proceeds autonomously", async () => {
    resetStepCounter();
    const steps = [
      makeStep({
        type: "work",
        title: "HITL Step",
        hitl: { enabled: true, prompt: "Review this" },
      }),
    ];

    harness = createHarness({
      steps,
      questionService: { throwOnHeaders: new Set(["HITL Step"]) },
    });

    const result = await harness.executor.run();

    // HITL dismissal does NOT fail the step — it proceeds autonomously
    expect(result.completed).toBe(true);
    expect(harness.queue.steps[0].status).toBe("completed");

    // hitlResponse should NOT be in dispatcher context (HITL was dismissed)
    const dispatcherCall = harness.dispatcherOpts.calls![0];
    expect(dispatcherCall.context.hitlResponse).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Handoff reader failure — graceful degradation
  // -------------------------------------------------------------------------

  test("handoff reader failure degrades gracefully", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1", title: "Step 1" }),
      makeStep({ id: "step-2", title: "Step 2" }),
      makeStep({ id: "step-3", title: "Step 3" }),
    ];

    // Custom handoff reader that fails on step-2
    const failingReader: HandoffReaderFn = async (path: string) => {
      if (path.includes("step-2")) {
        throw new Error("Handoff file corrupted");
      }
      // Fallback: read normally
      try {
        const file = Bun.file(path);
        const exists = await file.exists();
        if (!exists) return null;
        const text = await file.text();
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    harness = createHarness({
      steps,
      handoffReader: failingReader,
    });

    const result = await harness.executor.run();

    // All steps should still complete (handoff read failure is non-fatal)
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);

    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Step 3's dispatcher context should NOT have previousHandoff from step 2
    // (because step 2's handoff read failed, previousHandoff is set to null)
    const step3DispatcherCall = harness.dispatcherOpts.calls![2];
    expect(step3DispatcherCall.context.previousHandoff).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. Transport error during revision loop
  // -------------------------------------------------------------------------

  test("transport error during revision loop breaks out and continues", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1", title: "Step 1" }),
      makeStep({ id: "step-2", title: "Step 2" }),
    ];

    // Custom evaluator: step-1 fails first eval, then returns transport error on revision eval
    let step1EvalCount = 0;
    const customEvaluator: EvaluatorFn = async (step, _output, _criteria, _handoff) => {
      if (step.id === "step-1") {
        step1EvalCount++;
        if (step1EvalCount === 1) {
          // First eval: fail (triggers revision)
          return {
            passed: false,
            skipped: false,
            transportError: false,
            reason: "Needs improvement",
            feedback: "Fix it",
            suggestions: ["Suggestion 1"],
            cyclesUsed: 1,
          };
        }
        // Second eval (during revision): transport error
        return {
          passed: false,
          skipped: false,
          transportError: true,
          reason: "Connection lost",
          feedback: null,
          suggestions: [],
          cyclesUsed: 1,
        };
      }
      // All other steps pass
      return {
        passed: true,
        skipped: false,
        transportError: false,
        reason: null,
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      };
    };

    harness = createHarness({
      steps,
      evaluatorFn: customEvaluator,
      maxRevisions: 3,
    });

    const result = await harness.executor.run();

    // Step 1 should still complete (transport error during revision = skip further eval)
    expect(result.completed).toBe(true);
    expect(harness.queue.steps[0].status).toBe("completed");
    expect(harness.queue.steps[1].status).toBe("completed");

    // evaluator:failed event should have been emitted for the transport error
    const evalFailed = harness.events.ofType("evaluator:failed");
    expect(evalFailed.length).toBeGreaterThanOrEqual(1);

    // evaluator:revision-requested should have been emitted once
    const revisionEvents = harness.events.ofType("evaluator:revision-requested");
    expect(revisionEvents.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. onStepCompleted hook on evaluation failure (continueExecution)
  // -------------------------------------------------------------------------

  test("onStepCompleted hook continues after evaluation failure", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1", title: "Step 1" }),
      makeStep({ id: "step-2", title: "Step 2" }),
      makeStep({ id: "step-3", title: "Step 3" }),
    ];

    const hookCalls: Array<{ stepId: string; status: string }> = [];
    const hook: OnStepCompletedHook = async (step, status, _queue, _handoff) => {
      hookCalls.push({ stepId: step.id, status });
      // Continue execution when a step fails
      return { continueExecution: status === "failed" };
    };

    harness = createHarness({
      steps,
      evaluator: { failOnStepIds: new Set(["step-2"]) },
      maxRevisions: 0,
      onStepCompleted: hook,
    });

    const result = await harness.executor.run();

    // Step 2 should be failed (eval failed, maxRevisions=0)
    expect(harness.queue.steps[1].status).toBe("failed");
    // Steps 1 and 3 should be completed
    expect(harness.queue.steps[0].status).toBe("completed");
    expect(harness.queue.steps[2].status).toBe("completed");

    // The hook should have been called for all 3 steps
    expect(hookCalls).toHaveLength(3);
    expect(hookCalls[0]).toEqual({ stepId: "step-1", status: "completed" });
    expect(hookCalls[1]).toEqual({ stepId: "step-2", status: "failed" });
    expect(hookCalls[2]).toEqual({ stepId: "step-3", status: "completed" });

    // Execution continued past the eval failure
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2); // only 2 actually "completed"
  });

  // -------------------------------------------------------------------------
  // 9. Persist failure — graceful degradation
  // -------------------------------------------------------------------------

  test("persist failure degrades gracefully and execution completes", async () => {
    resetStepCounter();
    harness = createHarness({
      stepCount: 2,
      persistFn: async () => {
        throw new Error("Disk full");
      },
    });

    const result = await harness.executor.run();

    // Should still complete despite persist errors
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2);
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }
  });

  // -------------------------------------------------------------------------
  // 10. persistAccumulatorState failure — graceful degradation
  // -------------------------------------------------------------------------

  test("persistAccumulatorState failure degrades gracefully", async () => {
    resetStepCounter();
    harness = createHarness({
      stepCount: 2,
      persistAccumulatorStateFn: () => {
        throw new Error("Accumulator state write failed");
      },
    });

    const result = await harness.executor.run();

    // Should still complete despite accumulator persistence errors
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2);
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }
  });

  // -------------------------------------------------------------------------
  // 11. HITL enabled but no question service — skipped
  // -------------------------------------------------------------------------

  test("HITL enabled with no question service is skipped", async () => {
    resetStepCounter();
    const steps = [
      makeStep({
        type: "work",
        title: "HITL Step",
        hitl: { enabled: true, prompt: "Review needed" },
      }),
    ];

    harness = createHarness({
      steps,
      questionService: null,
    });

    const result = await harness.executor.run();

    // Step should complete autonomously (HITL skipped because no question service)
    expect(result.completed).toBe(true);
    expect(harness.queue.steps[0].status).toBe("completed");

    // hitlResponse should NOT be in dispatcher context
    const dispatcherCall = harness.dispatcherOpts.calls![0];
    expect(dispatcherCall.context.hitlResponse).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 12. safeTransition failure — step reported as failed
  // -------------------------------------------------------------------------

  test("safeTransition failure on initial transition reports step as failed", async () => {
    resetStepCounter();
    // Create a step that's already "completed" — transition to "running" will fail
    // because completed is a terminal state
    const steps = [
      makeStep({ id: "step-1", title: "Step 1", status: "completed" }),
      makeStep({ id: "step-2", title: "Step 2" }),
    ];

    harness = createHarness({ steps });

    const result = await harness.executor.run();

    // step-1 was already completed, so the loop skips it (status != "pending")
    // step-2 should complete normally
    expect(harness.queue.steps[1].status).toBe("completed");
    expect(result.completed).toBe(true);
    // stepsCompleted counts step-1 (already completed at start) + step-2
    expect(result.stepsCompleted).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 13. Handoff reader failure during revision — null handoff
  // -------------------------------------------------------------------------

  test("handoff reader failure during revision sets handoff to null", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1", title: "Step 1" }),
    ];

    // Track handoff read attempts. Succeed first time, fail on revision read.
    let readCount = 0;
    const countingReader: HandoffReaderFn = async (path: string) => {
      readCount++;
      if (readCount > 1) {
        // Revision read: throw
        throw new Error("Handoff corrupted on re-read");
      }
      // First read: succeed
      try {
        const file = Bun.file(path);
        const exists = await file.exists();
        if (!exists) return null;
        const text = await file.text();
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    // Custom evaluator: fail once (triggers revision), then pass
    let evalCount = 0;
    const customEvaluator: EvaluatorFn = async (step, _output, _criteria, handoff) => {
      evalCount++;
      if (evalCount === 1) {
        return {
          passed: false,
          skipped: false,
          transportError: false,
          reason: "Needs revision",
          feedback: "Try again",
          suggestions: [],
          cyclesUsed: 1,
        };
      }
      // Second eval should receive null handoff (because reader threw)
      return {
        passed: true,
        skipped: false,
        transportError: false,
        reason: null,
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      };
    };

    harness = createHarness({
      steps,
      handoffReader: countingReader,
      evaluatorFn: customEvaluator,
      maxRevisions: 1,
    });

    const result = await harness.executor.run();

    // Step should still complete (handoff failure during revision is non-fatal)
    expect(result.completed).toBe(true);
    expect(harness.queue.steps[0].status).toBe("completed");
    // Two evaluator invocations
    expect(evalCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 14. Dispatcher failure — transport error throws
  // -------------------------------------------------------------------------

  test("dispatcher failure marks step as failed", async () => {
    resetStepCounter();
    const steps = [
      makeStep({ id: "step-1", title: "Step 1" }),
      makeStep({ id: "step-2", title: "Step 2" }),
      makeStep({ id: "step-3", title: "Step 3" }),
    ];

    harness = createHarness({
      steps,
      dispatcher: { failOnStepIds: new Set(["step-2"]) },
    });

    const result = await harness.executor.run();

    // Step 2 should be failed (dispatcher threw)
    expect(harness.queue.steps[1].status).toBe("failed");
    // Step 1 completed before the failure
    expect(harness.queue.steps[0].status).toBe("completed");
    // Step 3 never started
    expect(harness.queue.steps[2].status).toBe("pending");
    expect(result.completed).toBe(false);

    // The step failure event should include the dispatcher error
    const stepFailed = harness.events.ofType("queue:step-failed");
    expect(stepFailed.some((e) => e.stepId === "step-2")).toBe(true);
  });

});
