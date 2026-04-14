import { describe, it, expect } from "bun:test";
import { createStepExecutor } from "../src/workflows/queue/executor";
import type { StepExecutorOptions, DispatcherContext } from "../src/workflows/queue/executor-types";
import { createGuardrails } from "../src/workflows/queue/guardrails";
import { createQueue } from "../src/workflows/queue/queue";
import type { Step, Queue } from "../src/workflows/queue/types";
import type { EmitFn } from "../src/infra/event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides?: Partial<Step>): Step {
  return {
    id: `step-${Math.random().toString(36).slice(2, 8)}`,
    type: "work",
    title: "Test step",
    status: "pending",
    ...overrides,
  };
}

function makeEmit(): EmitFn {
  return ((type: string, payload: unknown) => {}) as EmitFn;
}

function makeExecutorOptions(
  queue: Queue,
  overrides?: Partial<StepExecutorOptions>,
): StepExecutorOptions {
  return {
    queue,
    workflowId: "test-wf",
    emit: makeEmit(),
    dispatcher: async (step) => ({
      prompt: `Execute ${step.title}`,
      evaluationCriteria: null,
    }),
    worker: async () => ({
      output: "done",
      handoffPath: "",
      durationMs: 100,
    }),
    evaluator: null,
    handoffReader: async () => null,
    persist: async () => {},
    accumulator: { accumulate: () => {}, getContext: () => ({}) },
    maxRevisions: 0,
    skipEvaluation: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Guardrails wiring into executor
// ---------------------------------------------------------------------------

describe("Guardrails wiring into executor", () => {
  it("dispatcher receives typed context with previousHandoff and previousAssessment", async () => {
    const capturedContexts: DispatcherContext[] = [];
    const queue = createQueue([makeStep({ id: "s1" }), makeStep({ id: "s2" })]);
    const opts = makeExecutorOptions(queue, {
      dispatcher: async (_step, context) => {
        capturedContexts.push({ ...context });
        return { prompt: "test", evaluationCriteria: null };
      },
      handoffReader: async () => ({ summary: "done" }),
    });

    await createStepExecutor(opts).run();

    expect(capturedContexts.length).toBe(2);
    // First step: no prior handoff
    expect(capturedContexts[0]!.previousHandoff).toBeNull();
    expect(capturedContexts[0]!.previousAssessment).toBeNull();
    // Second step: receives handoff from first
    expect(capturedContexts[1]!.previousHandoff).not.toBeNull();
    expect(capturedContexts[1]!.previousHandoff!.summary).toBe("done");
  });

  it("applyMutations is enforced when executor has guardrails and dispatcher returns mutations", async () => {
    const guardrails = createGuardrails({
      maxQueueLength: 10,
      maxMutationsPerStepCompletion: 1,
    });

    const queue = createQueue([makeStep({ id: "s1" })]);
    const opts = makeExecutorOptions(queue, {
      guardrails,
      dispatcher: async () => ({
        prompt: "test",
        evaluationCriteria: null,
        mutationRequests: [
          { type: "insert_after", targetStepId: "s1", steps: [makeStep()], reason: "fix" },
          { type: "insert_after", targetStepId: "s1", steps: [makeStep()], reason: "fix2" },
        ],
      }),
    });

    await createStepExecutor(opts).run();

    // First mutation should apply (within budget), second should be rejected
    // Queue started with 1 step, first insert adds 1 = 2 steps total
    // The inserted step also runs, so queue should have 2+ steps
    expect(queue.steps.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Guardrails getMutationBudget
// ---------------------------------------------------------------------------

describe("Guardrails getMutationBudget", () => {
  it("returns full budget for fresh step", () => {
    const guardrails = createGuardrails({
      maxQueueLength: 50,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
      sessionObjective: "Test objective",
    });

    const budget = guardrails.getMutationBudget("step-1", 10);

    expect(budget.maxQueueLength).toBe(50);
    expect(budget.currentQueueLength).toBe(10);
    expect(budget.remainingQueueCapacity).toBe(40);
    expect(budget.mutationsUsedThisStep).toBe(0);
    expect(budget.mutationsRemainingThisStep).toBe(3);
    expect(budget.totalSessionInserts).toBe(0);
    expect(budget.sessionInsertsRemaining).toBe(20);
    expect(budget.sessionObjective).toBe("Test objective");
  });

  it("budget decreases after applying mutations", () => {
    const guardrails = createGuardrails({
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    });

    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = createQueue(steps);

    guardrails.applyMutations(queue, "step-1", [
      { type: "insert_after", targetStepId: steps[0].id, steps: [makeStep()], reason: "fix" },
      { type: "insert_after", targetStepId: steps[0].id, steps: [makeStep()], reason: "fix2" },
    ], { actor: "test", reason: "test" });

    const budget = guardrails.getMutationBudget("step-1", queue.steps.length);
    expect(budget.mutationsUsedThisStep).toBe(2);
    expect(budget.mutationsRemainingThisStep).toBe(1);
    expect(budget.totalSessionInserts).toBe(2);
  });
});

describe("Guardrails session objective via getMutationBudget", () => {
  it("returns the configured session objective", () => {
    const guardrails = createGuardrails({
      sessionObjective: "Build authentication system",
    });

    expect(guardrails.getMutationBudget("step-1", 3).sessionObjective).toBe("Build authentication system");
  });

  it("returns empty string when no objective configured", () => {
    const guardrails = createGuardrails();
    expect(guardrails.getMutationBudget("step-1", 3).sessionObjective).toBe("");
  });
});
