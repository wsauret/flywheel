// ---------------------------------------------------------------------------
// Post-Turn Verification Hook — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for the post-turn verification hook integration in the step runner.
// The hook is an injectable async function called between handoff read and
// evaluator. Tests mock the hook — actual composition is the orchestrator's job.
// ---------------------------------------------------------------------------

import { describe, expect, test, mock } from "bun:test";
import { randomUUID } from "crypto";

import { createQueue } from "../src/workflows/queue/queue";
import type { Step, Queue } from "../src/workflows/queue/types";
import type { EmitFn } from "../src/infra/event-bus";
import type {
  DispatcherFn,
  EvaluatorFn,
  WorkerFn,
  WorkerOutput,
  HandoffReaderFn,
  StepContextAccumulator,
  PostTurnVerificationResult,
} from "../src/workflows/queue/executor-types.js";
import { executeStep, type StepRunnerDeps } from "../src/workflows/queue/step-runner.js";

// ---------------------------------------------------------------------------
// Helpers (mirror step-executor.test.ts patterns)
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Test step",
    status: "pending",
    ...overrides,
  };
}

function createMockEmit(): EmitFn {
  return ((type: string, payload: unknown) => {}) as EmitFn;
}

function createSuccessWorker(output = "done"): WorkerFn {
  return async (_step, _prompt) => ({
    output,
    handoffPath: `/tmp/handoff-${randomUUID()}.json`,
    durationMs: 100,
    sessionId: randomUUID(),
  });
}

function createSimpleDispatcher(prompt = "do the work"): DispatcherFn {
  return async (_step, _context) => ({
    prompt,
    evaluationCriteria: null,
  });
}

function createHandoffReader(data: Record<string, unknown> = { summary: "done" }): HandoffReaderFn {
  return async (_path) => data;
}

function createMissingHandoffReader(): HandoffReaderFn {
  return async () => null;
}

function createNoopAccumulator(): StepContextAccumulator {
  return {
    accumulate: () => {},
    getContext: () => ({}),
  };
}

function createPassingVerification(): PostTurnVerificationResult {
  return {
    passed: true,
    checks: [],
  };
}

function createFailingVerification(): PostTurnVerificationResult {
  return {
    passed: false,
    checks: [{
      command: "bun run test",
      passed: false,
      stdout: "",
      stderr: "test failed",
      exitCode: 1,
      durationMs: 500,
    }],
  };
}

function createDefaultDeps(overrides: Partial<StepRunnerDeps> = {}): StepRunnerDeps {
  const step = makeStep();
  const queue = createQueue([step]);
  return {
    queue,
    workflowId: randomUUID(),
    emit: createMockEmit(),
    dispatcher: createSimpleDispatcher(),
    worker: createSuccessWorker(),
    evaluator: null,
    handoffReader: createHandoffReader(),
    accumulator: createNoopAccumulator(),
    maxRevisions: 0,
    abortSignal: new AbortController().signal,
    previousHandoff: null,
    previousAssessment: null,
    safeTransition: async () => true,
    persistQueue: async () => {},
    ...overrides,
  };
}

// ===========================================================================
// Post-Turn Verification: Work step — native checks pass, self-review, complete
// ===========================================================================

