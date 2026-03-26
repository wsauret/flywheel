/**
 * Shared test helpers for sprint loop tests.
 *
 * Extracted from sprint-loop.test.ts, sprint-loop-signals.test.ts, and
 * sprint-loop-events.test.ts to eliminate ~160 lines of duplicated code.
 */

import type { WorkerResult } from "../../src/schemas/worker";
import type { WorkerHandoff } from "../../src/schemas/handoff";
import type { FlywheelEvent } from "../../src/events/types";
import type { FlywheelConfig } from "../../src/config/loader";
import type { EvaluatorTransport } from "../../src/evaluator/transport";
import type { EvaluatorInput, EvaluatorResult } from "../../src/schemas/evaluator";
import type { BudgetTracker } from "../../src/session/budget-tracker";
import type { BudgetLimits } from "../../src/schemas/shared";
import type { VerificationResult } from "../../src/sprint/verification-runner";
import type { SprintLoopOptions } from "../../src/sprint/sprint-loop";
import type { PhaseExecutor } from "../../src/controller/phase-executor";
import { EventBus, createFlywheelEmitter } from "../../src/events/event-bus";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../../src/config/loader";
import { WorkerError } from "../../src/controller/phase-executor";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides } as FlywheelConfig;
}

// ---------------------------------------------------------------------------
// Worker results & handoff
// ---------------------------------------------------------------------------

export function makeWorkerResult(handoffPath: string, output = "done"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath,
  };
}

export function makeHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
  return {
    summary: "Implemented the feature and wrote verification script.",
    verification_script_path: ".flywheel/verify/sprint-test.ts",
    artifacts: { files_created: ["src/hello.ts"], files_modified: [] },
    verification: { tests_passed: true, test_output_summary: "All tests pass" },
    ...overrides,
  } as WorkerHandoff;
}

// ---------------------------------------------------------------------------
// Verification results
// ---------------------------------------------------------------------------

export function passingVerification(): VerificationResult {
  return {
    passed: true,
    stdout: "All checks passed\n",
    stderr: "",
    exitCode: 0,
    durationMs: 500,
  };
}

export function failingVerification(stdout = "FAIL: expected 200 got 404\n"): VerificationResult {
  return {
    passed: false,
    stdout,
    stderr: "",
    exitCode: 1,
    durationMs: 500,
  };
}

// ---------------------------------------------------------------------------
// Evaluator results
// ---------------------------------------------------------------------------

export function passingEvalResult(): EvaluatorResult {
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

export function failingEvalResult(feedback = "Implementation incomplete"): EvaluatorResult {
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

// ---------------------------------------------------------------------------
// Mock executor
// ---------------------------------------------------------------------------

export function mockExecutor(results: WorkerResult[]): PhaseExecutor {
  let callIndex = 0;
  return {
    execute: async (_opts: unknown) => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      if (result.failure) throw new WorkerError(result);
      return result;
    },
    getStdinHandle: () => undefined,
  } as unknown as PhaseExecutor;
}

/** Mock executor that tracks prompts for inspection. */
export function promptCapturingExecutor(results: WorkerResult[]) {
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
  } as unknown as PhaseExecutor;
  return { executor, prompts };
}

// ---------------------------------------------------------------------------
// Mock evaluator
// ---------------------------------------------------------------------------

export function mockEvaluator(results: EvaluatorResult[]): EvaluatorTransport {
  let callIndex = 0;
  return {
    invoke: async (_input: EvaluatorInput): Promise<EvaluatorResult> => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result;
    },
  };
}

export function throwingEvaluator(error: Error): EvaluatorTransport {
  return {
    invoke: async () => { throw error; },
  };
}

// ---------------------------------------------------------------------------
// Mock budget tracker
// ---------------------------------------------------------------------------

export function mockBudgetTracker(exhaustedAfter: number): BudgetTracker {
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

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

export function collectEvents(eventBus: EventBus): FlywheelEvent[] {
  const events: FlywheelEvent[] = [];
  eventBus.subscribe((e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Test options factory
// ---------------------------------------------------------------------------

export function createTestOptions(overrides?: Partial<SprintLoopOptions>): SprintLoopOptions {
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

/**
 * Create test options with a fresh EventBus and emitter, returning both for inspection.
 * Used in event-focused tests that need access to the raw event bus and events array.
 */
export function createTestOptionsWithBus(overrides?: Partial<SprintLoopOptions>) {
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
