// ---------------------------------------------------------------------------
// Integration Tests — Dispatcher Context, Assessment Chaining
// ---------------------------------------------------------------------------
//
// Validates dispatcher context assembly:
//   1. Previous evaluator assessment passed to next dispatcher
//   2. Accumulator state persisted to disk after each step
//   3. Dispatcher receives previousHandoff (null for first step)
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./helpers/queue-executor-harness";

describe("dispatcher context and state", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Previous evaluator assessment passed to next dispatcher
  // -------------------------------------------------------------------------

  test("previous evaluator assessment passed to next dispatcher", async () => {
    harness = createHarness({
      stepCount: 3,
      evaluator: {}, // always-pass evaluator
    });

    await harness.executor.run();

    // First step: no previous assessment
    const firstCall = harness.dispatcherOpts.calls![0];
    expect(firstCall.context.previousAssessment).toBeNull();

    // Second step: should have assessment from step 1 (passed: true)
    const secondCall = harness.dispatcherOpts.calls![1];
    expect(secondCall.context.previousAssessment).not.toBeNull();
    expect(secondCall.context.previousAssessment!.passed).toBe(true);

    // Third step: should have assessment from step 2 (passed: true)
    const thirdCall = harness.dispatcherOpts.calls![2];
    expect(thirdCall.context.previousAssessment).not.toBeNull();
    expect(thirdCall.context.previousAssessment!.passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Accumulator state persisted to disk after each step
  // -------------------------------------------------------------------------

  test("accumulator state persisted to disk after each step", async () => {
    harness = createHarness({
      stepCount: 3,
      worker: {
        handoffByStepId: {
          "step-1": { output: "result-1", decisions: ["d1"] },
          "step-2": { output: "result-2", decisions: ["d2"] },
          "step-3": { output: "result-3", decisions: ["d3"] },
        },
      },
    });

    await harness.executor.run();

    // Load the persisted accumulator state from disk
    const accState = await harness.persistence.loadAccumulatorState();

    expect(accState).not.toBeNull();
    expect(accState!.entries).toHaveLength(3);

    // Entries should match the handoff data written by the mock worker
    expect(accState!.entries[0].stepId).toBe("step-1");
    expect(accState!.entries[0].handoff).toEqual({ output: "result-1", decisions: ["d1"] });

    expect(accState!.entries[1].stepId).toBe("step-2");
    expect(accState!.entries[1].handoff).toEqual({ output: "result-2", decisions: ["d2"] });

    expect(accState!.entries[2].stepId).toBe("step-3");
    expect(accState!.entries[2].handoff).toEqual({ output: "result-3", decisions: ["d3"] });
  });

  // -------------------------------------------------------------------------
  // 3. Dispatcher receives previousHandoff (null for first step)
  // -------------------------------------------------------------------------

  test("dispatcher receives previousHandoff (null for first step)", async () => {
    harness = createHarness({
      stepCount: 3,
      worker: {
        handoffByStepId: {
          "step-1": { output: "handoff-from-step-1", key1: "val1" },
          "step-2": { output: "handoff-from-step-2", key2: "val2" },
          "step-3": { output: "handoff-from-step-3", key3: "val3" },
        },
      },
    });

    await harness.executor.run();

    // First step: previousHandoff is null
    const firstCall = harness.dispatcherOpts.calls![0];
    expect(firstCall.context.previousHandoff).toBeNull();

    // Second step: previousHandoff matches step 1's handoff data
    const secondCall = harness.dispatcherOpts.calls![1];
    expect(secondCall.context.previousHandoff).toEqual({
      output: "handoff-from-step-1",
      key1: "val1",
    });

    // Third step: previousHandoff matches step 2's handoff data
    const thirdCall = harness.dispatcherOpts.calls![2];
    expect(thirdCall.context.previousHandoff).toEqual({
      output: "handoff-from-step-2",
      key2: "val2",
    });
  });
});