describe("Post-Turn Verification Hook", () => {
  test("work step: native checks pass + self-review injected -> step completes", async () => {
    const hookFn = mock(async () => createPassingVerification());
    const step = makeStep({ type: "work", title: "Implement feature" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
    // Verify the hook was called with the right shape
    const callArgs = hookFn.mock.calls[0][0];
    expect(callArgs.step).toBe(step);
    expect(callArgs.workerOutput).toBeDefined();
    expect(callArgs.handoffData).toBeDefined();
  });

  test("work step: native checks fail -> fix prompt injected -> re-verify -> passes (mocked as single hook call)", async () => {
    const hookFn = mock(async () => ({
      passed: true,
      checks: [{
        command: "bun run test",
        passed: true,
        stdout: "all tests pass",
        stderr: "",
        exitCode: 0,
        durationMs: 300,
      }],
    }));

    const step = makeStep({ type: "work", title: "Fix tests" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
    const hookResult = await hookFn.mock.results[0].value;
    expect(hookResult.passed).toBe(true);
  });

  test("work step: verification fails -> results enriched into handoff, step continues to evaluator", async () => {
    const hookFn = mock(async () => createFailingVerification());
    const step = makeStep({ type: "work", title: "Broken step" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    // Post-turn verification is informational — step proceeds to evaluator (or completes if no evaluator)
    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
  });

  test("both disabled (hook null) -> step runs exactly as before (no regression)", async () => {
    const step = makeStep({ type: "work", title: "Normal step" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: null,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
  });

  test("both disabled (hook undefined) -> step runs exactly as before (no regression)", async () => {
    const step = makeStep({ type: "work", title: "Normal step" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({ queue });
    // Ensure postTurnVerification is not set
    delete (deps as any).postTurnVerification;

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
  });

  test("non-code step (plan): post-turn verification hook returns null -> skipped", async () => {
    const hookFn = mock(async () => null);
    const step = makeStep({ type: "plan", title: "Plan features" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
  });

  test("non-code step (review): post-turn verification hook returns null -> skipped", async () => {
    const hookFn = mock(async () => null);
    const step = makeStep({ type: "review", title: "Code review" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
  });

  test("non-code step (research): post-turn verification hook returns null -> skipped", async () => {
    const hookFn = mock(async () => null);
    const step = makeStep({ type: "research", title: "Research APIs" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
  });

  test("ship step: only native git checks", async () => {
    const hookFn = mock(async () => ({
      passed: true,
      checks: [{
        command: "git diff --stat HEAD~1",
        passed: true,
        stdout: " src/foo.ts | 10 ++++++++++\n",
        stderr: "",
        exitCode: 0,
        durationMs: 50,
      }],
    }));

    const step = makeStep({ type: "ship", title: "Ship release" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
  });

  test("max fix attempts (default 2) prevents infinite loops — result is informational", async () => {
    const hookFn = mock(async () => createFailingVerification());
    const step = makeStep({ type: "work", title: "Infinite loop avoided" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
    });

    const result = await executeStep(step, deps);

    // Verification failure is informational — step still completes (evaluator decides)
    expect(result.outcome).toBe("completed");
    const hookResult = await hookFn.mock.results[0].value;
    expect(hookResult.passed).toBe(false);
  });

  test("native checks run BEFORE evaluator", async () => {
    const callOrder: string[] = [];

    const hookFn = mock(async () => {
      callOrder.push("postTurnVerification");
      return createPassingVerification();
    });

    const evaluatorFn = mock(async () => {
      callOrder.push("evaluator");
      return {
        passed: true,
        skipped: false,
        transportError: false,
        reason: "good",
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      };
    });

    const step = makeStep({ type: "work", title: "Check order" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
      evaluator: evaluatorFn,
      maxRevisions: 1,
    });

    const result = await executeStep(step, deps);

    expect(result.outcome).toBe("completed");
    expect(callOrder).toEqual(["postTurnVerification", "evaluator"]);
  });

  test("verification failure does NOT short-circuit — evaluator still runs with enriched handoff", async () => {
    const hookFn = mock(async () => createFailingVerification());
    const evaluatorFn = mock(async () => ({
      passed: true,
      skipped: false,
      transportError: false,
      reason: "good",
      feedback: null,
      suggestions: [],
      cyclesUsed: 1,
    }));

    const step = makeStep({ type: "work", title: "Evaluator sees verification results" });
    const queue = createQueue([step]);

    const deps = createDefaultDeps({
      queue,
      postTurnVerification: hookFn,
      evaluator: evaluatorFn,
      maxRevisions: 1,
    });

    const result = await executeStep(step, deps);

    // Verification is informational — evaluator runs regardless
    expect(result.outcome).toBe("completed");
    expect(hookFn).toHaveBeenCalledTimes(1);
    expect(evaluatorFn).toHaveBeenCalledTimes(1);
  });

});
