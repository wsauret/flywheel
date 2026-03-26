import { describe, it, expect, beforeEach } from "bun:test";
import type { WorkerResult } from "../src/schemas/worker";
import type { WorkerHandoff } from "../src/schemas/handoff";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { BudgetTracker } from "../src/session/budget-tracker";
import type { BudgetLimits, SessionBudgetStatus } from "../src/schemas/shared";
import type { VerificationResult } from "../src/sprint/verification-runner";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor, WorkerError } from "../src/controller/phase-executor";
import {
  createSprintLoop,
  type SprintLoopOptions,
  type HandoffReader,
  type VerificationScriptRunner,
} from "../src/sprint/sprint-loop";
import { createStageLoop } from "../src/controller/stage-loop-factory";
import { HandoffMissingError } from "../src/handoff/reader";

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

/** Mock executor that returns pre-configured results. */
function mockExecutor(results: WorkerResult[]): PhaseExecutor {
  let callIndex = 0;
  return {
    execute: async (opts: any) => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      if (result.failure) throw new WorkerError(result);
      return result;
    },
    getStdinHandle: () => undefined,
  } as unknown as PhaseExecutor;
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
    isExhausted: (limits: BudgetLimits) => invocations >= exhaustedAfter,
    getBudgetStatus: () => ({ invocations_remaining: null, token_budget_remaining: null, wall_clock_deadline: null }),
    flush: () => {},
    dispose: () => {},
  };
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
    workflowId: "test-sprint-1",
    _readHandoff: async () => makeHandoff(),
    _runVerification: async () => passingVerification(),
    ...overrides,
  };
}

