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

const defaultCriteria = {
  acceptance_criteria: [],
  required_tests: false,
  custom_checks: [],
  required_outputs: [],
};

// ---------------------------------------------------------------------------
// VAL-RETRY-001: Valid passed:false returns immediately without retry
// ---------------------------------------------------------------------------

describe("VAL-RETRY-001: Valid passed:false returns immediately without retry", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("transport called exactly once when evaluator returns passed:false", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult({ reasoning: "Missing tests" }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it("returns immediately with reasoning from the failing result", async () => {
    const { transport } = createMockTransport([
      failingResult({ reasoning: "Output is incomplete" }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Output is incomplete");
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-002: Transport parse/schema errors retry up to maxCycles
// ---------------------------------------------------------------------------

describe("VAL-RETRY-002: Transport parse/schema errors retry up to maxCycles", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("retries up to maxCycles on schema errors", async () => {
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
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(3);
    expect(result.passed).toBe(false);
  });

  it("succeeds if error retry eventually returns passing result", async () => {
    const parseError = new Error("JSON parse error");

    const { transport, callCount } = createMockTransport([
      parseError,
      parseError,
      passingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(3);
    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(3);
  });

  it("returns passed:false with error message when all retries are errors", async () => {
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport } = createMockTransport([
      schemaError,
      schemaError,
      schemaError,
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Schema validation failed");
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-003: evaluator:invoked emitted exactly once per evaluation
// ---------------------------------------------------------------------------

describe("VAL-RETRY-003: evaluator:invoked emitted exactly once per evaluation", () => {
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

  it("emits evaluator:invoked once even with error retries", async () => {
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport } = createMockTransport([
      schemaError,
      schemaError,
      passingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(1);
  });

  it("emits evaluator:invoked once when passed:false (no retry)", async () => {
    const { transport } = createMockTransport([
      failingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(1);
  });

  it("emits evaluator:invoked once when passed:true", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(1);
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
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const eventTypes = events.map((e) => e.type);
    const invokedIdx = eventTypes.indexOf("evaluator:invoked");
    const completedIdx = eventTypes.indexOf("evaluator:completed");
    expect(invokedIdx).toBeLessThan(completedIdx);
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-005: passed:true returns immediately (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("VAL-RETRY-005: passed:true returns immediately", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("returns immediately with passed:true and cyclesUsed:1", async () => {
    const { transport, callCount } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-006: Timeout returns as skipped (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("VAL-RETRY-006: Timeout returns as skipped", () => {
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

  it("timeout returns passed:true, skipped:true with 'timed out' reason", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("timed out");
  });

  it("timeout emits evaluator:failed event", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0] as any).reason).toContain("timeout");
  });

  it("timeout does not retry", async () => {
    const { transport, callCount } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-007: maxCycles controls error retries only
// ---------------------------------------------------------------------------

describe("VAL-RETRY-007: maxCycles controls error retries only", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("schema error on attempt 1 retries, then valid passed:false on attempt 2 returns immediately", async () => {
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport, callCount } = createMockTransport([
      schemaError,
      failingResult({ reasoning: "Output incomplete" }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 2,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
    expect(result.reason).toBe("Output incomplete");
  });

  it("valid passed:false does not consume retry cycles (maxCycles:1)", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult({ reasoning: "Bad output" }),
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
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    // Only one call made — passed:false returned immediately, no retry
    expect(callCount()).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(1);
  });

  it("error retries up to maxCycles:2, then returns on valid passed:false", async () => {
    const parseError = new Error("JSON parse error");

    const { transport, callCount } = createMockTransport([
      parseError,          // error retry 1
      failingResult(),     // valid passed:false — return immediately
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(callCount()).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-RETRY-008: evaluator:invoked adapter idempotency with single emission
// ---------------------------------------------------------------------------

describe("VAL-RETRY-008: evaluator:invoked adapter idempotency", () => {
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

  it("handler called exactly once regardless of internal error retries", async () => {
    let handlerCallCount = 0;
    bus.subscribeToType("evaluator:invoked", () => {
      handlerCallCount++;
    });

    const parseError = new Error("JSON parse error");
    const { transport } = createMockTransport([
      parseError,
      parseError,
      passingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(handlerCallCount).toBe(1);
  });

  it("does not emit evaluator:invoked when skip_evaluation is true", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      skipEvaluation: true,
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EvaluationResult extension: feedback, suggestions, reasoning fields
// ---------------------------------------------------------------------------

describe("EvaluationResult carries evaluator feedback fields", () => {
  let Evaluator: typeof import("../src/evaluator/invoke").Evaluator;
  let bus: EventBus;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/invoke");
    Evaluator = mod.Evaluator;
    bus = new EventBus();
  });

  it("populates feedback, suggestions, and reasoning from failing EvaluatorResult", async () => {
    const { transport } = createMockTransport([
      failingResult({
        reasoning: "Tests are missing",
        feedback: "You need to add unit tests for the new function",
        suggestions: ["Add test for edge case", "Check error handling"],
      }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("You need to add unit tests for the new function");
    expect(result.suggestions).toEqual(["Add test for edge case", "Check error handling"]);
    expect(result.reasoning).toBe("Tests are missing");
  });

  it("feedback fields are undefined when passed:true (no feedback needed)", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(true);
    // Passing results don't need feedback fields
    expect(result.feedback).toBeUndefined();
    expect(result.suggestions).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });

  it("feedback fields are populated from transport error retries followed by valid failure", async () => {
    const parseError = new Error("JSON parse error");

    const { transport } = createMockTransport([
      parseError,
      failingResult({
        reasoning: "Bad output",
        feedback: "Detailed feedback",
        suggestions: ["Suggestion 1"],
      }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
      maxCycles: 3,
    });

    const result = await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: defaultCriteria,
      contextFiles: [],
    });

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Detailed feedback");
    expect(result.suggestions).toEqual(["Suggestion 1"]);
    expect(result.reasoning).toBe("Bad output");
  });
});
