/**
 * Sprint Loop — Signal handling, error handling, and edge cases.
 *
 * Tests for:
 * - VAL-LOOP-005: needs_plan signal with worker_can_escalate=true
 * - VAL-LOOP-006: needs_plan signal ignored when disabled
 * - VAL-LOOP-007: Same-test-stuck detection
 * - VAL-LOOP-008: Shutdown request stops loop cleanly
 * - VAL-LOOP-009: Worker crash treated as failed iteration
 * - VAL-LOOP-010: Verification script failure is not a loop error
 * - VAL-LOOP-011: Missing worker artifacts handled gracefully
 * - VAL-LOOP-012: Escalation result includes full iteration history
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
import { WorkerError } from "../src/controller/phase-executor";
import {
  createSprintLoop,
  type SprintLoopOptions,
} from "../src/sprint/sprint-loop";
import {
  HandoffMissingError,
  HandoffInvalidError,
} from "../src/handoff/reader";

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
      if (result.failure) throw new WorkerError(result);
      return result;
    },
    getStdinHandle: () => undefined,
  } as unknown as import("../src/controller/phase-executor").PhaseExecutor;
}

/** Mock executor that tracks prompts for inspection. */
function promptCapturingExecutor(results: WorkerResult[]) {
  let callIndex = 0;
  const prompts: string[] = [];
  const executor = {
    execute: async (opts: { prompt: string }) => {
      prompts.push(opts.prompt);
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      if (result.failure) throw new WorkerError(result);
      return result;
    },
    getStdinHandle: () => undefined,
  } as unknown as import("../src/controller/phase-executor").PhaseExecutor;
  return { executor, prompts };
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

function createTestOptions(overrides?: Partial<SprintLoopOptions>): SprintLoopOptions {
  const eventBus = new EventBus();
  const emitter = createFlywheelEmitter(eventBus);
  const adapter = new MockAdapter();
  adapter.connect(eventBus);

  return {
    taskDescription: "Add a hello world endpoint",
    config: defaultConfig(),
    executor: mockExecutor([makeWorkerResult("/tmp/handoff.json")]),
    emitter,
    ui: adapter,
    workflowId: "test-sprint-signals",
    _readHandoff: async () => makeHandoff(),
    _runVerification: async () => passingVerification(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VAL-LOOP-005: Worker "needs_plan" signal with worker_can_escalate enabled
// ---------------------------------------------------------------------------

describe("Sprint Loop Signals & Errors", () => {
  describe("VAL-LOOP-005: needs_plan escalation when enabled", () => {
    it("escalates immediately when worker signals needs_plan and worker_can_escalate=true", async () => {
      let evalInvoked = false;
      const transport: EvaluatorTransport = {
        invoke: async () => { evalInvoked = true; return passingEvalResult(); },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, worker_can_escalate: true },
        }),
        evaluatorTransport: transport,
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as WorkerHandoff),
      });

      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.reason).toContain("needs_plan");
      // Evaluator should NOT be invoked — escalation bypasses it
      expect(evalInvoked).toBe(false);
    });

    it("includes needs_plan notation in iteration history", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, worker_can_escalate: true },
        }),
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as WorkerHandoff),
      });

      const result = await handle.run();
      expect(result.iterationHistory).toHaveLength(1);
      expect(result.iterationHistory[0].workerSummary).toContain("needs_plan");
    });

    it("emits sprint:escalated event for needs_plan", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, worker_can_escalate: true },
        }),
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as WorkerHandoff),
      });

      await handle.run();

      const escalated = events.find((e) => e.type === "sprint:escalated");
      expect(escalated).toBeDefined();
      expect((escalated as Record<string, unknown>).reason).toContain("needs_plan");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-006: needs_plan ignored when disabled
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-006: needs_plan ignored when disabled (default)", () => {
    it("ignores needs_plan when worker_can_escalate is false (default)", async () => {
      let evalInvoked = false;
      const transport: EvaluatorTransport = {
        invoke: async () => { evalInvoked = true; return passingEvalResult(); },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, worker_can_escalate: false },
        }),
        evaluatorTransport: transport,
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as WorkerHandoff),
      });

      const result = await handle.run();

      // Should complete normally — needs_plan is ignored
      expect(result.completed).toBe(true);
      // Evaluator IS invoked (not short-circuited)
      expect(evalInvoked).toBe(true);
    });

    it("uses default config (worker_can_escalate=false) and ignores needs_plan", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: mockEvaluator([passingEvalResult()]),
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as WorkerHandoff),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.escalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-007: Same-test-stuck detection
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-007: Stuck detection", () => {
    it("escalates early when stuck detection enabled and failures identical", async () => {
      const identicalFailure = failingVerification("FAIL: same error every time");

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5, escalate_on_stuck: true },
        }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult(), failingEvalResult(), failingEvalResult(),
          failingEvalResult(), failingEvalResult(),
        ]),
        _runVerification: async () => identicalFailure,
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      // Should escalate before reaching hard cap of 5
      expect(result.iterationsUsed).toBeLessThan(5);
      expect(result.reason).toContain("Stuck");
    });

    it("does not trigger when verification outputs differ", async () => {
      let verificationCallCount = 0;
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3, escalate_on_stuck: true },
        }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult(), failingEvalResult(), failingEvalResult(),
        ]),
        _runVerification: async () => {
          verificationCallCount++;
          return failingVerification(`FAIL: different error #${verificationCallCount}`);
        },
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      // Should reach hard cap, not early stuck escalation
      expect(result.iterationsUsed).toBe(3);
      expect(result.reason).toContain("Max iterations");
    });

    it("continues to hard cap when stuck detection is disabled (default)", async () => {
      const identicalFailure = failingVerification("same error");

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3, escalate_on_stuck: false },
        }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult(), failingEvalResult(), failingEvalResult(),
        ]),
        _runVerification: async () => identicalFailure,
      });

      const result = await handle.run();
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(3);
      expect(result.reason).toContain("Max iterations");
    });

    it("requires at least 2 identical failures before triggering stuck", async () => {
      // First failure is unique, only second is identical — stuck triggers on iteration 3
      let callCount = 0;
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5, escalate_on_stuck: true },
        }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult(), failingEvalResult(), failingEvalResult(),
          failingEvalResult(), failingEvalResult(),
        ]),
        _runVerification: async () => {
          callCount++;
          if (callCount === 1) return failingVerification("unique error");
          return failingVerification("repeated error");
        },
      });

      const result = await handle.run();
      expect(result.escalated).toBe(true);
      // Iteration 1: unique error. Iteration 2: "repeated error". 
      // Iteration 3: "repeated error" again → stuck detected.
      expect(result.iterationsUsed).toBe(3);
      expect(result.reason).toContain("Stuck");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-008: Shutdown request
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-008: Shutdown request", () => {
    it("stops before first iteration when shutdown requested pre-run", async () => {
      let workerCalled = false;
      const executor = {
        execute: async () => { workerCalled = true; return makeWorkerResult("/tmp/h.json"); },
        getStdinHandle: () => undefined,
      } as unknown as import("../src/controller/phase-executor").PhaseExecutor;

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        executor,
      });

      handle.requestShutdown();
      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toBe("Shutdown requested");
      expect(result.escalated).toBe(false);
      expect(result.iterationsUsed).toBe(0);
      // Worker should not have been called
      expect(workerCalled).toBe(false);
    });

    it("stops after current iteration when shutdown requested mid-sprint", async () => {
      let callCount = 0;
      let shutdownFn: (() => void) | undefined;

      const executor = {
        execute: async () => {
          callCount++;
          // Request shutdown during first iteration
          if (callCount === 1 && shutdownFn) {
            shutdownFn();
          }
          return makeWorkerResult("/tmp/h.json");
        },
        getStdinHandle: () => undefined,
      } as unknown as import("../src/controller/phase-executor").PhaseExecutor;

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        executor,
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
      });

      shutdownFn = () => handle.requestShutdown();
      const result = await handle.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toBe("Shutdown requested");
      expect(result.escalated).toBe(false);
      // Only first iteration should have run; shutdown before iteration 2
      expect(callCount).toBe(1);
    });

    it("emits sprint:completed with shutdown reason", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
      });

      handle.requestShutdown();
      await handle.run();

      const completed = events.find((e) => e.type === "sprint:completed");
      expect(completed).toBeDefined();
      expect((completed as Record<string, unknown>).reason).toBe("Shutdown requested");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-009: Worker crash treated as failed iteration
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-009: Worker crash as failed iteration", () => {
    it("counts worker timeout crash toward hard cap", async () => {
      const crashResult: WorkerResult = {
        output: "",
        exitCode: 1,
        truncated: false,
        durationMs: 500,
        failure: { kind: "timeout", message: "Process timed out", timeoutMs: 60000 },
        handoffPath: "/tmp/h.json",
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 2 } }),
        executor: mockExecutor([crashResult, crashResult]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(2);
      expect(result.iterationHistory[0].workerCrashed).toBe(true);
      expect(result.iterationHistory[1].workerCrashed).toBe(true);
    });

    it("recovers after crash if next iteration succeeds", async () => {
      const crashResult: WorkerResult = {
        output: "",
        exitCode: 1,
        truncated: false,
        durationMs: 500,
        failure: { kind: "rate_limited", message: "Rate limited" },
        handoffPath: "/tmp/h.json",
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        executor: mockExecutor([crashResult, makeWorkerResult("/tmp/ok.json")]),
        _runVerification: async () => passingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(2);
      expect(result.iterationHistory[0].workerCrashed).toBe(true);
      expect(result.iterationHistory[1].workerCrashed).toBeUndefined();
    });

    it("records crash reason in iteration history", async () => {
      const crashResult: WorkerResult = {
        output: "",
        exitCode: 1,
        truncated: false,
        durationMs: 500,
        failure: { kind: "timeout", message: "Timed out after 120s" },
        handoffPath: "/tmp/h.json",
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        executor: mockExecutor([crashResult]),
      });

      const result = await handle.run();
      expect(result.iterationHistory[0].workerCrashed).toBe(true);
      expect(result.iterationHistory[0].workerSummary).toContain("crashed");
      expect(result.iterationHistory[0].workerSummary).toContain("Timed out");
    });

    it("does not invoke evaluator or verification runner on worker crash", async () => {
      let evalInvoked = false;
      let verificationInvoked = false;
      const crashResult: WorkerResult = {
        output: "",
        exitCode: 1,
        truncated: false,
        durationMs: 500,
        failure: { kind: "timeout", message: "Timed out" },
        handoffPath: "/tmp/h.json",
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        executor: mockExecutor([crashResult]),
        evaluatorTransport: {
          invoke: async () => { evalInvoked = true; return passingEvalResult(); },
        },
        _runVerification: async () => { verificationInvoked = true; return passingVerification(); },
      });

      await handle.run();
      expect(evalInvoked).toBe(false);
      expect(verificationInvoked).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-010: Verification script failure is not a loop error
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-010: Verification failure passed to evaluator", () => {
    it("passes non-zero exit code to evaluator without crashing the loop", async () => {
      let evalReceived: EvaluatorInput | undefined;
      const transport: EvaluatorTransport = {
        invoke: async (input) => {
          evalReceived = input;
          return passingEvalResult();
        },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: transport,
        _runVerification: async () => ({
          passed: false,
          stdout: "FAILED: endpoint returned 500\n",
          stderr: "Error in test\n",
          exitCode: 2,
          durationMs: 300,
        }),
      });

      const result = await handle.run();
      // Evaluator was called (not short-circuited by script failure)
      expect(evalReceived).toBeDefined();
      // The validation criteria contain the failing output
      expect(evalReceived!.validation_criteria).toContain("500");
      // Loop did not crash — evaluator passed so iteration succeeds
      expect(result.completed).toBe(true);
    });

    it("records verification result in iteration history", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => ({
          passed: false,
          stdout: "FAIL: 2 errors\n",
          stderr: "",
          exitCode: 1,
          durationMs: 200,
        }),
      });

      const result = await handle.run();
      expect(result.iterationHistory[0].verificationResult).toBeDefined();
      expect(result.iterationHistory[0].verificationResult!.passed).toBe(false);
      expect(result.iterationHistory[0].verificationResult!.exitCode).toBe(1);
      expect(result.iterationHistory[0].verificationResult!.stdout).toContain("2 errors");
    });

    it("allows evaluator to pass even when verification script fails", async () => {
      // Evaluator can decide implementation is correct despite failing tests
      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: mockEvaluator([passingEvalResult()]),
        _runVerification: async () => failingVerification("Tests fail but expected"),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-011: Missing worker artifacts handled gracefully
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-011: Missing worker artifacts", () => {
    it("counts missing handoff file as failed iteration with specific feedback", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        _readHandoff: async () => { throw new HandoffMissingError("/tmp/missing.json"); },
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory[0].missingArtifact).toContain("no handoff");
      expect(result.iterationHistory[0].workerSummary).toContain("handoff");
    });

    it("counts invalid handoff as failed iteration with specific feedback", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        _readHandoff: async () => { throw new HandoffInvalidError("/tmp/bad.json", "missing summary field"); },
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory[0].missingArtifact).toContain("handoff JSON invalid");
    });

    it("counts missing verification_script_path as failed iteration", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        _readHandoff: async () => makeHandoff({ verification_script_path: undefined }),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory[0].missingArtifact).toContain("verification_script_path");
    });

    it("does not invoke evaluator when handoff is missing", async () => {
      let evalInvoked = false;
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: {
          invoke: async () => { evalInvoked = true; return passingEvalResult(); },
        },
        _readHandoff: async () => { throw new HandoffMissingError("/tmp/missing.json"); },
      });

      await handle.run();
      expect(evalInvoked).toBe(false);
    });

    it("does not invoke verification runner when handoff is missing", async () => {
      let verificationInvoked = false;
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        _readHandoff: async () => { throw new HandoffMissingError("/tmp/missing.json"); },
        _runVerification: async () => { verificationInvoked = true; return passingVerification(); },
      });

      await handle.run();
      expect(verificationInvoked).toBe(false);
    });

    it("retries after missing artifact if more iterations remain", async () => {
      let readCallCount = 0;
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 2 } }),
        _readHandoff: async () => {
          readCallCount++;
          if (readCallCount === 1) throw new HandoffMissingError("/tmp/missing.json");
          return makeHandoff();
        },
        _runVerification: async () => passingVerification(),
      });

      const result = await handle.run();
      // First iteration: missing handoff. Second: success
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(2);
      expect(result.iterationHistory[0].missingArtifact).toBeDefined();
      expect(result.iterationHistory[1].missingArtifact).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-012: Escalation result includes full iteration history
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-012: Escalation with full iteration history", () => {
    it("includes all iteration records with verification results and feedback", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult("Missing error handling in endpoint"),
          failingEvalResult("Tests not covering edge cases"),
          failingEvalResult("Still incomplete"),
        ]),
        _runVerification: async () => failingVerification("FAIL: endpoint test failed"),
      });

      const result = await handle.run();
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory).toHaveLength(3);

      // Each record has iteration number
      expect(result.iterationHistory[0].iteration).toBe(1);
      expect(result.iterationHistory[1].iteration).toBe(2);
      expect(result.iterationHistory[2].iteration).toBe(3);

      // Each record has verification result
      for (const record of result.iterationHistory) {
        expect(record.verificationResult).toBeDefined();
        expect(record.verificationResult!.passed).toBe(false);
        expect(record.verificationResult!.stdout).toContain("FAIL");
      }

      // Each record has evaluator feedback
      for (const record of result.iterationHistory) {
        expect(record.evaluatorPassed).toBe(false);
      }
    });

    it("includes worker summary in each iteration record", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 2 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      for (const record of result.iterationHistory) {
        expect(record.workerSummary).toBeTruthy();
        expect(record.workerSummary.length).toBeGreaterThan(0);
      }
    });

    it("includes mixed iteration types (crash + normal) in history", async () => {
      const crashResult: WorkerResult = {
        output: "",
        exitCode: 1,
        truncated: false,
        durationMs: 500,
        failure: { kind: "timeout", message: "Timed out" },
        handoffPath: "/tmp/h.json",
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        executor: mockExecutor([crashResult, makeWorkerResult("/tmp/ok.json"), makeWorkerResult("/tmp/ok2.json")]),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      expect(result.iterationHistory).toHaveLength(3);
      // First: crash
      expect(result.iterationHistory[0].workerCrashed).toBe(true);
      // Second and third: normal failures
      expect(result.iterationHistory[1].workerCrashed).toBeUndefined();
      expect(result.iterationHistory[1].verificationResult).toBeDefined();
      expect(result.iterationHistory[2].workerCrashed).toBeUndefined();
      expect(result.iterationHistory[2].verificationResult).toBeDefined();
    });

    it("includes script content in iteration history for evaluator script comparison", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      // Script content is recorded (best-effort — depends on file existing)
      // At minimum, the field should be present
      expect(result.iterationHistory[0]).toHaveProperty("scriptContent");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-016 (additional): Budget exhaustion mid-sprint
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-016: Budget exhaustion (additional edge cases)", () => {
    it("stops mid-sprint when budget exhausts between iterations", async () => {
      const tracker = mockBudgetTracker(2); // Exhausted after 2 invocations
      const limits: BudgetLimits = {
        max_invocations: 2,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        budgetTracker: tracker,
        budgetLimits: limits,
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
      expect(result.escalated).toBe(false);
      // Budget was exhausted after 2 invocations
      expect(result.iterationsUsed).toBeLessThanOrEqual(2);
    });

    it("does not emit escalation on budget exhaustion", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const tracker = mockBudgetTracker(0); // Immediately exhausted
      const limits: BudgetLimits = {
        max_invocations: 0,
        max_tokens: null,
        max_wall_clock_minutes: 0,
        wall_clock_deadline: null,
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      await handle.run();

      const escalatedEvents = events.filter((e) => e.type === "sprint:escalated");
      expect(escalatedEvents).toHaveLength(0);

      const completed = events.find((e) => e.type === "sprint:completed") as Record<string, unknown> | undefined;
      expect(completed).toBeDefined();
      expect(completed!.reason).toBe("budget_exhausted");
    });
  });
});
