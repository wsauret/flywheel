// ---------------------------------------------------------------------------
// Integration Tests — Dispatcher Context, Context Windowing, Assessment Chaining
// ---------------------------------------------------------------------------
//
// Validates ADR-003 behaviors for dispatcher context assembly:
//   1. Dispatcher receives compact queue state
//   2. Dispatcher receives session objective
//   3. Context windowing — old steps summarized, recent in full
//   4. Previous evaluator assessment passed to next dispatcher
//   5. Accumulator state persisted to disk after each step
//   6. Dispatcher receives previousHandoff but not for first step
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from "bun:test";
import {
  createHarness,
  makeStep,
  makeSteps,
  resetStepCounter,
  type Harness,
} from "./queue-executor-harness";

describe("dispatcher context and state", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  // -------------------------------------------------------------------------
  // 1. Dispatcher receives compact queue state
  // -------------------------------------------------------------------------

  test("dispatcher receives compact queue state", async () => {
    harness = createHarness({ stepCount: 3 });
    await harness.executor.run();

    // The first dispatcher call should include queueState
    const firstCall = harness.dispatcherOpts.calls![0];
    expect(firstCall.context.queueState).toBeDefined();

    const queueState = firstCall.context.queueState as Array<{
      id: string;
      type: string;
      title: string;
      status: string;
    }>;

    // Should have 3 entries matching the queue steps
    expect(queueState).toHaveLength(3);

    // Each entry should only have compact fields (id, type, title, status)
    for (const entry of queueState) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("title");
      expect(entry).toHaveProperty("status");

      // Should NOT include verbose fields
      const keys = Object.keys(entry);
      expect(keys).not.toContain("description");
      expect(keys).not.toContain("acceptanceCriteria");
      expect(keys).not.toContain("dispatcherHint");
      expect(keys).not.toContain("toolScoping");
      expect(keys).not.toContain("evaluationCriteria");
    }

    // Verify the compact entries match the queue's steps
    expect(queueState[0].id).toBe("step-1");
    expect(queueState[1].id).toBe("step-2");
    expect(queueState[2].id).toBe("step-3");
  });

  // -------------------------------------------------------------------------
  // 2. Dispatcher receives session objective
  // -------------------------------------------------------------------------

  test("dispatcher receives session objective", async () => {
    harness = createHarness({
      stepCount: 3,
      sessionObjective: "Build the auth module",
    });
    await harness.executor.run();

    // Every dispatcher call should include the session objective
    expect(harness.dispatcherOpts.calls).toHaveLength(3);

    for (const call of harness.dispatcherOpts.calls!) {
      expect(call.context.session_objective).toBe("Build the auth module");
    }
  });

  // -------------------------------------------------------------------------
  // 3. Context windowing — old steps summarized, recent in full
  // -------------------------------------------------------------------------

  test("context windowing: old steps summarized, recent in full", async () => {
    harness = createHarness({
      stepCount: 6,
      worker: {
        handoffByStepId: {
          "step-1": { decisions: ["Use REST API"], artifacts: ["src/api.ts"], output: "done" },
          "step-2": { decisions: ["Add auth middleware"], artifacts: ["src/auth.ts"], issues: ["Rate limiting TBD"], output: "done" },
          "step-3": { output: "Result from step 3" },
          "step-4": { output: "Result from step 4" },
          "step-5": { output: "Result from step 5" },
          "step-6": { output: "Result from step 6" },
        },
      },
    });

    await harness.executor.run();

    // 6th dispatcher call (index 5) has accumulated context from steps 1-5
    const sixthCall = harness.dispatcherOpts.calls![5];
    const ctx = sixthCall.context;

    // totalSteps: 5 steps accumulated (steps 1 through 5)
    expect(ctx.totalSteps).toBe(5);

    // recentHandoffs: last 3 (steps 3, 4, 5 — the default window size is 3)
    const recentHandoffs = ctx.recentHandoffs as Array<{
      stepId: string;
      stepType: string;
      stepTitle: string;
      handoff: Record<string, unknown>;
    }>;
    expect(recentHandoffs).toHaveLength(3);
    expect(recentHandoffs[0].stepId).toBe("step-3");
    expect(recentHandoffs[1].stepId).toBe("step-4");
    expect(recentHandoffs[2].stepId).toBe("step-5");

    // Each recent handoff should have the full handoff object
    expect(recentHandoffs[0].handoff).toEqual({ output: "Result from step 3" });
    expect(recentHandoffs[1].handoff).toEqual({ output: "Result from step 4" });
    expect(recentHandoffs[2].handoff).toEqual({ output: "Result from step 5" });

    // summaries: 2 entries (steps 1, 2 — older than the window)
    const summaries = ctx.summaries as Array<{
      stepId: string;
      stepType: string;
      stepTitle: string;
      decisions: string[];
      artifacts: string[];
      issues: string[];
    }>;
    expect(summaries).toHaveLength(2);
    expect(summaries[0].stepId).toBe("step-1");
    expect(summaries[1].stepId).toBe("step-2");

    // Summaries should have extracted fields, not the full handoff object
    expect(summaries[0].decisions).toEqual(["Use REST API"]);
    expect(summaries[0].artifacts).toEqual(["src/api.ts"]);
    expect(summaries[0].issues).toEqual([]);

    expect(summaries[1].decisions).toEqual(["Add auth middleware"]);
    expect(summaries[1].artifacts).toEqual(["src/auth.ts"]);
    expect(summaries[1].issues).toEqual(["Rate limiting TBD"]);

    // Summaries should NOT have a handoff key
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("handoff");
    }
  });

  // -------------------------------------------------------------------------
  // 4. Previous evaluator assessment passed to next dispatcher
  // -------------------------------------------------------------------------

  test("previous evaluator assessment passed to next dispatcher", async () => {
    harness = createHarness({
      stepCount: 3,
      evaluator: {}, // always-pass evaluator
    });

    await harness.executor.run();

    // First step: no previous assessment
    const firstCall = harness.dispatcherOpts.calls![0];
    expect(firstCall.context.previousAssessment).toBeUndefined();

    // Second step: should have assessment from step 1 (passed: true)
    const secondCall = harness.dispatcherOpts.calls![1];
    expect(secondCall.context.previousAssessment).toBeDefined();
    const assessment1 = secondCall.context.previousAssessment as { passed: boolean };
    expect(assessment1.passed).toBe(true);

    // Third step: should have assessment from step 2 (passed: true)
    const thirdCall = harness.dispatcherOpts.calls![2];
    expect(thirdCall.context.previousAssessment).toBeDefined();
    const assessment2 = thirdCall.context.previousAssessment as { passed: boolean };
    expect(assessment2.passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Accumulator state persisted to disk after each step
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
  // 6. Dispatcher receives previousHandoff but not for first step
  // -------------------------------------------------------------------------

  test("dispatcher receives previousHandoff but not for first step", async () => {
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

    // First step: no previousHandoff
    const firstCall = harness.dispatcherOpts.calls![0];
    expect(firstCall.context.previousHandoff).toBeUndefined();

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
