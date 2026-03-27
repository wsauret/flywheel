import { describe, it, expect, beforeEach } from "bun:test";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { FlywheelEvent } from "../src/events/types";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passingResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All validation criteria met",
    suggestions: [],
    confidence: 0.9,
    feedback: "Good work",
    files_to_review: [],
    ...overrides,
  };
}

function failingResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: false,
    reasoning: "Validation criteria not met",
    suggestions: ["Fix the output"],
    confidence: 0.3,
    feedback: "Needs improvement",
    files_to_review: [],
    ...overrides,
  };
}

function createMockTransport(
  responses: Array<EvaluatorResult | Error | "timeout">,
): { transport: EvaluatorTransport; callCount: () => number; inputs: () => EvaluatorInput[] } {
  let calls = 0;
  const capturedInputs: EvaluatorInput[] = [];

  const transport: EvaluatorTransport = {
    async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
      capturedInputs.push(input);
      const response = responses[calls++];
      if (response === "timeout") {
        // Simulate a timeout by throwing a timeout error
        const err = new Error("Evaluation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };

  return {
    transport,
    callCount: () => calls,
    inputs: () => capturedInputs,
  };
}

// ---------------------------------------------------------------------------
// a) Configurable max re-prompt cycles (default 3)
// ---------------------------------------------------------------------------

describe("Evaluator — re-prompt cycles", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("passes on first try — no re-prompt", async () => {
    const { transport, callCount } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "worker output",
      evaluationCriteria: { acceptance_criteria: ["must be valid"], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: ["src/index.ts"],
    });

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(callCount()).toBe(1);
  });

  it("valid passed:false returns immediately — no retry with identical input", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      passingResult(), // should never be reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "worker output",
      evaluationCriteria: { acceptance_criteria: ["must be valid"], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: ["src/index.ts"],
    });

    // Valid passed:false returns immediately (no retry — identical input yields same verdict)
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(callCount()).toBe(1);
  });

  it("valid passed:false on first cycle returns immediately with cyclesUsed:1", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult({ reasoning: "Missing tests" }),
      failingResult({ reasoning: "Still missing tests" }),  // never reached
      failingResult({ reasoning: "Third failure" }),         // never reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "worker output",
      evaluationCriteria: { acceptance_criteria: ["must have tests"], required_tests: true, custom_checks: [], required_outputs: [] },
      contextFiles: ["src/index.ts"],
    });

    // Valid passed:false returns immediately — no retry
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("Missing tests");
    expect(callCount()).toBe(1);
  });

  it("valid passed:false stops after 1 call even with maxCycles:3", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      failingResult(),     // never reached
      failingResult(),     // never reached
      passingResult(),     // never reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    // Valid passed:false returns immediately — only 1 call
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(callCount()).toBe(1);
  });

  it("maxCycles: 3 — error retries up to 3 cycles, then passes", async () => {
    const parseError = new Error("JSON parse error");

    const { transport, callCount } = createMockTransport([
      parseError,         // error retry 1
      parseError,         // error retry 2
      passingResult(),    // success on 3rd attempt
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(3);
    expect(callCount()).toBe(3);
  });

  it("maxCycles: 1 — evaluator runs exactly 1 cycle", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult({ reasoning: "Single cycle failure" }),
      passingResult(), // should never be reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 1,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(result.reason).toBe("Single cycle failure");
    expect(callCount()).toBe(1);
  });

  it("without maxCycles — valid passed:false returns immediately (1 call)", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      failingResult(),     // never reached
      failingResult(),     // never reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      // no maxCycles — uses default, but passed:false returns immediately
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(callCount()).toBe(1);
  });

  it("cyclesUsed reflects actual cycles in error-then-pass case", async () => {
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport, callCount } = createMockTransport([
      schemaError,       // cycle 1: error → retry
      schemaError,       // cycle 2: error → retry
      passingResult(),   // cycle 3: pass
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(3);
    expect(callCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// b) Timeouts do NOT count against cycle cap
// ---------------------------------------------------------------------------

describe("Evaluator — timeout handling", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("timeout — treated as skip, proceed as if passed", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "worker output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("timed out");
  });

  it("timeout does NOT increment the failure counter", async () => {
    // Timeout on first try, then fail, then pass on third
    // If timeout counted as failure, the fail would be cycle 2 and third wouldn't run
    const { transport, callCount } = createMockTransport([
      "timeout", // doesn't count against cap
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    // Timeout should short-circuit and proceed
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(callCount()).toBe(1);
  });

  it("emits evaluator:failed on timeout", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0] as any).reason).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// c) Evaluator skippable via config flag
// ---------------------------------------------------------------------------

describe("Evaluator — skip_evaluation config", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("skip_evaluation: true — evaluator not invoked, proceed immediately", async () => {
    const { transport, callCount } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      skipEvaluation: true,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(0);
    expect(result.skipped).toBe(true);
    expect(callCount()).toBe(0); // transport never called
  });

  it("skip_evaluation: false (default) — evaluator invoked normally", async () => {
    const { transport, callCount } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      skipEvaluation: false,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(callCount()).toBe(1);
  });

  it("skipEvaluation defaults to false when not provided", async () => {
    const { transport, callCount } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      // no skipEvaluation
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(callCount()).toBe(1); // evaluator was invoked
  });
});

// ---------------------------------------------------------------------------
// d) Uses EvaluatorTransport interface
// ---------------------------------------------------------------------------

describe("Evaluator — transport interface", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("passes correct EvaluatorInput to transport", async () => {
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "worker output text",
      evaluationCriteria: { acceptance_criteria: ["must pass all tests"], required_tests: true, custom_checks: [], required_outputs: [] },
      contextFiles: ["src/main.ts", "tests/main.test.ts"],
    });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]).toEqual({
      worker_output: "worker output text",
      evaluation_criteria: "Acceptance criteria:\n- must pass all tests\nRequired: tests must pass",
      context_files: ["src/main.ts", "tests/main.test.ts"],
      acceptance_criteria: ["must pass all tests"],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    });
  });

  it("parses EvaluatorResult from transport response", async () => {
    const { transport } = createMockTransport([
      passingResult({ reasoning: "Tests all pass", suggestions: ["Consider adding edge cases"] }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("forwards optional fields to transport input", async () => {
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
      acceptanceCriteria: ["tests pass"],
      artifactsProduced: ["src/new.ts"],
      testsPassed: true,
      durationSeconds: 30,
    });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].acceptance_criteria).toEqual(["tests pass"]);
    expect(inputs()[0].artifacts_produced).toEqual(["src/new.ts"]);
    expect(inputs()[0].tests_passed).toBe(true);
    expect(inputs()[0].duration_seconds).toBe(30);
  });

  it("merges acceptance_criteria from structured EvaluationCriteria", async () => {
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: {
        acceptance_criteria: ["from-criteria"],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
      contextFiles: [],
      acceptanceCriteria: ["from-explicit"],
    });

    expect(inputs()).toHaveLength(1);
    // Both explicit and extracted criteria merged, deduplicated
    expect(inputs()[0].acceptance_criteria).toContain("from-explicit");
    expect(inputs()[0].acceptance_criteria).toContain("from-criteria");
  });

  it("provides default values for fields when caller omits optional EvaluateOptions", async () => {
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].acceptance_criteria).toEqual([]);
    expect(inputs()[0].artifacts_produced).toEqual([]);
    expect(inputs()[0].tests_passed).toBeNull();
    expect(inputs()[0].duration_seconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// e) Failure definitions
// ---------------------------------------------------------------------------

describe("Evaluator — failure definitions", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("passed: false returns immediately — does NOT retry (1 call)", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      failingResult(),    // never reached
      failingResult(),    // never reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    // Valid passed:false returns immediately — no retry
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(callCount()).toBe(1);
  });

  it("schema parse error counts as failure (increments cap)", async () => {
    // Simulate a schema parse error by having transport throw a non-timeout error
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport, callCount } = createMockTransport([
      schemaError,
      schemaError,
      schemaError,
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(3);
    expect(callCount()).toBe(3);
  });

  it("timeout is NOT a failure — skip and proceed", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// f) Events
// ---------------------------------------------------------------------------

describe("Evaluator — event emission", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;
  let events: FlywheelEvent[];

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("emits evaluator:invoked exactly once per evaluation call", async () => {
    const { transport } = createMockTransport([failingResult(), passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(1); // emitted once before retry loop
  });

  it("emits evaluator:completed after success", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const completedEvents = events.filter((e) => e.type === "evaluator:completed");
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as any).result.passed).toBe(true);
  });

  it("emits evaluator:completed on valid passed:false (immediate return)", async () => {
    const { transport } = createMockTransport([
      failingResult({ reasoning: "first failure" }),
      failingResult({ reasoning: "second failure" }),   // never reached
      failingResult({ reasoning: "third failure" }),     // never reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    // Emits evaluator:completed with the first (and only) result
    const completedEvents = events.filter((e) => e.type === "evaluator:completed");
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as any).result.passed).toBe(false);
    expect((completedEvents[0] as any).result.reasoning).toBe("first failure");
  });

  it("emits evaluator:failed on timeout", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("emits evaluator:failed on non-timeout error", async () => {
    const { transport } = createMockTransport([
      new Error("Something broke"),
      new Error("Still broken"),
      new Error("Third error"),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(3); // one per failed attempt
  });

  it("evaluator:invoked comes before evaluator:completed", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const eventTypes = events.map((e) => e.type);
    const invokedIdx = eventTypes.indexOf("evaluator:invoked");
    const completedIdx = eventTypes.indexOf("evaluator:completed");
    expect(invokedIdx).toBeLessThan(completedIdx);
  });

  it("does not emit any events when skip_evaluation is true", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      skipEvaluation: true,
    });

    await evaluator.evaluate({
      workerOutput: "output",
      evaluationCriteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
      contextFiles: [],
    });

    const evaluatorEvents = events.filter((e) =>
      e.type.startsWith("evaluator:"),
    );
    expect(evaluatorEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// g) SubprocessEvaluatorTransport
// ---------------------------------------------------------------------------

describe("SubprocessEvaluatorTransport", () => {
  let SubprocessEvaluatorTransport: typeof import("../src/evaluator/subprocess-transport").SubprocessEvaluatorTransport;

  /** Helper: extract handoff path from prompt and write verdict file */
  async function writeVerdictToHandoff(args: string[], options: any, verdict: Record<string, unknown>): Promise<void> {
    let prompt = "";
    const pIdx = args.indexOf("-p");
    if (pIdx > -1) prompt = args[pIdx + 1];
    if (options?.stdin) prompt = options.stdin;
    const match = prompt.match(/`([^`]+\.json)`/);
    if (match) await Bun.write(match[1], JSON.stringify(verdict));
  }

  beforeEach(async () => {
    const mod = await import("../src/evaluator/subprocess-transport");
    SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;
  });

  it("spawns process and reads EvaluatorResult from handoff file", async () => {
    const verdict = passingResult({ reasoning: "Code looks good" });

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn(command, args, options) {
        await writeVerdictToHandoff(args, options, verdict);
        return { result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 1000,
          handoffPath: "/tmp/unused",
        }) };
      },
    };

    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });
    const evalResult = await transport.invoke({
      worker_output: "some output",
      evaluation_criteria: "must pass",
      context_files: [],
      acceptance_criteria: ["must pass"],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    });

    expect(evalResult.passed).toBe(true);
    expect(evalResult.reasoning).toBe("Code looks good");
  });

  it("retries once on handoff missing then succeeds", async () => {
    let callCount = 0;
    const verdict = passingResult();

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        // First call: don't write handoff; second: write
        if (callCount >= 2) {
          await writeVerdictToHandoff(args, options, verdict);
        }
        return { result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
          handoffPath: "/tmp/unused",
        }) };
      },
    };

    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });
    const result = await transport.invoke({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    });

    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("throws after two handoff failures", async () => {
    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn() {
        // Never write a handoff file
        return { result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
          handoffPath: "/tmp/unused",
        }) };
      },
    };

    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });

    await expect(
      transport.invoke({
        worker_output: "output",
        evaluation_criteria: "criteria",
        context_files: [],
        acceptance_criteria: [],
        artifacts_produced: [],
        tests_passed: null,
        duration_seconds: 0,
      }),
    ).rejects.toThrow();
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn(_command, _args, options) {
        receivedEnv = options?.env;
        // Write verdict to handoff file
        let prompt = "";
        const pIdx = _args.indexOf("-p");
        if (pIdx > -1) prompt = _args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(passingResult()));
        return { result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 100,
          handoffPath: "/tmp/unused",
        }) };
      },
    };

    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });
    await transport.invoke({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    });

    expect(receivedEnv).toBeDefined();
    if (receivedEnv) {
      const keys = Object.keys(receivedEnv);
      for (const key of keys) {
        expect(key).not.toMatch(/_API_KEY$/);
        expect(key).not.toMatch(/_SECRET_KEY$/);
        expect(key).not.toMatch(/_SECRET$/);
      }
    }
  });

  it("respects 30s timeout by default", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn(_command, _args, options) {
        receivedTimeout = options?.timeoutMs;
        let prompt = "";
        const pIdx = _args.indexOf("-p");
        if (pIdx > -1) prompt = _args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(passingResult()));
        return { result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 100,
          handoffPath: "/tmp/unused",
        }) };
      },
    };

    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });
    await transport.invoke({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    });

    expect(receivedTimeout).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// h) Config schema — skip_evaluation field
// ---------------------------------------------------------------------------

describe("Config — skip_evaluation", () => {
  let FlywheelConfigSchema: typeof import("../src/config/loader").FlywheelConfigSchema;

  beforeEach(async () => {
    const mod = await import("../src/config/loader");
    FlywheelConfigSchema = mod.FlywheelConfigSchema;
  });

  it("defaults to false when absent", () => {
    const result = FlywheelConfigSchema.parse({});
    expect(result.skip_evaluation).toBe(false);
  });

  it("accepts true", () => {
    const result = FlywheelConfigSchema.parse({ skip_evaluation: true });
    expect(result.skip_evaluation).toBe(true);
  });

  it("accepts false", () => {
    const result = FlywheelConfigSchema.parse({ skip_evaluation: false });
    expect(result.skip_evaluation).toBe(false);
  });
});
