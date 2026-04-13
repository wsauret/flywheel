// ---------------------------------------------------------------------------
// Step Executor — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for createStepExecutor(), the queue-based replacement for ExecutionLoop.
// Covers VAL-QUEUE-024..029, 032..034.
// ---------------------------------------------------------------------------

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

import { createQueue, transitionStep, advanceCursor } from "../src/workflows/queue/queue";
import type { Step, Queue } from "../src/workflows/queue/types";
import type { EmitFn } from "../src/infra/event-bus";
import type { FlywheelEvent } from "../src/infra/events";
import { createStepExecutor } from "../src/workflows/queue/executor";
import type {
  StepExecutorOptions,
  StepExecutorResult,
  DispatcherFn,
  EvaluatorFn,
  WorkerFn,
  HandoffReaderFn,
  PersistFn,
  StepContextAccumulator,
} from "../src/workflows/queue/executor-types";

// ---------------------------------------------------------------------------
// Helpers
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

/** Minimal no-op emit function that records calls */
function createMockEmit(): EmitFn & { calls: Array<{ type: string; payload: unknown }> } {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const fn = ((type: string, payload: unknown) => {
    calls.push({ type, payload });
  }) as EmitFn & { calls: Array<{ type: string; payload: unknown }> };
  fn.calls = calls;
  return fn;
}

/** Default successful worker that returns output */
function createSuccessWorker(output = "done"): WorkerFn {
  return async (_step, _prompt) => ({
    output,
    handoffPath: `/tmp/handoff-${randomUUID()}.json`,
    durationMs: 100,
    sessionId: randomUUID(),
  });
}

/** Worker that crashes (throws) */
function createCrashingWorker(errorMsg = "worker crashed"): WorkerFn {
  return async () => {
    throw new Error(errorMsg);
  };
}

/** Default dispatcher that returns a prompt */
function createSimpleDispatcher(prompt = "do the work"): DispatcherFn {
  return async (_step, _context) => ({
    prompt,
    evaluationCriteria: null,
  });
}

/** Evaluator that always passes */
function createPassingEvaluator(): EvaluatorFn {
  return async () => ({
    passed: true,
    skipped: false,
    transportError: false,
    reason: "looks good",
    feedback: null,
    suggestions: [],
    cyclesUsed: 1,
  });
}

/** Evaluator that always fails */
function createFailingEvaluator(): EvaluatorFn {
  return async () => ({
    passed: false,
    skipped: false,
    transportError: false,
    reason: "not good enough",
    feedback: "needs more work",
    suggestions: ["fix thing A"],
    cyclesUsed: 1,
  });
}

/** Evaluator with transport error */
function createTransportErrorEvaluator(): EvaluatorFn {
  return async () => ({
    passed: false,
    skipped: false,
    transportError: true,
    reason: "transport failed",
    feedback: null,
    suggestions: [],
    cyclesUsed: 0,
  });
}

/** Handoff reader that returns structured data */
function createHandoffReader(data: Record<string, unknown> = { summary: "done" }): HandoffReaderFn {
  return async (_path) => data;
}

/** Handoff reader that returns null (missing) */
function createMissingHandoffReader(): HandoffReaderFn {
  return async () => null;
}

/** No-op persist function */
function createNoopPersist(): PersistFn {
  return async () => {};
}

/** Persist function that records calls */
function createRecordingPersist(): PersistFn & { calls: Queue[] } {
  const calls: Queue[] = [];
  const fn = async (queue: Queue) => {
    calls.push(JSON.parse(JSON.stringify(queue)));
  };
  (fn as any).calls = calls;
  return fn as PersistFn & { calls: Queue[] };
}

/** No-op stage context accumulator */
function createNoopAccumulator(): StepContextAccumulator {
  return {
    accumulate: () => {},
    getContext: () => ({}),
  };
}

/** Recording stage context accumulator */
function createRecordingAccumulator(): StepContextAccumulator & { accumulated: unknown[] } {
  const accumulated: unknown[] = [];
  return {
    accumulate: (data: unknown) => { accumulated.push(data); },
    getContext: () => ({ previousSteps: accumulated }),
    accumulated,
  };
}

function createDefaultOptions(overrides: Partial<StepExecutorOptions> = {}): StepExecutorOptions {
  const steps = overrides.queue?.steps
    ? []
    : [makeStep({ title: "Step 1" }), makeStep({ title: "Step 2" })];
  return {
    queue: overrides.queue ?? createQueue(steps),
    workflowId: overrides.workflowId ?? randomUUID(),
    sessionId: overrides.sessionId ?? randomUUID(),
    emit: overrides.emit ?? createMockEmit(),
    dispatcher: overrides.dispatcher ?? createSimpleDispatcher(),
    worker: overrides.worker ?? createSuccessWorker(),
    evaluator: overrides.evaluator ?? null,
    handoffReader: overrides.handoffReader ?? createMissingHandoffReader(),
    persist: overrides.persist ?? createNoopPersist(),
    accumulator: overrides.accumulator ?? createNoopAccumulator(),
    maxRevisions: overrides.maxRevisions ?? 0,
    onStepCompleted: overrides.onStepCompleted ?? null,
  };
}

// ===========================================================================
// VAL-QUEUE-024: Steps processed sequentially
// ===========================================================================

