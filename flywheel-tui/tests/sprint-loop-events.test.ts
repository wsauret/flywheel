/**
 * Sprint Loop — Event emission, evaluator degradation, and skip_evaluation tests.
 *
 * Tests for:
 * - VAL-LOOP-013: Evaluator transport failure degrades to script exit code
 * - VAL-LOOP-014: Sprint events emitted for TUI integration
 * - VAL-LOOP-015: Graceful degradation without evaluator transport
 * - VAL-LOOP-016: Budget exhaustion during sprint stops loop
 * - VAL-LOOP-017: skip_evaluation config interaction with sprint
 */

import { describe, it, expect } from "bun:test";
import type { WorkerResult } from "../src/schemas/worker";
import type { WorkerHandoff } from "../src/schemas/handoff";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { BudgetTracker } from "../src/session/budget-tracker";
import type { BudgetLimits } from "../src/schemas/shared";
import type { VerificationResult } from "../src/sprint/verification-runner";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import {
  createSprintLoop,
  type SprintLoopOptions,
} from "../src/sprint/sprint-loop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides } as FlywheelConfig;
}

function makeWorkerResult(handoffPath: string, output = "done"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath,
  };
}

function makeHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
  return {
    summary: "Implemented the feature and wrote verification script.",
    verification_script_path: ".flywheel/verify/sprint-test.ts",
    artifacts: { files_created: ["src/hello.ts"], files_modified: [] },
    verification: { tests_passed: true, test_output_summary: "All tests pass" },
    ...overrides,
  } as WorkerHandoff;
}

function passingVerification(): VerificationResult {
  return {
    passed: true,
    stdout: "All checks passed\n",
    stderr: "",
    exitCode: 0,
    durationMs: 500,
  };
}

function failingVerification(stdout = "FAIL: expected 200 got 404\n"): VerificationResult {
  return {
    passed: false,
    stdout,
    stderr: "",
    exitCode: 1,
    durationMs: 500,
  };
}

function passingEvalResult(): EvaluatorResult {
  return {
    passed: true,
    reasoning: "Implementation correct, script rigorous",
    suggestions: [],
    confidence: 0.95,
    feedback: "",
    files_to_review: [],
    issues: [],
  };
}

function failingEvalResult(feedback = "Implementation incomplete"): EvaluatorResult {
  return {
    passed: false,
    reasoning: "Issues found",
    suggestions: ["Fix the endpoint"],
    confidence: 0.7,
    feedback,
    files_to_review: ["src/hello.ts"],
    issues: [],
  };
}

/** Mock executor that returns pre-configured results per call. */
function mockExecutor(results: WorkerResult[]) {
  let callIndex = 0;
  return {
    execute: async (_opts: unknown) => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      if (result.failure) {
        const { WorkerError } = await import("../src/controller/phase-executor");
        throw new WorkerError(result);
      }
      return result;
    },
    getStdinHandle: () => undefined,
  } as unknown as import("../src/controller/phase-executor").PhaseExecutor;
}

/** Mock evaluator transport. */
function mockEvaluator(results: EvaluatorResult[]): EvaluatorTransport {
  let callIndex = 0;
  return {
    invoke: async (_input: EvaluatorInput): Promise<EvaluatorResult> => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result;
    },
  };
}

/** Mock evaluator that throws on invoke. */
function throwingEvaluator(error: Error): EvaluatorTransport {
  return {
    invoke: async () => { throw error; },
  };
}

/** Mock budget tracker. */
function mockBudgetTracker(exhaustedAfter: number): BudgetTracker {
  let invocations = 0;
  return {
    handleEvent: () => {},
    getTotalCost: () => 0,
    incrementInvocations: () => { invocations++; },
    getInvocationsUsed: () => invocations,
    getTokensUsed: () => 0,
    isExhausted: (_limits: BudgetLimits) => invocations >= exhaustedAfter,
    getBudgetStatus: () => ({
      invocations_remaining: null,
      token_budget_remaining: null,
      wall_clock_deadline: null,
    }),
    flush: () => {},
    dispose: () => {},
  };
}

