import { describe, it, expect } from "bun:test";
import { createStepExecutor, type StepExecutorOptions } from "../src/queue/executor";
import { createGuardrails, type Guardrails } from "../src/queue/guardrails";
import { createQueue } from "../src/queue/queue";
import { createCompositeHook, createPlanIntegrationHook } from "../src/queue/plan-integration";
import { createFeatureQualityGateHook } from "../src/queue/feature-quality-gates";
import type { Step, Queue } from "../src/queue/types";
import type { FlywheelEmitter } from "../src/events/event-bus";

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

function makeEmitter(): FlywheelEmitter {
  return {
    queueInitialized: () => {},
    queueCompleted: () => {},
    queueFailed: () => {},
    queueStepStarted: () => {},
    queueStepCompleted: () => {},
    queueStepFailed: () => {},
    queueStepInserted: () => {},
    workerOutput: () => {},
  } as unknown as FlywheelEmitter;
}

function makeExecutorOptions(
  queue: Queue,
  overrides?: Partial<StepExecutorOptions>,
): StepExecutorOptions {
  return {
    queue,
    workflowId: "test-wf",
    emitter: makeEmitter(),
    dispatcher: async (step) => ({
      prompt: `Execute ${step.title}`,
      validationCriteria: null,
    }),
    worker: async () => ({
      output: "done",
      handoffPath: "",
      durationMs: 100,
    }),
    evaluator: null,
    handoffReader: async () => null,
    budgetChecker: { isExhausted: () => false },
    persist: async () => {},
    accumulator: { accumulate: () => {}, getContext: () => ({}) },
    maxRevisions: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Guardrails wiring into executor
// ---------------------------------------------------------------------------

describe("Guardrails wiring into executor", () => {
  it("passes mutation_budget to dispatcher context when guardrails provided", async () => {
    const guardrails = createGuardrails({
      maxQueueLength: 50,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
      sessionObjective: "Build a hello world endpoint",
    });

    let capturedContext: Record<string, unknown> | null = null;
    const queue = createQueue([makeStep({ id: "s1" })]);
    const opts = makeExecutorOptions(queue, {
      guardrails,
      dispatcher: async (_step, context) => {
        capturedContext = context;
        return { prompt: "test", validationCriteria: null };
      },
    });

    await createStepExecutor(opts).run();

    expect(capturedContext).not.toBeNull();
    expect(capturedContext!.mutation_budget).toBeDefined();

    const budget = capturedContext!.mutation_budget as Record<string, unknown>;
    expect(budget.maxQueueLength).toBe(50);
    expect(budget.currentQueueLength).toBe(1);
    expect(budget.remainingQueueCapacity).toBe(49);
    expect(budget.mutationsUsedThisStep).toBe(0);
    expect(budget.mutationsRemainingThisStep).toBe(3);
    expect(budget.totalSessionInserts).toBe(0);
    expect(budget.sessionInsertsRemaining).toBe(20);
  });

  it("passes session_objective to dispatcher context when guardrails provided", async () => {
    const guardrails = createGuardrails({
      sessionObjective: "Implement auth middleware",
    });

    let capturedContext: Record<string, unknown> | null = null;
    const queue = createQueue([makeStep({ id: "s1" })]);
    const opts = makeExecutorOptions(queue, {
      guardrails,
      dispatcher: async (_step, context) => {
        capturedContext = context;
        return { prompt: "test", validationCriteria: null };
      },
    });

    await createStepExecutor(opts).run();

    expect(capturedContext).not.toBeNull();
    expect(capturedContext!.session_objective).toBe("Implement auth middleware");
  });

  it("omits mutation_budget and session_objective when no guardrails", async () => {
    let capturedContext: Record<string, unknown> | null = null;
    const queue = createQueue([makeStep({ id: "s1" })]);
    const opts = makeExecutorOptions(queue, {
      guardrails: null,
      dispatcher: async (_step, context) => {
        capturedContext = context;
        return { prompt: "test", validationCriteria: null };
      },
    });

    await createStepExecutor(opts).run();

    expect(capturedContext).not.toBeNull();
    expect(capturedContext!.mutation_budget).toBeUndefined();
    expect(capturedContext!.session_objective).toBeUndefined();
  });

  it("mutation_budget reflects current queue length dynamically", async () => {
    const guardrails = createGuardrails({ maxQueueLength: 10 });
    const capturedBudgets: Array<Record<string, unknown>> = [];

    const queue = createQueue([
      makeStep({ id: "s1" }),
      makeStep({ id: "s2" }),
      makeStep({ id: "s3" }),
    ]);

    const opts = makeExecutorOptions(queue, {
      guardrails,
      dispatcher: async (_step, context) => {
        if (context.mutation_budget) {
          capturedBudgets.push(context.mutation_budget as Record<string, unknown>);
        }
        return { prompt: "test", validationCriteria: null };
      },
    });

    await createStepExecutor(opts).run();

    expect(capturedBudgets.length).toBe(3);
    // All 3 steps see the same queue length (no inserts)
    for (const budget of capturedBudgets) {
      expect(budget.currentQueueLength).toBe(3);
      expect(budget.remainingQueueCapacity).toBe(7);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Feature quality gates hook wiring via createCompositeHook
// ---------------------------------------------------------------------------

describe("Feature quality gates hook wiring via createCompositeHook", () => {
  it("createCompositeHook chains plan-integration and feature-quality-gates hooks", async () => {
    const planHook = createPlanIntegrationHook();
    const featureGateHook = createFeatureQualityGateHook();

    const composite = createCompositeHook([
      planHook,
      featureGateHook.onStepCompleted,
    ]);

    // Simulate a non-plan step completing — neither hook should insert
    const step = makeStep({ id: "s1", feature: "auth" });
    const queue = createQueue([step]);
    step.status = "completed";

    const result = await composite(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });

  it("feature quality gate inserts quality check when all feature steps complete", async () => {
    const featureGateHook = createFeatureQualityGateHook();

    const step1 = makeStep({ id: "s1", feature: "auth" });
    const step2 = makeStep({ id: "s2", feature: "auth" });
    const queue = createQueue([step1, step2]);

    // Manually transition steps to completed (simulating executor behavior)
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";

    // Trigger the hook on the last step completion
    await featureGateHook.onStepCompleted(queue.steps[1], "completed", queue, null);

    // A quality check step should have been inserted
    const qualitySteps = queue.steps.filter(
      (s) => s.type === "verify" && s.title.includes("feature quality check"),
    );
    expect(qualitySteps.length).toBe(1);
    expect(qualitySteps[0].feature).toBe("auth");
  });

  it("composite hook with all three hooks (plan + sprint + feature gates)", async () => {
    const planHook = createPlanIntegrationHook();
    const featureGateHook = createFeatureQualityGateHook();
    // Sprint hook is a function, not an object — use a no-op for testing
    const sprintHook = async () => ({ continueExecution: false });

    const composite = createCompositeHook([
      planHook,
      sprintHook,
      featureGateHook.onStepCompleted,
    ]);

    expect(composite).toBeDefined();
    expect(typeof composite).toBe("function");

    // A completed work step with no plan output and no feature
    const step = makeStep({ id: "s1" });
    const queue = createQueue([step]);
    step.status = "completed";
    const result = await composite(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Guardrails getMutationBudget and getSessionObjective
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

  it("budget decreases after recording mutations", () => {
    const guardrails = createGuardrails({
      maxMutationsPerStepCompletion: 3,
    });

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");

    const budget = guardrails.getMutationBudget("step-1", 5);
    expect(budget.mutationsUsedThisStep).toBe(2);
    expect(budget.mutationsRemainingThisStep).toBe(1);
  });
});

describe("Guardrails getSessionObjective", () => {
  it("returns the configured session objective", () => {
    const guardrails = createGuardrails({
      sessionObjective: "Build authentication system",
    });

    expect(guardrails.getSessionObjective()).toBe("Build authentication system");
  });

  it("returns empty string when no objective configured", () => {
    const guardrails = createGuardrails();
    expect(guardrails.getSessionObjective()).toBe("");
  });
});