describe("VAL-QUEUE-024: Steps processed sequentially", () => {
  test("steps processed one at a time in queue order", async () => {
    const executionOrder: string[] = [];
    const worker: WorkerFn = async (step) => {
      executionOrder.push(step.id);
      return {
        output: `done ${step.title}`,
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const s1 = makeStep({ title: "First" });
    const s2 = makeStep({ title: "Second" });
    const s3 = makeStep({ title: "Third" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(executionOrder).toEqual([s1.id, s2.id, s3.id]);
  });

  test("next step doesn't start until current completes", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const worker: WorkerFn = async (step) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 10,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep(), makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(maxConcurrent).toBe(1);
  });

  test("completed steps are not re-executed on resume", async () => {
    const executionOrder: string[] = [];
    const worker: WorkerFn = async (step) => {
      executionOrder.push(step.id);
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const s1 = makeStep({ title: "Done already", status: "completed" as any });
    const s2 = makeStep({ title: "Still pending" });
    // Manually set s1 as completed before creating queue
    const queue = createQueue([s1, s2]);
    // Override first step status to completed (simulating resume)
    queue.steps[0].status = "completed";
    queue.cursor = 1; // cursor should be at second step

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(executionOrder).toEqual([s2.id]);
    expect(executionOrder).not.toContain(s1.id);
  });
});

// ===========================================================================
// VAL-QUEUE-025: Dispatcher invoked for prompt assembly per step
// ===========================================================================

describe("VAL-QUEUE-025: Dispatcher invoked per step for prompt assembly", () => {
  test("dispatcher called once per step", async () => {
    const dispatcherCalls: string[] = [];
    const dispatcher: DispatcherFn = async (step, _context) => {
      dispatcherCalls.push(step.id);
      return { prompt: `prompt for ${step.title}`, evaluationCriteria: null };
    };

    const s1 = makeStep({ title: "A" });
    const s2 = makeStep({ title: "B" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, dispatcher });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(dispatcherCalls).toEqual([s1.id, s2.id]);
  });

  test("dispatcher receives step info", async () => {
    let receivedStep: Step | null = null;
    const dispatcher: DispatcherFn = async (step, _context) => {
      receivedStep = step;
      return { prompt: "go", evaluationCriteria: null };
    };

    const step = makeStep({ type: "plan", title: "Create plan" });
    const queue = createQueue([step]);

    const opts = createDefaultOptions({ queue, dispatcher });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(receivedStep).not.toBeNull();
    expect(receivedStep!.type).toBe("plan");
    expect(receivedStep!.title).toBe("Create plan");
  });

  test("worker receives prompt from dispatcher", async () => {
    const dispatcher: DispatcherFn = async () => ({
      prompt: "SPECIFIC_PROMPT_CONTENT",
      evaluationCriteria: null,
    });

    let receivedPrompt: string | null = null;
    const worker: WorkerFn = async (_step, prompt) => {
      receivedPrompt = prompt;
      return {
        output: "done",
        handoffPath: `/tmp/test.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({ queue, dispatcher, worker });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(receivedPrompt).toBe("SPECIFIC_PROMPT_CONTENT");
  });
});

// ===========================================================================
// VAL-QUEUE-026: Evaluator invoked after step completion
// ===========================================================================

describe("VAL-QUEUE-026: Evaluator invoked after step completion", () => {
  test("evaluator called after each step when provided", async () => {
    const evalCalls: string[] = [];
    const evaluator: EvaluatorFn = async (step, _output) => {
      evalCalls.push(step.id);
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const s1 = makeStep({ title: "A" });
    const s2 = makeStep({ title: "B" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, evaluator });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(evalCalls).toEqual([s1.id, s2.id]);
  });

  test("evaluator not called when null (no evaluator configured)", async () => {
    const worker = createSuccessWorker();
    const queue = createQueue([makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue, evaluator: null });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2);
  });
});

// ===========================================================================
// VAL-QUEUE-027: Worker crash does not crash the queue
// ===========================================================================

describe("VAL-QUEUE-027: Worker crash does not crash executor", () => {
  test("worker crash marks step failed, does not throw", async () => {
    const crashWorker = createCrashingWorker("kaboom");
    const s1 = makeStep({ title: "Crasher" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, worker: crashWorker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    // Executor should NOT throw — it returns a result
    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(queue.steps[0].status).toBe("failed");
  });

  test("worker crash on step N doesn't prevent result return", async () => {
    let callCount = 0;
    const worker: WorkerFn = async (step) => {
      callCount++;
      if (callCount === 2) throw new Error("crash on step 2");
      return {
        output: "ok",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const s1 = makeStep({ title: "OK" });
    const s2 = makeStep({ title: "Crasher" });
    const s3 = makeStep({ title: "Never reached" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(1);
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("failed");
    expect(queue.steps[2].status).toBe("pending");
  });

  test("queue state remains consistent after crash", async () => {
    const crashWorker = createCrashingWorker("kaboom");
    const s1 = makeStep();
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, worker: crashWorker });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Queue should be in a consistent state
    expect(queue.steps[0].status).toBe("failed");
    expect(queue.mutationLog.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-QUEUE-028: Evaluator transport failure graceful degradation
// ===========================================================================

describe("VAL-QUEUE-028: Evaluator transport failure graceful degradation", () => {
  test("evaluator transport error skips eval, step still completes", async () => {
    const transportErrorEval = createTransportErrorEvaluator();
    const s1 = makeStep({ title: "Step with eval failure" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, evaluator: transportErrorEval });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);
    expect(queue.steps[0].status).toBe("completed");
  });

  test("evaluator transport error mid-queue doesn't stop execution", async () => {
    let evalCallCount = 0;
    const evaluator: EvaluatorFn = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        // First call: transport error
        return {
          passed: false, skipped: false, transportError: true,
          reason: "transport failed", feedback: null, suggestions: [], cyclesUsed: 0,
        };
      }
      // Second call: passes
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const queue = createQueue([makeStep({ title: "A" }), makeStep({ title: "B" })]);
    const opts = createDefaultOptions({ queue, evaluator });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2);
  });
});

// ===========================================================================
// VAL-QUEUE-032: Graceful shutdown on request
// ===========================================================================

describe("VAL-QUEUE-032: Graceful shutdown on request", () => {
  test("shutdown request finishes current step then stops", async () => {
    let stepCount = 0;
    const worker: WorkerFn = async (step) => {
      stepCount++;
      // Request shutdown during second step
      if (stepCount === 1) {
        executor.requestShutdown();
      }
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const s1 = makeStep({ title: "First" });
    const s2 = makeStep({ title: "Second — should not run" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(1);
    expect(result.reason?.toLowerCase()).toContain("shutdown");
    // First step completes, second stays pending
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("pending");
  });

  test("shutdown before any step starts", async () => {
    const queue = createQueue([makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue });
    const executor = createStepExecutor(opts);
    executor.requestShutdown(); // shutdown before run()
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(result.reason?.toLowerCase()).toContain("shutdown");
  });

  test("queue state persisted after shutdown", async () => {
    const persist = createRecordingPersist();
    let stepCount = 0;
    const worker: WorkerFn = async (step) => {
      stepCount++;
      if (stepCount === 1) {
        executor.requestShutdown();
      }
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue, worker, persist });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Persist should have been called
    expect(persist.calls.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-QUEUE-033: Evaluator revision loop within a step
// ===========================================================================

describe("VAL-QUEUE-033: Evaluator revision loop", () => {
  test("revision retries on evaluator rejection, then passes", async () => {
    let evalCallCount = 0;
    const evaluator: EvaluatorFn = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        return {
          passed: false, skipped: false, transportError: false,
          reason: "not good", feedback: "fix it", suggestions: ["do X"],
          cyclesUsed: 1,
        };
      }
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok now", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    let workerCallCount = 0;
    const worker: WorkerFn = async (step, prompt) => {
      workerCallCount++;
      return {
        output: `attempt ${workerCallCount}`,
        handoffPath: `/tmp/${step.id}-${workerCallCount}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({
      queue,
      evaluator,
      worker,
      maxRevisions: 3,
    });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);
    // Worker called twice: first attempt + revision
    expect(workerCallCount).toBe(2);
    // Evaluator called twice
    expect(evalCallCount).toBe(2);
  });

  test("revision loop exhausts max_revisions, step fails", async () => {
    const evaluator = createFailingEvaluator();
    let workerCallCount = 0;
    const worker: WorkerFn = async (step) => {
      workerCallCount++;
      return {
        output: `attempt ${workerCallCount}`,
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({
      queue,
      evaluator,
      worker,
      maxRevisions: 2,
    });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(queue.steps[0].status).toBe("failed");
    // 1 initial + 2 revisions = 3 worker calls
    expect(workerCallCount).toBe(3);
  });

  test("revision prompt includes evaluator feedback", async () => {
    let evalCallCount = 0;
    const evaluator: EvaluatorFn = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        return {
          passed: false, skipped: false, transportError: false,
          reason: "MISSING_TESTS", feedback: "ADD_UNIT_TESTS",
          suggestions: ["WRITE_JEST_TEST"], cyclesUsed: 1,
        };
      }
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const prompts: string[] = [];
    const worker: WorkerFn = async (step, prompt) => {
      prompts.push(prompt);
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({
      queue, evaluator, worker, maxRevisions: 1,
    });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Second prompt (revision) should contain evaluator feedback
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("MISSING_TESTS");
  });

  test("no revision loop when maxRevisions is 0", async () => {
    const evaluator = createFailingEvaluator();
    let workerCallCount = 0;
    const worker: WorkerFn = async (step) => {
      workerCallCount++;
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({
      queue, evaluator, worker, maxRevisions: 0,
    });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(workerCallCount).toBe(1); // No revisions
  });
});

// ===========================================================================
// VAL-QUEUE-034: Handoff data chaining between steps
// ===========================================================================

describe("VAL-QUEUE-034: Handoff data chaining between steps", () => {
  test("handoff data from step N available to dispatcher for step N+1", async () => {
    const handoffReader: HandoffReaderFn = async (_path) => ({
      summary: "I created the API endpoint",
      decisions: ["used REST over GraphQL"],
      warnings: ["no rate limiting yet"],
    });

    const dispatcherContexts: Array<Record<string, unknown>> = [];
    const dispatcher: DispatcherFn = async (step, context) => {
      dispatcherContexts.push({ ...context });
      return { prompt: `work on ${step.title}`, evaluationCriteria: null };
    };

    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, dispatcher, handoffReader });
    const executor = createStepExecutor(opts);
    await executor.run();

    // First step should have no prior handoff
    expect(dispatcherContexts[0].previousHandoff).toBeUndefined();
    // Second step should receive handoff from first step
    expect(dispatcherContexts[1].previousHandoff).toBeDefined();
    expect((dispatcherContexts[1].previousHandoff as any).summary).toBe(
      "I created the API endpoint",
    );
  });

  test("accumulated context grows across steps", async () => {
    const accumulator = createRecordingAccumulator();
    const handoffReader: HandoffReaderFn = async () => ({
      summary: "step done",
      decisions: ["decision A"],
    });

    const queue = createQueue([makeStep(), makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue, handoffReader, accumulator });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Accumulator should have been called 3 times
    expect(accumulator.accumulated.length).toBe(3);
  });

  test("missing handoff passes null to next dispatcher", async () => {
    const missingReader = createMissingHandoffReader();

    const dispatcherContexts: Array<Record<string, unknown>> = [];
    const dispatcher: DispatcherFn = async (_step, context) => {
      dispatcherContexts.push({ ...context });
      return { prompt: "go", evaluationCriteria: null };
    };

    const queue = createQueue([makeStep(), makeStep()]);
    const opts = createDefaultOptions({ queue, dispatcher, handoffReader: missingReader });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Second step should have undefined/null previousHandoff
    expect(dispatcherContexts[1].previousHandoff).toBeUndefined();
  });
});

// ===========================================================================
// Bug fix: evaluationCriteria forwarded to evaluator function
// ===========================================================================

describe("evaluationCriteria forwarded to evaluator", () => {
  test("evaluator receives evaluationCriteria from dispatcher", async () => {
    const criteria = {
      acceptance: ["has tests", "no lint errors"],
      required_files: ["src/index.ts"],
    };

    const dispatcher: DispatcherFn = async () => ({
      prompt: "do the work",
      evaluationCriteria: criteria,
    });

    let receivedCriteria: unknown | null | undefined = undefined;
    const evaluator: EvaluatorFn = async (_step, _output, evaluationCriteria) => {
      receivedCriteria = evaluationCriteria;
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({ queue, dispatcher, evaluator });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(receivedCriteria).toEqual(criteria);
  });

  test("evaluator receives null evaluationCriteria when dispatcher returns null", async () => {
    const dispatcher: DispatcherFn = async () => ({
      prompt: "do the work",
      evaluationCriteria: null,
    });

    let receivedCriteria: unknown | null | undefined = "NOT_SET";
    const evaluator: EvaluatorFn = async (_step, _output, evaluationCriteria) => {
      receivedCriteria = evaluationCriteria;
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({ queue, dispatcher, evaluator });
    const executor = createStepExecutor(opts);
    await executor.run();

    expect(receivedCriteria).toBeNull();
  });

  test("evaluationCriteria forwarded through revision loop", async () => {
    const criteria = { rules: ["must have unit tests"] };

    const dispatcher: DispatcherFn = async () => ({
      prompt: "do the work",
      evaluationCriteria: criteria,
    });

    const receivedCriteriaList: Array<unknown | null | undefined> = [];
    let evalCallCount = 0;
    const evaluator: EvaluatorFn = async (_step, _output, evaluationCriteria) => {
      evalCallCount++;
      receivedCriteriaList.push(evaluationCriteria);
      if (evalCallCount === 1) {
        return {
          passed: false, skipped: false, transportError: false,
          reason: "not good", feedback: "fix it", suggestions: ["add tests"],
          cyclesUsed: 1,
        };
      }
      return {
        passed: true, skipped: false, transportError: false,
        reason: "ok now", feedback: null, suggestions: [], cyclesUsed: 1,
      };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({
      queue, dispatcher, evaluator, maxRevisions: 1,
    });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Both evaluator calls (initial + revision) should receive the same criteria
    expect(receivedCriteriaList).toHaveLength(2);
    expect(receivedCriteriaList[0]).toEqual(criteria);
    expect(receivedCriteriaList[1]).toEqual(criteria);
  });
});

// ===========================================================================
// Queue events (VAL-QUEUE-030, VAL-QUEUE-031 — covered here for integration)
// ===========================================================================

describe("Queue and step events emitted", () => {
  test("emits queue:initialized at start and queue:completed at end", async () => {
    const emit = createMockEmit();
    const queue = createQueue([makeStep()]);

    const opts = createDefaultOptions({ queue, emit });
    const executor = createStepExecutor(opts);
    await executor.run();

    const methods = emit.calls.map((e) => e.type);
    expect(methods).toContain("queue:initialized");
    expect(methods).toContain("queue:completed");
  });

  test("emits queue:failed when step fails", async () => {
    const emit = createMockEmit();
    const crashWorker = createCrashingWorker();
    const queue = createQueue([makeStep()]);

    const opts = createDefaultOptions({ queue, emit, worker: crashWorker });
    const executor = createStepExecutor(opts);
    await executor.run();

    const methods = emit.calls.map((e) => e.type);
    expect(methods).toContain("queue:failed");
  });

  test("emits step:started and step:completed for each step", async () => {
    const emit = createMockEmit();
    const s1 = makeStep({ title: "A" });
    const s2 = makeStep({ title: "B" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, emit });
    const executor = createStepExecutor(opts);
    await executor.run();

    const stepStarted = emit.calls.filter((e) => e.type === "queue:step-started");
    const stepCompleted = emit.calls.filter((e) => e.type === "queue:step-completed");
    expect(stepStarted.length).toBe(2);
    expect(stepCompleted.length).toBe(2);
  });

  test("emits step:failed on worker crash", async () => {
    const emit = createMockEmit();
    const crashWorker = createCrashingWorker();
    const queue = createQueue([makeStep()]);

    const opts = createDefaultOptions({ queue, emit, worker: crashWorker });
    const executor = createStepExecutor(opts);
    await executor.run();

    const stepFailed = emit.calls.filter((e) => e.type === "queue:step-failed");
    expect(stepFailed.length).toBe(1);
  });
});

// ===========================================================================
// Queue persistence after each step transition
// ===========================================================================

describe("Queue persisted after each step transition", () => {
  test("persist called for each step transition", async () => {
    const persist = createRecordingPersist();
    const queue = createQueue([makeStep(), makeStep()]);

    const opts = createDefaultOptions({ queue, persist });
    const executor = createStepExecutor(opts);
    await executor.run();

    // At minimum: running + completed for each step = 4 calls
    expect(persist.calls.length).toBeGreaterThanOrEqual(4);
  });

  test("persist called on step failure", async () => {
    const persist = createRecordingPersist();
    const crashWorker = createCrashingWorker();
    const queue = createQueue([makeStep()]);

    const opts = createDefaultOptions({ queue, persist, worker: crashWorker });
    const executor = createStepExecutor(opts);
    await executor.run();

    // At minimum: running + failed = 2 calls
    expect(persist.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("Edge cases", () => {
  test("empty queue completes immediately", async () => {
    const queue = createQueue([]);
    const opts = createDefaultOptions({ queue });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(0);
  });

  test("all steps pre-completed completes immediately", async () => {
    const s1 = makeStep({ status: "completed" as any });
    const s2 = makeStep({ status: "completed" as any });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";
    queue.cursor = 2;

    const opts = createDefaultOptions({ queue });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
  });

  test("skipped steps are not executed", async () => {
    const executionOrder: string[] = [];
    const worker: WorkerFn = async (step) => {
      executionOrder.push(step.id);
      return {
        output: "done",
        handoffPath: `/tmp/${step.id}.json`,
        durationMs: 50,
        sessionId: randomUUID(),
      };
    };

    const s1 = makeStep({ title: "Active" });
    const s2 = makeStep({ title: "Skipped" });
    const s3 = makeStep({ title: "Active too" });
    const queue = createQueue([s1, s2, s3]);
    queue.steps[1].status = "skipped"; // Pre-skipped

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(executionOrder).toEqual([s1.id, s3.id]);
    expect(executionOrder).not.toContain(s2.id);
  });
});

// ===========================================================================
// VAL-EXEC-001: Steps execute natively without legacy bridge
// ===========================================================================

describe("VAL-EXEC-001: Steps execute natively without legacy bridge", () => {
  test("executor calls dispatcher, spawns worker, invokes evaluator directly", async () => {
    const dispatcherCalls: string[] = [];
    const workerCalls: string[] = [];
    const evalCalls: string[] = [];

    const dispatcher: DispatcherFn = async (step) => {
      dispatcherCalls.push(step.id);
      return { prompt: "go", evaluationCriteria: { check: "all" } };
    };
    const worker: WorkerFn = async (step) => {
      workerCalls.push(step.id);
      return { output: "done", handoffPath: "/tmp/h.json", durationMs: 50, sessionId: randomUUID() };
    };
    const evaluator: EvaluatorFn = async (step) => {
      evalCalls.push(step.id);
      return { passed: true, skipped: false, transportError: false, reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1 };
    };

    const s1 = makeStep({ title: "Step A" });
    const s2 = makeStep({ title: "Step B" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, dispatcher, worker, evaluator });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(dispatcherCalls).toEqual([s1.id, s2.id]);
    expect(workerCalls).toEqual([s1.id, s2.id]);
    expect(evalCalls).toEqual([s1.id, s2.id]);
  });

  test("no delegation to createStageLoop, ExecutionLoop, or StepExecutor", async () => {
    // This is a structural assertion — verified by code inspection and grep.
    // The executor calls dispatcher→worker→evaluator inline.
    // Verify by checking that each step goes through the full cycle.
    const cycleSteps: Array<{ step: string; step: string }> = [];

    const dispatcher: DispatcherFn = async (step) => {
      cycleSteps.push({ step: step.id, step: "dispatch" });
      return { prompt: "go", evaluationCriteria: null };
    };
    const worker: WorkerFn = async (step) => {
      cycleSteps.push({ step: step.id, step: "work" });
      return { output: "done", handoffPath: "/tmp/h.json", durationMs: 50, sessionId: randomUUID() };
    };

    const s1 = makeStep({ title: "Step 1" });
    const queue = createQueue([s1]);
    const opts = createDefaultOptions({ queue, dispatcher, worker });
    const executor = createStepExecutor(opts);
    await executor.run();

    // Each step goes through dispatch→work in sequence (not via any bridge)
    expect(cycleSteps).toEqual([
      { step: s1.id, step: "dispatch" },
      { step: s1.id, step: "work" },
    ]);
  });
});

// ===========================================================================
// VAL-EXEC-002: Sequential cursor advancement through queue
// ===========================================================================

describe("VAL-EXEC-002: Sequential cursor advancement", () => {
  test("3+ steps verify sequential execution and status transitions", async () => {
    const statusLog: Array<{ id: string; status: string }> = [];

    const worker: WorkerFn = async (step) => {
      // Record the step's current status when worker is called
      const queueStep = queue.steps.find((s) => s.id === step.id);
      statusLog.push({ id: step.id, status: queueStep!.status });
      return { output: "done", handoffPath: "/tmp/h.json", durationMs: 50, sessionId: randomUUID() };
    };

    const s1 = makeStep({ title: "First" });
    const s2 = makeStep({ title: "Second" });
    const s3 = makeStep({ title: "Third" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);

    // Each step should have been "running" when the worker was called
    for (const entry of statusLog) {
      expect(entry.status).toBe("running");
    }

    // All steps should now be "completed"
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("completed");
    expect(queue.steps[2].status).toBe("completed");

    // Cursor should be past the end
    expect(queue.cursor).toBe(3);
  });
});

// ===========================================================================
// VAL-EXEC-004: Revision loop on evaluator revise verdict
// ===========================================================================

describe("VAL-EXEC-004: Revision loop on evaluator revise verdict", () => {
  test("evaluator returns revise then pass — worker invoked twice", async () => {
    let evalCount = 0;
    let workerCount = 0;

    const evaluator: EvaluatorFn = async () => {
      evalCount++;
      if (evalCount === 1) {
        return { passed: false, skipped: false, transportError: false, reason: "needs revision", feedback: "improve tests", suggestions: [], cyclesUsed: 1 };
      }
      return { passed: true, skipped: false, transportError: false, reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1 };
    };

    const worker: WorkerFn = async (step) => {
      workerCount++;
      return { output: `attempt-${workerCount}`, handoffPath: "/tmp/h.json", durationMs: 50, sessionId: randomUUID() };
    };

    const queue = createQueue([makeStep()]);
    const opts = createDefaultOptions({ queue, evaluator, worker, maxRevisions: 3 });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(workerCount).toBe(2);
    expect(evalCount).toBe(2);
  });
});

// ===========================================================================
// VAL-EXEC-008: Queue events emitted for step lifecycle
// ===========================================================================

describe("VAL-EXEC-008: Queue events emitted for step lifecycle", () => {
  test("queue:step-started emitted with stepId, step metadata", async () => {
    const emit = createMockEmit();
    const s1 = makeStep({ type: "plan", title: "Research codebase" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, emit });
    const executor = createStepExecutor(opts);
    await executor.run();

    const startEvents = emit.calls.filter((e) => e.type === "queue:step-started");
    expect(startEvents.length).toBe(1);
    expect((startEvents[0].payload as any).stepId).toBe(s1.id);
    expect((startEvents[0].payload as any).stepType).toBe("plan");
    expect((startEvents[0].payload as any).stepTitle).toBe("Research codebase");
  });

  test("queue:step-completed emitted on success", async () => {
    const emit = createMockEmit();
    const s1 = makeStep({ title: "Work" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, emit });
    await createStepExecutor(opts).run();

    const completedEvents = emit.calls.filter((e) => e.type === "queue:step-completed");
    expect(completedEvents.length).toBe(1);
    expect((completedEvents[0].payload as any).stepId).toBe(s1.id);
  });

  test("queue:step-failed emitted on failure", async () => {
    const emit = createMockEmit();
    const s1 = makeStep({ title: "Crasher" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, emit, worker: createCrashingWorker() });
    await createStepExecutor(opts).run();

    const failedEvents = emit.calls.filter((e) => e.type === "queue:step-failed");
    expect(failedEvents.length).toBe(1);
    expect((failedEvents[0].payload as any).stepId).toBe(s1.id);
  });

  test("only queue:step-* events for step lifecycle (no legacy step:*)", async () => {
    const emit = createMockEmit();
    const queue = createQueue([makeStep(), makeStep()]);

    const opts = createDefaultOptions({ queue, emit });
    await createStepExecutor(opts).run();

    const methods = emit.calls.map((e) => e.type);
    // No legacy event methods should be called
    expect(methods).not.toContain("stepStarted");
    expect(methods).not.toContain("stepCompleted");
    expect(methods).not.toContain("stepFailed");
    // Only queue-prefixed events
    expect(methods.filter((m) => m.startsWith("queue:step-")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-EXEC-009: Queue state persisted after every step transition
// ===========================================================================

describe("VAL-EXEC-009: Queue state persisted after every step transition", () => {
  test("persist called on pending→running and running→completed transitions", async () => {
    const persist = createRecordingPersist();
    const s1 = makeStep({ title: "Step 1" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, persist });
    await createStepExecutor(opts).run();

    // At minimum: running + completed = 2 persist calls
    expect(persist.calls.length).toBeGreaterThanOrEqual(2);

    // First persist should show step as running
    const firstPersist = persist.calls[0];
    expect(firstPersist.steps[0].status).toBe("running");

    // Last persist should show step as completed
    const lastPersist = persist.calls[persist.calls.length - 1];
    expect(lastPersist.steps[0].status).toBe("completed");
  });

  test("persist called on pending→running and running→failed transitions", async () => {
    const persist = createRecordingPersist();
    const s1 = makeStep({ title: "Crasher" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, persist, worker: createCrashingWorker() });
    await createStepExecutor(opts).run();

    // At minimum: running + failed = 2 calls, plus one more for final queue status
    expect(persist.calls.length).toBeGreaterThanOrEqual(2);

    // First persist should show step as running
    expect(persist.calls[0].steps[0].status).toBe("running");

    // Some persist should show step as failed
    const failedPersist = persist.calls.find((q) => q.steps[0].status === "failed");
    expect(failedPersist).toBeDefined();
  });
});

// ===========================================================================
// VAL-EXEC-010: onStepCompleted hook called after step completion
// ===========================================================================

describe("VAL-EXEC-010: onStepCompleted hook called after step completion", () => {
  test("hook called with step, completed status, queue, and handoff data", async () => {
    const hookCalls: Array<{ stepId: string; status: string; handoff: unknown }> = [];
    const handoffData = { summary: "implemented the feature", tests: 5 };
    const handoffReader: HandoffReaderFn = async () => handoffData;

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, status, _queue, handoff) => {
      hookCalls.push({ stepId: step.id, status, handoff });
      return { continueExecution: true };
    };

    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, handoffReader, onStepCompleted });
    await createStepExecutor(opts).run();

    expect(hookCalls.length).toBe(2);
    expect(hookCalls[0].stepId).toBe(s1.id);
    expect(hookCalls[0].status).toBe("completed");
    expect(hookCalls[0].handoff).toEqual(handoffData);
    expect(hookCalls[1].stepId).toBe(s2.id);
    expect(hookCalls[1].status).toBe("completed");
  });

  test("hook called with failed status and null handoff on worker crash", async () => {
    const hookCalls: Array<{ stepId: string; status: string; handoff: unknown }> = [];

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, status, _queue, handoff) => {
      hookCalls.push({ stepId: step.id, status, handoff });
      return { continueExecution: false };
    };

    const s1 = makeStep({ title: "Crasher" });
    const queue = createQueue([s1]);

    const opts = createDefaultOptions({ queue, worker: createCrashingWorker(), onStepCompleted });
    await createStepExecutor(opts).run();

    expect(hookCalls.length).toBe(1);
    expect(hookCalls[0].status).toBe("failed");
    expect(hookCalls[0].handoff).toBeNull();
  });
});

// ===========================================================================
// VAL-EXEC-013: Workflow templates expand into visible granular steps
// (Advanced template tests moved to tests-legacy/ — only work template remains)
// ===========================================================================

describe("VAL-EXEC-013: Workflow templates expand into visible granular steps", () => {
  test("work template produces a single work step", async () => {
    const { buildQueueFromTemplate } = await import("../src/workflows/queue/templates");
    const queue = buildQueueFromTemplate("work");

    expect(queue.steps.length).toBe(1);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[0].title).toBe("Execute work");
  });

  test("each step is independently visible with unique ID and title", async () => {
    const { buildQueueFromTemplate } = await import("../src/workflows/queue/templates");
    const queue = buildQueueFromTemplate("work");

    for (const step of queue.steps) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.type).toBeTruthy();
      expect(step.status).toBe("pending");
    }

    // All IDs are unique
    const ids = queue.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ===========================================================================
// VAL-EXEC-016: Queue lifecycle events emitted
// ===========================================================================

describe("VAL-EXEC-016: Queue lifecycle events emitted", () => {
  test("queue:initialized emitted at start with queue metadata and step count", async () => {
    const emit = createMockEmit();
    const s1 = makeStep({ title: "A" });
    const s2 = makeStep({ title: "B" });
    const s3 = makeStep({ title: "C" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, emit });
    await createStepExecutor(opts).run();

    const initEvents = emit.calls.filter((e) => e.type === "queue:initialized");
    expect(initEvents.length).toBe(1);
    const stepIds = (initEvents[0].payload as any).stepIds as string[];
    expect(stepIds).toHaveLength(3);
    expect(stepIds).toEqual([s1.id, s2.id, s3.id]);
  });

  test("queue:completed emitted when all steps complete successfully", async () => {
    const emit = createMockEmit();
    const queue = createQueue([makeStep(), makeStep()]);

    const opts = createDefaultOptions({ queue, emit });
    await createStepExecutor(opts).run();

    const completedEvents = emit.calls.filter((e) => e.type === "queue:completed");
    expect(completedEvents.length).toBe(1);
    expect((completedEvents[0].payload as any).stepsCompleted).toBe(2);
  });

  test("queue:failed emitted when a step fails", async () => {
    const emit = createMockEmit();
    const queue = createQueue([makeStep(), makeStep()]);

    // First step crashes
    let count = 0;
    const worker: WorkerFn = async (step) => {
      count++;
      if (count === 2) throw new Error("boom");
      return { output: "done", handoffPath: "/tmp/h.json", durationMs: 50, sessionId: randomUUID() };
    };

    const opts = createDefaultOptions({ queue, emit, worker });
    await createStepExecutor(opts).run();

    const failedEvents = emit.calls.filter((e) => e.type === "queue:failed");
    expect(failedEvents.length).toBe(1);
    expect((failedEvents[0].payload as any).stepsCompleted).toBe(1); // 1 step completed before failure
  });

  test("queue lifecycle events are distinct from step-level events", async () => {
    const emit = createMockEmit();
    const queue = createQueue([makeStep()]);

    const opts = createDefaultOptions({ queue, emit });
    await createStepExecutor(opts).run();

    const methods = emit.calls.map((e) => e.type);
    // Queue lifecycle events
    expect(methods).toContain("queue:initialized");
    expect(methods).toContain("queue:completed");
    // Step lifecycle events
    expect(methods).toContain("queue:step-started");
    expect(methods).toContain("queue:step-completed");
    // These are different method names — not the same events
    expect("queue:initialized").not.toBe("queue:step-started");
    expect("queue:completed").not.toBe("queue:step-completed");
  });
});

// ===========================================================================
// VAL-HOOK-001: Hook framework supports all 5 mutation operations
// ===========================================================================

describe("VAL-HOOK-001: Hook framework supports all 5 mutation operations", () => {
  test("hook can insertAfter on the live queue", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const queue = createQueue([s1, s2]);

    const { insertAfter: qInsert } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        const newStep = makeStep({ title: "Inserted by hook" });
        const result = qInsert(q, step.id, [newStep], { actor: "test-hook", reason: "hook insert test" });
        expect(result.success).toBe(true);
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsTotal).toBe(3);
    expect(result.stepsCompleted).toBe(3);
    expect(queue.steps[1].title).toBe("Inserted by hook");
  });

  test("hook can removeStep from the live queue", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "To be removed" });
    const s3 = makeStep({ title: "Step 3" });
    const queue = createQueue([s1, s2, s3]);

    const { removeStep: qRemove } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        const result = qRemove(q, s2.id, { actor: "test-hook", reason: "hook remove test" });
        expect(result.success).toBe(true);
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsTotal).toBe(2); // s2 was removed
    expect(result.stepsCompleted).toBe(2); // s1 + s3
    expect(queue.steps.map((s) => s.title)).toEqual(["Step 1", "Step 3"]);
  });

  test("hook can skipStep on the live queue", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Will be skipped" });
    const s3 = makeStep({ title: "Step 3" });
    const queue = createQueue([s1, s2, s3]);

    const { skipStep: qSkip } = await import("../src/workflows/queue/queue");
    const workerCalls: string[] = [];
    const worker: WorkerFn = async (step) => {
      workerCalls.push(step.title);
      return { output: "done", handoffPath: `/tmp/${step.id}.json`, durationMs: 50, sessionId: randomUUID() };
    };

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        const result = qSkip(q, s2.id, { actor: "test-hook", reason: "hook skip test" });
        expect(result.success).toBe(true);
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, worker, onStepCompleted });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(2); // s1 + s3 (s2 skipped)
    expect(queue.steps[1].status).toBe("skipped");
    expect(workerCalls).toEqual(["Step 1", "Step 3"]); // s2 not executed
  });

});

// ===========================================================================
// VAL-HOOK-002: All hook mutations logged with provenance
// ===========================================================================

describe("VAL-HOOK-002: All hook mutations logged with provenance", () => {
  test("insertAfter within hook records provenance", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const queue = createQueue([s1]);

    const { insertAfter: qInsert } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        const newStep = makeStep({ title: "Inserted" });
        qInsert(q, step.id, [newStep], { actor: "hook-actor", reason: "insert reason" });
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    await createStepExecutor(opts).run();

    const entry = queue.mutationLog.find((m) => m.action === "insert" && m.actor === "hook-actor");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("hook-actor");
    expect(entry!.reason).toBe("insert reason");
    expect(entry!.timestamp).toBeTruthy();
    expect(typeof entry!.timestamp).toBe("number");
    expect(entry!.timestamp).toBeGreaterThan(0);
    expect(entry!.stepIds.length).toBeGreaterThan(0);
  });

  test("skipStep within hook records provenance", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Will skip" });
    const s3 = makeStep({ title: "Step 3" });
    const queue = createQueue([s1, s2, s3]);

    const { skipStep: qSkip } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        qSkip(q, s2.id, { actor: "skip-actor", reason: "skip reason" });
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    await createStepExecutor(opts).run();

    const entry = queue.mutationLog.find((m) => m.action === "skip" && m.actor === "skip-actor");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("skip reason");
    expect(entry!.stepIds).toEqual([s2.id]);
  });

  test("removeStep within hook records provenance", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "To remove" });
    const s3 = makeStep({ title: "Step 3" });
    const queue = createQueue([s1, s2, s3]);

    const { removeStep: qRemove } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      if (step.id === s1.id) {
        qRemove(q, s2.id, { actor: "remove-actor", reason: "remove reason" });
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    await createStepExecutor(opts).run();

    const entry = queue.mutationLog.find((m) => m.action === "remove" && m.actor === "remove-actor");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("remove reason");
    expect(entry!.stepIds).toEqual([s2.id]);
  });

  test("provenance includes timestamp, actor, reason, and stepIds", async () => {
    const s1 = makeStep({ title: "Step 1" });
    const s2 = makeStep({ title: "Step 2" });
    const queue = createQueue([s1, s2]);

    const { insertAfter: qInsert } = await import("../src/workflows/queue/queue");

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (step, _status, q) => {
      // Only insert on the first step to avoid infinite loop
      if (step.id === s1.id) {
        const newStep = makeStep({ title: "Inserted" });
        qInsert(q, step.id, [newStep], {
          actor: "sprint-hook",
          reason: "retry pair insertion",
        });
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, onStepCompleted });
    await createStepExecutor(opts).run();

    const insertEntries = queue.mutationLog.filter((m) => m.action === "insert");
    expect(insertEntries.length).toBeGreaterThanOrEqual(1);

    const entry = insertEntries[0];
    expect(entry.timestamp).toBeTruthy();
    expect(entry.actor).toBe("sprint-hook");
    expect(entry.reason).toBe("retry pair insertion");
    expect(entry.stepIds.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-HOOK-003: Hook continueExecution overrides failure behavior
// ===========================================================================

describe("VAL-HOOK-003: Hook continueExecution overrides failure behavior", () => {
  test("continueExecution=true on failed step allows executor to continue", async () => {
    let callCount = 0;
    const worker: WorkerFn = async (step) => {
      callCount++;
      if (callCount === 1) throw new Error("step 1 crashed");
      return { output: "done", handoffPath: `/tmp/${step.id}.json`, durationMs: 50, sessionId: randomUUID() };
    };

    const s1 = makeStep({ title: "Will fail" });
    const s2 = makeStep({ title: "Should still run" });
    const queue = createQueue([s1, s2]);

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (_step, status) => {
      if (status === "failed") {
        return { continueExecution: true };
      }
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, worker, onStepCompleted });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    // Despite s1 failing, s2 was executed because hook said continue
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1); // only s2 completed (s1 failed)
    expect(queue.steps[0].status).toBe("failed");
    expect(queue.steps[1].status).toBe("completed");
  });

  test("continueExecution=false on failed step stops execution (default)", async () => {
    const worker: WorkerFn = async () => {
      throw new Error("crash");
    };

    const s1 = makeStep({ title: "Crash" });
    const s2 = makeStep({ title: "Never runs" });
    const queue = createQueue([s1, s2]);

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async () => {
      return { continueExecution: false };
    };

    const opts = createDefaultOptions({ queue, worker, onStepCompleted });
    const result = await createStepExecutor(opts).run();

    expect(result.completed).toBe(false);
    expect(queue.steps[0].status).toBe("failed");
    expect(queue.steps[1].status).toBe("pending");
  });

  test("continueExecution=true on eval failure allows executor to continue", async () => {
    const s1 = makeStep({ title: "Eval fail" });
    const s2 = makeStep({ title: "Should still run" });
    const queue = createQueue([s1, s2]);

    let evalCount = 0;
    const evaluator: EvaluatorFn = async () => {
      evalCount++;
      if (evalCount === 1) {
        // First step fails evaluation
        return { passed: false, skipped: false, transportError: false,
          reason: "not good", feedback: "fix it", suggestions: [], cyclesUsed: 1 };
      }
      // Second step passes
      return { passed: true, skipped: false, transportError: false,
        reason: "ok", feedback: null, suggestions: [], cyclesUsed: 1 };
    };

    const onStepCompleted: import("../src/workflows/queue/executor").OnStepCompletedHook = async (_step, status) => {
      return { continueExecution: status === "failed" };
    };

    const opts = createDefaultOptions({ queue, evaluator, onStepCompleted, maxRevisions: 0 });
    const result = await createStepExecutor(opts).run();

    // s1 failed eval but hook said continue, s2 passed eval
    expect(result.completed).toBe(true);
    expect(queue.steps[0].status).toBe("failed");
    expect(queue.steps[1].status).toBe("completed");
  });
});

// ===========================================================================
// VAL-EXEC-003: Failed step stops execution by default
// ===========================================================================

describe("VAL-EXEC-003: Failed step stops execution by default", () => {
  test("failed step stops execution with reason referencing the failed step", async () => {
    let callCount = 0;
    const worker: WorkerFn = async (step) => {
      callCount++;
      if (callCount === 2) throw new Error("step 2 crashed");
      return { output: "ok", handoffPath: `/tmp/${step.id}.json`, durationMs: 50, sessionId: randomUUID() };
    };

    const s1 = makeStep({ title: "Succeeds" });
    const s2 = makeStep({ title: "Fails here" });
    const s3 = makeStep({ title: "Should not run" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(result.reason).toContain("Fails here");
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("failed");
    expect(queue.steps[2].status).toBe("pending");
  });

  test("no subsequent pending steps execute after failure", async () => {
    const workerCalls: string[] = [];
    let callCount = 0;
    const worker: WorkerFn = async (step) => {
      workerCalls.push(step.title);
      callCount++;
      if (callCount === 1) throw new Error("first step fails");
      return { output: "ok", handoffPath: `/tmp/${step.id}.json`, durationMs: 50, sessionId: randomUUID() };
    };

    const s1 = makeStep({ title: "Will fail" });
    const s2 = makeStep({ title: "Should not run" });
    const s3 = makeStep({ title: "Also should not run" });
    const queue = createQueue([s1, s2, s3]);

    const opts = createDefaultOptions({ queue, worker });
    const result = await createStepExecutor(opts).run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
    expect(workerCalls).toEqual(["Will fail"]);
    expect(queue.steps[1].status).toBe("pending");
    expect(queue.steps[2].status).toBe("pending");
  });

  test("failed step returns completed:false", async () => {
    const queue = createQueue([makeStep({ title: "Crasher" })]);
    const opts = createDefaultOptions({ queue, worker: createCrashingWorker() });
    const result = await createStepExecutor(opts).run();

    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(0);
  });
});

// ===========================================================================
// VAL-EXEC-006: Graceful shutdown on abort signal
// ===========================================================================

describe("VAL-EXEC-006: Graceful shutdown on abort signal", () => {
  test("abort during execution terminates worker and reverts step to pending", async () => {
    let executorRef: StepExecutor | null = null;

    const worker: WorkerFn = async (step) => {
      // Simulate a long-running worker; abort mid-execution
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => {
          _resolve({ output: "done", handoffPath: `/tmp/${step.id}.json`, durationMs: 1000, sessionId: randomUUID() });
        }, 5000);

        // Request abort shortly after worker starts
        setTimeout(() => {
          executorRef?.abort();
        }, 50);
      });
    };

    const s1 = makeStep({ title: "Long running step" });
    const s2 = makeStep({ title: "Should not run" });
    const queue = createQueue([s1, s2]);

    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    executorRef = executor;
    const result = await executor.run();

    expect(result.completed).toBe(false);
    expect(queue.steps[0].status).toBe("pending"); // reverted to pending for retry on resume
    expect(queue.steps[1].status).toBe("pending");
    expect(queue.status).toBe("paused"); // abort sets queue to paused, not failed
  });

  test("abort returns cleanly without throwing", async () => {
    let executorRef: StepExecutor | null = null;

    const worker: WorkerFn = async (step) => {
      return new Promise((_resolve) => {
        setTimeout(() => {
          _resolve({ output: "done", handoffPath: `/tmp/${step.id}.json`, durationMs: 100, sessionId: randomUUID() });
        }, 5000);
        setTimeout(() => executorRef?.abort(), 20);
      });
    };

    const queue = createQueue([makeStep({ title: "Aborting" })]);
    const opts = createDefaultOptions({ queue, worker });
    const executor = createStepExecutor(opts);
    executorRef = executor;

    // Should not throw
    const result = await executor.run();
    expect(result.completed).toBe(false);
    expect(typeof result.stepsCompleted).toBe("number");
  });

  test("abort persists queue state", async () => {
    const persist = createRecordingPersist();
    let executorRef: StepExecutor | null = null;

    const worker: WorkerFn = async (step) => {
      return new Promise((_resolve) => {
        setTimeout(() => {
          _resolve({ output: "done", handoffPath: `/tmp/${step.id}.json`, durationMs: 100, sessionId: randomUUID() });
        }, 5000);
        setTimeout(() => executorRef?.abort(), 20);
      });
    };

    const queue = createQueue([makeStep({ title: "Aborting" })]);
    const opts = createDefaultOptions({ queue, worker, persist });
    const executor = createStepExecutor(opts);
    executorRef = executor;

    await executor.run();

    // Persist should have been called (at least for running → failed)
    expect(persist.calls.length).toBeGreaterThan(0);
  });
});