function collectEvents(eventBus: EventBus): FlywheelEvent[] {
  const events: FlywheelEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  return events;
}

/** Create test options with a fresh EventBus and emitter, returning both for inspection. */
function createTestOptionsWithBus(overrides?: Partial<SprintLoopOptions>) {
  const eventBus = new EventBus();
  const events = collectEvents(eventBus);
  const emitter = createFlywheelEmitter(eventBus);
  const adapter = new MockAdapter();
  adapter.connect(eventBus);

  const opts: SprintLoopOptions = {
    taskDescription: "Add a hello world endpoint",
    config: defaultConfig(),
    executor: mockExecutor([makeWorkerResult("/tmp/handoff.json")]),
    emitter,
    ui: adapter,
    workflowId: "test-sprint-events",
    _readHandoff: async () => makeHandoff(),
    _runVerification: async () => passingVerification(),
    ...overrides,
  };

  return { opts, eventBus, events, adapter };
}

// ---------------------------------------------------------------------------
// VAL-LOOP-013: Evaluator transport failure degrades to script exit code
// ---------------------------------------------------------------------------

describe("Sprint Loop Events & Degradation", () => {
  describe("VAL-LOOP-013: Evaluator transport failure degradation", () => {
    it("falls back to passing script exit code when evaluator transport throws", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: throwingEvaluator(new Error("Transport crashed")),
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      // Sprint should complete successfully using script exit code 0
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
      expect(result.escalated).toBe(false);
    });

    it("falls back to failing script exit code when evaluator throws and script fails", async () => {
      const { opts } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: throwingEvaluator(new Error("Transport timeout")),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      // Sprint should fail and escalate because script failed and only 1 iteration
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
    });

    it("emits evaluator:failed event when evaluator transport crashes", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: throwingEvaluator(new Error("Connection refused")),
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const evalFailed = events.find((e) => e.type === "evaluator:failed");
      expect(evalFailed).toBeDefined();
      expect((evalFailed as any).reason).toContain("Connection refused");
    });

    it("does not emit evaluator:completed when evaluator transport crashes", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: throwingEvaluator(new Error("Timeout")),
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const evalCompleted = events.filter((e) => e.type === "evaluator:completed");
      expect(evalCompleted).toHaveLength(0);
    });

    it("continues retry loop using script exit code after evaluator failure", async () => {
      let verifyCallCount = 0;
      const { opts } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: throwingEvaluator(new Error("Always fails")),
        _runVerification: async () => {
          verifyCallCount++;
          // Fail first 2, pass on 3rd
          if (verifyCallCount <= 2) return failingVerification(`FAIL attempt ${verifyCallCount}`);
          return passingVerification();
        },
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(3);
      // Evaluator was never the source of pass/fail — script was
      for (const record of result.iterationHistory) {
        expect(record.evaluatorPassed).toBeUndefined();
      }
    });

    it("records evaluatorPassed as undefined when evaluator transport fails", async () => {
      const { opts } = createTestOptionsWithBus({
        evaluatorTransport: throwingEvaluator(new Error("Transport failure")),
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.iterationHistory[0].evaluatorPassed).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-014: Sprint events emitted for TUI integration
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-014: Sprint event sequence and payloads", () => {
    it("emits correct event sequence for successful single-iteration sprint", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: mockEvaluator([passingEvalResult()]),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const sprintTypes = events
        .filter((e) => e.type.startsWith("sprint:"))
        .map((e) => e.type);

      // Expected order: started → iteration-started → verification-started → iteration-completed → completed
      expect(sprintTypes[0]).toBe("sprint:started");
      expect(sprintTypes[1]).toBe("sprint:iteration-started");
      expect(sprintTypes[2]).toBe("sprint:verification-started");
      expect(sprintTypes[3]).toBe("sprint:iteration-completed");
      expect(sprintTypes[4]).toBe("sprint:completed");
      expect(sprintTypes).toHaveLength(5);
    });

    it("sprint:started payload includes workflowId, taskDescription, maxIterations", async () => {
      const { opts, events } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      const started = events.find((e) => e.type === "sprint:started") as any;
      expect(started).toBeDefined();
      expect(started.workflowId).toBe("test-sprint-events");
      expect(started.taskDescription).toContain("hello world");
      expect(started.maxIterations).toBe(5);
      expect(started.timestamp).toBeTruthy();
    });

    it("sprint:iteration-started payload includes iteration number and maxIterations", async () => {
      const { opts, events } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      const iterStarted = events.find((e) => e.type === "sprint:iteration-started") as any;
      expect(iterStarted).toBeDefined();
      expect(iterStarted.iteration).toBe(1);
      expect(iterStarted.maxIterations).toBe(5);
      expect(iterStarted.workflowId).toBe("test-sprint-events");
    });

    it("sprint:verification-started payload includes iteration and scriptPath", async () => {
      const { opts, events } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      const verStarted = events.find((e) => e.type === "sprint:verification-started") as any;
      expect(verStarted).toBeDefined();
      expect(verStarted.iteration).toBe(1);
      expect(verStarted.scriptPath).toBe(".flywheel/verify/sprint-test.ts");
      expect(verStarted.workflowId).toBe("test-sprint-events");
    });

    it("sprint:iteration-completed payload includes pass/fail status", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: mockEvaluator([passingEvalResult()]),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const iterCompleted = events.find((e) => e.type === "sprint:iteration-completed") as any;
      expect(iterCompleted).toBeDefined();
      expect(iterCompleted.iteration).toBe(1);
      expect(iterCompleted.passed).toBe(true);
      expect(iterCompleted.workflowId).toBe("test-sprint-events");
    });

    it("sprint:completed payload includes completion status for success", async () => {
      const { opts, events } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      const completed = events.find((e) => e.type === "sprint:completed") as any;
      expect(completed).toBeDefined();
      expect(completed.completed).toBe(true);
      expect(completed.iterationsUsed).toBe(1);
      expect(completed.escalated).toBe(false);
      expect(completed.workflowId).toBe("test-sprint-events");
    });

    it("emits sprint:escalated before sprint:completed on hard cap", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const sprintTypes = events
        .filter((e) => e.type.startsWith("sprint:"))
        .map((e) => e.type);

      const escalatedIdx = sprintTypes.indexOf("sprint:escalated");
      const completedIdx = sprintTypes.indexOf("sprint:completed");

      expect(escalatedIdx).toBeGreaterThan(-1);
      expect(completedIdx).toBeGreaterThan(-1);
      expect(escalatedIdx).toBeLessThan(completedIdx);
    });

    it("sprint:escalated payload includes iterationsUsed and reason", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 2 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const escalated = events.find((e) => e.type === "sprint:escalated") as any;
      expect(escalated).toBeDefined();
      expect(escalated.iterationsUsed).toBe(2);
      expect(escalated.reason).toContain("Max iterations");
      expect(escalated.workflowId).toBe("test-sprint-events");
    });

    it("sprint:completed payload includes escalation info for escalated sprint", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const completed = events.find((e) => e.type === "sprint:completed") as any;
      expect(completed).toBeDefined();
      expect(completed.completed).toBe(false);
      expect(completed.escalated).toBe(true);
      expect(completed.reason).toContain("Max iterations");
    });

    it("emits correct event count for multi-iteration sprint", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult(), passingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const sprintEvents = events.filter((e) => e.type.startsWith("sprint:"));

      // 1 started + 3*(iteration-started + verification-started + iteration-completed) + 1 completed
      const iterationStartedCount = sprintEvents.filter((e) => e.type === "sprint:iteration-started").length;
      const verificationStartedCount = sprintEvents.filter((e) => e.type === "sprint:verification-started").length;
      const iterationCompletedCount = sprintEvents.filter((e) => e.type === "sprint:iteration-completed").length;

      expect(iterationStartedCount).toBe(3);
      expect(verificationStartedCount).toBe(3);
      expect(iterationCompletedCount).toBe(3);
    });

    it("iteration-completed events correctly reflect pass/fail per iteration", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult(), passingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const iterCompletedEvents = events
        .filter((e) => e.type === "sprint:iteration-completed")
        .map((e) => e as any);

      expect(iterCompletedEvents[0].passed).toBe(false);
      expect(iterCompletedEvents[0].iteration).toBe(1);
      expect(iterCompletedEvents[1].passed).toBe(false);
      expect(iterCompletedEvents[1].iteration).toBe(2);
      expect(iterCompletedEvents[2].passed).toBe(true);
      expect(iterCompletedEvents[2].iteration).toBe(3);
    });

    it("TUI adapter handles all sprint events via assertNever (compile-time check)", async () => {
      // This test verifies the adapter receives and processes sprint events
      // without throwing. assertNever exhaustiveness is verified at compile time.
      const { opts, adapter } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      // MockAdapter extends BaseUIAdapter and receives all events
      const sprintEvents = adapter.events.filter((e) => e.type.startsWith("sprint:"));
      expect(sprintEvents.length).toBeGreaterThan(0);
      // All sprint event types should be present
      const types = new Set(sprintEvents.map((e) => e.type));
      expect(types.has("sprint:started")).toBe(true);
      expect(types.has("sprint:iteration-started")).toBe(true);
      expect(types.has("sprint:verification-started")).toBe(true);
      expect(types.has("sprint:iteration-completed")).toBe(true);
      expect(types.has("sprint:completed")).toBe(true);
    });

    it("all sprint events have timestamp field", async () => {
      const { opts, events } = createTestOptionsWithBus();

      const handle = createSprintLoop(opts);
      await handle.run();

      const sprintEvents = events.filter((e) => e.type.startsWith("sprint:"));
      for (const event of sprintEvents) {
        expect((event as any).timestamp).toBeTruthy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-015: Graceful degradation without evaluator transport
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-015: No evaluator transport", () => {
    it("completes when script exits 0 and no evaluator configured", async () => {
      const { opts } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
    });

    it("retries to cap when script exits non-zero and no evaluator configured", async () => {
      const { opts } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        _runVerification: async () => failingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(3);
    });

    it("does not emit evaluator events when no evaluator configured", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const evalEvents = events.filter(
        (e) => e.type === "evaluator:invoked" || e.type === "evaluator:completed" || e.type === "evaluator:failed",
      );
      expect(evalEvents).toHaveLength(0);
    });

    it("still emits all sprint lifecycle events without evaluator", async () => {
      const { opts, events } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const sprintTypes = new Set(
        events.filter((e) => e.type.startsWith("sprint:")).map((e) => e.type),
      );
      expect(sprintTypes.has("sprint:started")).toBe(true);
      expect(sprintTypes.has("sprint:iteration-started")).toBe(true);
      expect(sprintTypes.has("sprint:verification-started")).toBe(true);
      expect(sprintTypes.has("sprint:iteration-completed")).toBe(true);
      expect(sprintTypes.has("sprint:completed")).toBe(true);
    });

    it("script exit code 0 maps to pass without evaluator over multiple iterations", async () => {
      let callCount = 0;
      const { opts } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        _runVerification: async () => {
          callCount++;
          if (callCount <= 2) return failingVerification();
          return passingVerification();
        },
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-016: Budget exhaustion during sprint stops loop
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-016: Budget exhaustion stops sprint", () => {
    it("stops with budget_exhausted when budget is pre-exhausted", async () => {
      const tracker = mockBudgetTracker(0); // Immediately exhausted
      const limits: BudgetLimits = {
        max_invocations: 0,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const { opts } = createTestOptionsWithBus({
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
      expect(result.escalated).toBe(false);
      expect(result.iterationsUsed).toBe(0);
    });

    it("budget_exhausted is distinct from escalation", async () => {
      const tracker = mockBudgetTracker(1);
      const limits: BudgetLimits = {
        max_invocations: 1,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        budgetTracker: tracker,
        budgetLimits: limits,
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.reason).toBe("budget_exhausted");
      expect(result.escalated).toBe(false);

      // No escalation events emitted
      const escalatedEvents = events.filter((e) => e.type === "sprint:escalated");
      expect(escalatedEvents).toHaveLength(0);
    });

    it("emits sprint:completed with budget_exhausted reason", async () => {
      const tracker = mockBudgetTracker(0);
      const limits: BudgetLimits = {
        max_invocations: 0,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const { opts, events } = createTestOptionsWithBus({
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const completed = events.find((e) => e.type === "sprint:completed") as any;
      expect(completed).toBeDefined();
      expect(completed.completed).toBe(false);
      expect(completed.reason).toBe("budget_exhausted");
      expect(completed.escalated).toBe(false);
    });

    it("stops between iterations when budget is exhausted after worker invocation", async () => {
      const tracker = mockBudgetTracker(2);
      const limits: BudgetLimits = {
        max_invocations: 2,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const { opts } = createTestOptionsWithBus({
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        budgetTracker: tracker,
        budgetLimits: limits,
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
      // Budget depleted after 2 worker invocations
      expect(result.iterationsUsed).toBeLessThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-017: skip_evaluation config interaction with sprint
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-017: skip_evaluation skips evaluator", () => {
    it("skips evaluator and uses script exit code when skip_evaluation=true", async () => {
      let evalInvoked = false;
      const transport: EvaluatorTransport = {
        invoke: async () => { evalInvoked = true; return failingEvalResult(); },
      };

      const { opts } = createTestOptionsWithBus({
        config: defaultConfig({ skip_evaluation: true }),
        evaluatorTransport: transport,
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      // Evaluator was NOT invoked even though transport is present
      expect(evalInvoked).toBe(false);
      // Sprint completed because script passed
      expect(result.completed).toBe(true);
    });

    it("does not emit evaluator events when skip_evaluation=true", async () => {
      const { opts, events } = createTestOptionsWithBus({
        config: defaultConfig({ skip_evaluation: true }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => passingVerification(),
      });

      const handle = createSprintLoop(opts);
      await handle.run();

      const evalEvents = events.filter(
        (e) => e.type === "evaluator:invoked" || e.type === "evaluator:completed",
      );
      expect(evalEvents).toHaveLength(0);
    });

    it("retries using script exit code when skip_evaluation=true and script fails", async () => {
      let verifyCallCount = 0;
      const { opts } = createTestOptionsWithBus({
        config: defaultConfig({
          skip_evaluation: true,
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 },
        }),
        evaluatorTransport: mockEvaluator([passingEvalResult()]), // would pass, but never called
        _runVerification: async () => {
          verifyCallCount++;
          if (verifyCallCount < 3) return failingVerification();
          return passingVerification();
        },
      });

      const handle = createSprintLoop(opts);
      const result = await handle.run();

      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(3);
    });

    it("skip_evaluation=true behaves same as no evaluator transport", async () => {
      // Run with skip_evaluation=true
      const { opts: opts1 } = createTestOptionsWithBus({
        config: defaultConfig({ skip_evaluation: true }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => passingVerification(),
      });

      const result1 = await createSprintLoop(opts1).run();

      // Run with no evaluator transport
      const { opts: opts2 } = createTestOptionsWithBus({
        evaluatorTransport: undefined,
        _runVerification: async () => passingVerification(),
      });

      const result2 = await createSprintLoop(opts2).run();

      // Both should complete successfully
      expect(result1.completed).toBe(true);
      expect(result2.completed).toBe(true);
      expect(result1.iterationsUsed).toBe(result2.iterationsUsed);
    });
  });
});