function collectEvents(eventBus: EventBus): FlywheelEvent[] {
  const events: FlywheelEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// VAL-LOOP-001: Single-iteration success lifecycle
// ---------------------------------------------------------------------------

describe("Sprint Loop", () => {
  describe("VAL-LOOP-001: Single-iteration success", () => {
    it("completes on first try when evaluator passes", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
        evaluatorTransport: mockEvaluator([passingEvalResult()]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
      expect(result.escalated).toBe(false);
      expect(result.iterationHistory).toHaveLength(1);
    });

    it("completes on first try without evaluator (script exit code)", async () => {
      const handle = createSprintLoop(createTestOptions());
      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-002: Verification runs between worker and evaluator
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-002: Verification runs between worker and evaluator", () => {
    it("passes verification result to evaluator", async () => {
      let evalInput: EvaluatorInput | undefined;
      const transport: EvaluatorTransport = {
        invoke: async (input) => {
          evalInput = input;
          return passingEvalResult();
        },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: transport,
        _runVerification: async () => failingVerification("endpoint returned 404"),
      });

      await handle.run();
      // Evaluator was called and received verification context in criteria
      expect(evalInput).toBeDefined();
      expect(evalInput!.validation_criteria).toContain("404");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-003: Evaluator fail triggers retry with cumulative context
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-003: Cumulative context on retry", () => {
    it("retries with accumulated context when evaluator fails", async () => {
      let executorCallCount = 0;
      const executor = {
        execute: async (opts: any) => {
          executorCallCount++;
          // On iteration 3, check prompt contains previous attempt data
          if (executorCallCount === 3) {
            expect(opts.prompt).toContain("Previous Attempts");
            expect(opts.prompt).toContain("Attempt 1");
            expect(opts.prompt).toContain("Attempt 2");
          }
          return makeWorkerResult("/tmp/h.json");
        },
        getStdinHandle: () => undefined,
      } as unknown as PhaseExecutor;

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        executor,
        evaluatorTransport: mockEvaluator([
          failingEvalResult("Missing error handling"),
          failingEvalResult("Still missing edge cases"),
          passingEvalResult(),
        ]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(3);
      expect(executorCallCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-004: Hard cap enforced with escalation
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-004: Hard cap enforcement", () => {
    it("escalates when max_iterations reached", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult(),
          failingEvalResult(),
          failingEvalResult(),
        ]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(3);
      expect(result.iterationHistory).toHaveLength(3);
    });

    it("works with cap=1 (immediate escalation after one attempt)", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-005: Worker needs_plan with worker_can_escalate=true
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-005: needs_plan escalation when enabled", () => {
    it("escalates immediately when worker signals needs_plan", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, worker_can_escalate: true },
        }),
        _readHandoff: async () => ({
          ...makeHandoff(),
          needs_plan: true,
        } as any),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.reason).toContain("needs_plan");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-006: needs_plan ignored when disabled
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-006: needs_plan ignored when disabled", () => {
    it("ignores needs_plan when worker_can_escalate is false", async () => {
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
        } as any),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(evalInvoked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-007: Stuck detection
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-007: Stuck detection", () => {
    it("escalates early when stuck detection enabled and failures identical", async () => {
      const sameFailure = failingVerification("FAIL: same error every time");

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5, escalate_on_stuck: true },
        }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult(), failingEvalResult()]),
        _runVerification: async () => sameFailure,
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      // Should escalate before reaching cap of 5
      expect(result.iterationsUsed).toBeLessThan(5);
      expect(result.reason).toContain("Stuck");
    });

    it("continues to hard cap when stuck detection is disabled (default)", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({
          sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3, escalate_on_stuck: false },
        }),
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult(), failingEvalResult()]),
        _runVerification: async () => failingVerification("same error"),
      });

      const result = await handle.run();
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-008: Shutdown request
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-008: Shutdown request", () => {
    it("stops cleanly on shutdown request", async () => {
      let callCount = 0;
      const slowExecutor = {
        execute: async () => {
          callCount++;
          return makeWorkerResult("/tmp/h.json");
        },
        getStdinHandle: () => undefined,
      } as unknown as PhaseExecutor;

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 5 } }),
        executor: slowExecutor,
        evaluatorTransport: mockEvaluator([failingEvalResult(), failingEvalResult()]),
      });

      // Request shutdown before running (simulates immediate shutdown)
      handle.requestShutdown();
      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.reason).toBe("Shutdown requested");
      expect(result.escalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-009: Worker crash treated as failed iteration
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-009: Worker crash as failed iteration", () => {
    it("counts worker crash toward hard cap", async () => {
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
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-010: Verification script failure is not a loop error
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-010: Verification failure passed to evaluator", () => {
    it("passes non-zero exit code to evaluator without crashing", async () => {
      let evalCalled = false;
      const transport: EvaluatorTransport = {
        invoke: async (input) => {
          evalCalled = true;
          // The evaluator receives the failing verification
          expect(input.validation_criteria).toContain("FAILED");
          return passingEvalResult();
        },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: transport,
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      expect(evalCalled).toBe(true);
      // Loop did not crash
      expect(result.completed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-011: Missing worker artifacts
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-011: Missing worker artifacts", () => {
    it("counts missing handoff as failed iteration with feedback", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        _readHandoff: async () => { throw new HandoffMissingError("/tmp/missing.json"); },
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory[0].missingArtifact).toContain("no handoff");
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
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-012: Escalation includes full iteration history
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-012: Escalation with full history", () => {
    it("includes all iteration records in escalation result", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 3 } }),
        evaluatorTransport: mockEvaluator([
          failingEvalResult("Issue A"),
          failingEvalResult("Issue B"),
          failingEvalResult("Issue C"),
        ]),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      expect(result.escalated).toBe(true);
      expect(result.iterationHistory).toHaveLength(3);
      expect(result.iterationHistory[0].iteration).toBe(1);
      expect(result.iterationHistory[1].iteration).toBe(2);
      expect(result.iterationHistory[2].iteration).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-013: Evaluator transport failure degrades to script exit code
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-013: Evaluator transport failure degradation", () => {
    it("falls back to script exit code when evaluator crashes (script passes)", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: throwingEvaluator(new Error("Transport failed")),
        _runVerification: async () => passingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(result.iterationsUsed).toBe(1);
    });

    it("falls back to script exit code when evaluator crashes (script fails)", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: throwingEvaluator(new Error("Transport failed")),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-014: Sprint events emitted
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-014: Sprint events", () => {
    it("emits correct event sequence for successful sprint", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
      });

      await handle.run();

      const sprintEvents = events.filter((e) => e.type.startsWith("sprint:"));
      const types = sprintEvents.map((e) => e.type);

      expect(types).toContain("sprint:started");
      expect(types).toContain("sprint:iteration-started");
      expect(types).toContain("sprint:verification-started");
      expect(types).toContain("sprint:iteration-completed");
      expect(types).toContain("sprint:completed");

      // Verify sprint:started payload
      const started = sprintEvents.find((e) => e.type === "sprint:started") as any;
      expect(started.maxIterations).toBe(5);
      expect(started.taskDescription).toContain("hello world");

      // Verify sprint:completed payload
      const completed = sprintEvents.find((e) => e.type === "sprint:completed") as any;
      expect(completed.completed).toBe(true);
      expect(completed.iterationsUsed).toBe(1);
      expect(completed.escalated).toBe(false);
    });

    it("emits escalated event on hard cap", async () => {
      const eventBus = new EventBus();
      const events = collectEvents(eventBus);
      const emitter = createFlywheelEmitter(eventBus);

      const handle = createSprintLoop({
        ...createTestOptions(),
        emitter,
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 1 } }),
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
        _runVerification: async () => failingVerification(),
      });

      await handle.run();

      const types = events.filter((e) => e.type.startsWith("sprint:")).map((e) => e.type);
      expect(types).toContain("sprint:escalated");
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-015: Graceful degradation without evaluator
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-015: No evaluator configured", () => {
    it("uses script exit code 0 as pass", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: undefined,
        _runVerification: async () => passingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
    });

    it("uses script exit code 1 as fail and retries to cap", async () => {
      const handle = createSprintLoop({
        ...createTestOptions(),
        evaluatorTransport: undefined,
        config: defaultConfig({ sprint: { ...CONFIG_DEFAULTS.sprint, max_iterations: 2 } }),
        _runVerification: async () => failingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.iterationsUsed).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-016: Budget exhaustion
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-016: Budget exhaustion", () => {
    it("stops with budget_exhausted after budget limit reached", async () => {
      const tracker = mockBudgetTracker(2);
      const limits: BudgetLimits = { max_invocations: 2, max_tokens: null, max_wall_clock_minutes: 0, wall_clock_deadline: null };

      // Pre-exhaust the budget
      tracker.incrementInvocations();
      tracker.incrementInvocations();

      const handle = createSprintLoop({
        ...createTestOptions(),
        budgetTracker: tracker,
        budgetLimits: limits,
        evaluatorTransport: mockEvaluator([failingEvalResult()]),
      });

      const result = await handle.run();
      expect(result.completed).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
      expect(result.escalated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-LOOP-017: skip_evaluation uses script exit code
  // ---------------------------------------------------------------------------

  describe("VAL-LOOP-017: skip_evaluation config", () => {
    it("skips evaluator and uses script exit code when skip_evaluation=true", async () => {
      let evalInvoked = false;
      const transport: EvaluatorTransport = {
        invoke: async () => { evalInvoked = true; return failingEvalResult(); },
      };

      const handle = createSprintLoop({
        ...createTestOptions(),
        config: defaultConfig({ skip_evaluation: true }),
        evaluatorTransport: transport,
        _runVerification: async () => passingVerification(),
      });

      const result = await handle.run();
      expect(result.completed).toBe(true);
      expect(evalInvoked).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // VAL-SCHEMA-007: stage-loop-factory handles "sprint" workflow type
  // ---------------------------------------------------------------------------

  describe("VAL-SCHEMA-007: stage-loop-factory sprint support", () => {
    it("createStageLoop returns valid handle for sprint workflow", () => {
      const eventBus = new EventBus();
      const adapter = new MockAdapter();
      adapter.connect(eventBus);

      // This should not throw — validates factory routing
      const handle = createStageLoop({
        workflow: "sprint",
        args: { description: "test task" },
        config: defaultConfig(),
        spawner: { spawn: async () => ({ result: Promise.resolve(makeWorkerResult("/tmp/h.json")) }) } as any,
        engine: {
          buildCommand: () => ({ command: "echo", args: ["test"], stdinPrompt: false }),
          metadata: { name: "test", cliBinary: "test", defaultModel: "test", order: 1, supportsStreamingInput: false, supportsToolScoping: false, installCommand: "test" },
        } as any,
        ui: adapter,
        eventBus,
      });

      expect(handle).toBeDefined();
      expect(typeof handle.loop.run).toBe("function");
      expect(typeof handle.shutdown).toBe("function");
      expect(typeof handle.getAccumulatedExtra).toBe("function");
    });

    it("throws when sprint has no description", () => {
      const eventBus = new EventBus();
      const adapter = new MockAdapter();
      adapter.connect(eventBus);

      expect(() =>
        createStageLoop({
          workflow: "sprint",
          args: {},
          config: defaultConfig(),
          spawner: { spawn: async () => ({ result: Promise.resolve(makeWorkerResult("/tmp/h.json")) }) } as any,
          engine: {
            buildCommand: () => ({ command: "echo", args: ["test"], stdinPrompt: false }),
            metadata: { name: "test", cliBinary: "test", defaultModel: "test", order: 1, supportsStreamingInput: false, supportsToolScoping: false, installCommand: "test" },
          } as any,
          ui: adapter,
          eventBus,
        })
      ).toThrow("Sprint workflow requires a description argument");
    });
  });
});
