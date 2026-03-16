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
    ...overrides,
  };
}

function failingResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: false,
    reasoning: "Validation criteria not met",
    suggestions: ["Fix the output"],
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
// a) Max 2 re-prompt cycles
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

    const result = await evaluator.evaluate("worker output", "must be valid", ["src/index.ts"]);

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(1);
    expect(result.skipped).toBe(false);
    expect(callCount()).toBe(1);
  });

  it("fails first, passes on second try — success", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      passingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("worker output", "must be valid", ["src/index.ts"]);

    expect(result.passed).toBe(true);
    expect(result.cyclesUsed).toBe(2);
    expect(result.skipped).toBe(false);
    expect(callCount()).toBe(2);
  });

  it("fails twice — marks as failed and proceeds", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult({ reasoning: "Missing tests" }),
      failingResult({ reasoning: "Still missing tests" }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("worker output", "must have tests", ["src/index.ts"]);

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("Still missing tests");
    expect(callCount()).toBe(2);
  });

  it("does not attempt a third cycle after two failures", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      failingResult(),
      passingResult(), // should never be reached
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("output", "criteria", []);

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
    expect(callCount()).toBe(2); // third call never made
  });
});

// ---------------------------------------------------------------------------
// b) Timeouts do NOT count against 2-cycle cap
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

    const result = await evaluator.evaluate("worker output", "criteria", []);

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

    const result = await evaluator.evaluate("output", "criteria", []);

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

    await evaluator.evaluate("output", "criteria", []);

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

    const result = await evaluator.evaluate("output", "criteria", []);

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

    const result = await evaluator.evaluate("output", "criteria", []);

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

    const result = await evaluator.evaluate("output", "criteria", []);

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

    await evaluator.evaluate(
      "worker output text",
      "must pass all tests",
      ["src/main.ts", "tests/main.test.ts"],
    );

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]).toEqual({
      worker_output: "worker output text",
      validation_criteria: "must pass all tests",
      context_files: ["src/main.ts", "tests/main.test.ts"],
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

    const result = await evaluator.evaluate("output", "criteria", []);

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
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

  it("passed: false counts as failure (increments cap)", async () => {
    const { transport, callCount } = createMockTransport([
      failingResult(),
      failingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("output", "criteria", []);

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
    expect(callCount()).toBe(2);
  });

  it("schema parse error counts as failure (increments cap)", async () => {
    // Simulate a schema parse error by having transport throw a non-timeout error
    const schemaError = new Error("Schema validation failed");
    schemaError.name = "SchemaError";

    const { transport, callCount } = createMockTransport([
      schemaError,
      schemaError,
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("output", "criteria", []);

    expect(result.passed).toBe(false);
    expect(result.cyclesUsed).toBe(2);
    expect(callCount()).toBe(2);
  });

  it("timeout is NOT a failure — skip and proceed", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    const result = await evaluator.evaluate("output", "criteria", []);

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

  it("emits evaluator:invoked before each evaluation", async () => {
    const { transport } = createMockTransport([failingResult(), passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

    const invokedEvents = events.filter((e) => e.type === "evaluator:invoked");
    expect(invokedEvents).toHaveLength(2); // one per cycle
  });

  it("emits evaluator:completed after success", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

    const completedEvents = events.filter((e) => e.type === "evaluator:completed");
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as any).result.passed).toBe(true);
  });

  it("emits evaluator:completed after 2 failures (with last result)", async () => {
    const { transport } = createMockTransport([
      failingResult({ reasoning: "first failure" }),
      failingResult({ reasoning: "second failure" }),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

    const completedEvents = events.filter((e) => e.type === "evaluator:completed");
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as any).result.passed).toBe(false);
    expect((completedEvents[0] as any).result.reasoning).toBe("second failure");
  });

  it("emits evaluator:failed on timeout", async () => {
    const { transport } = createMockTransport(["timeout"]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("emits evaluator:failed on non-timeout error", async () => {
    const { transport } = createMockTransport([
      new Error("Something broke"),
      new Error("Still broken"),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

    const failedEvents = events.filter((e) => e.type === "evaluator:failed");
    expect(failedEvents).toHaveLength(2); // one per failed attempt
  });

  it("evaluator:invoked comes before evaluator:completed", async () => {
    const { transport } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate("output", "criteria", []);

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

    await evaluator.evaluate("output", "criteria", []);

    const evaluatorEvents = events.filter((e) =>
      e.type.startsWith("evaluator:"),
    );
    expect(evaluatorEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// g) CliEvaluatorTransport
// ---------------------------------------------------------------------------

describe("CliEvaluatorTransport", () => {
  let CliEvaluatorTransport: typeof import("../src/evaluator/cli-transport").CliEvaluatorTransport;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/cli-transport");
    CliEvaluatorTransport = mod.CliEvaluatorTransport;
  });

  it("spawns process and parses EvaluatorResult from stdout", async () => {
    const result = passingResult({ reasoning: "Code looks good" });

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn() {
        return {
          output: JSON.stringify(result),
          exitCode: 0,
          truncated: false,
          durationMs: 1000,
        };
      },
    };

    const transport = new CliEvaluatorTransport({ spawner: mockSpawner });
    const evalResult = await transport.invoke({
      worker_output: "some output",
      validation_criteria: "must pass",
      context_files: [],
    });

    expect(evalResult.passed).toBe(true);
    expect(evalResult.reasoning).toBe("Code looks good");
  });

  it("retries once on parse failure", async () => {
    let callCount = 0;
    const validResult = passingResult();

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn() {
        callCount++;
        if (callCount === 1) {
          return {
            output: "not valid json {{{",
            exitCode: 0,
            truncated: false,
            durationMs: 500,
          };
        }
        return {
          output: JSON.stringify(validResult),
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        };
      },
    };

    const transport = new CliEvaluatorTransport({ spawner: mockSpawner });
    const result = await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
    });

    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("throws after two parse failures", async () => {
    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn() {
        return {
          output: "garbage output",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
        };
      },
    };

    const transport = new CliEvaluatorTransport({ spawner: mockSpawner });

    await expect(
      transport.invoke({
        worker_output: "output",
        validation_criteria: "criteria",
        context_files: [],
      }),
    ).rejects.toThrow();
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: import("../src/worker/spawner").ProcessSpawner = {
      async spawn(_command, _args, options) {
        receivedEnv = options?.env;
        return {
          output: JSON.stringify(passingResult()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        };
      },
    };

    const transport = new CliEvaluatorTransport({ spawner: mockSpawner });
    await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
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
        return {
          output: JSON.stringify(passingResult()),
          exitCode: 0,
          truncated: false,
          durationMs: 100,
        };
      },
    };

    const transport = new CliEvaluatorTransport({ spawner: mockSpawner });
    await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
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
