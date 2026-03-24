import { describe, it, expect, beforeEach } from "bun:test";
import type { ProcessSpawner } from "../src/worker/spawner";
import type { EvaluatorResult } from "../src/schemas/evaluator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEvaluatorResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
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

function wrapNDJSON(text: string): string {
  return `{"type":"text","part":{"type":"text","text":${JSON.stringify(text)}}}\n`;
}

const mockSpawner: ProcessSpawner = {
  async spawn(command, args) {
    const isOpenCode = command === "opencode";
    const output = isOpenCode
      ? wrapNDJSON(JSON.stringify(validEvaluatorResult()))
      : JSON.stringify(validEvaluatorResult());
    return {
      result: Promise.resolve({
        output,
        exitCode: 0,
        truncated: false,
        durationMs: 100,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Shared NDJSON text extractor
// ---------------------------------------------------------------------------

describe("extractTextFromNDJSON (shared utility)", () => {
  let extractTextFromNDJSON: typeof import("../src/utils/ndjson-text-extractor").extractTextFromNDJSON;

  beforeEach(async () => {
    const mod = await import("../src/utils/ndjson-text-extractor");
    extractTextFromNDJSON = mod.extractTextFromNDJSON;
  });

  it("extracts text from valid NDJSON text events", () => {
    const output = [
      '{"type":"text","part":{"type":"text","text":"Hello "}}',
      '{"type":"text","part":{"type":"text","text":"world"}}',
    ].join("\n");

    expect(extractTextFromNDJSON(output)).toBe("Hello world");
  });

  it("returns empty string when no text events found", () => {
    const output = '{"type":"tool_use","data":{"name":"bash"}}\n';
    expect(extractTextFromNDJSON(output)).toBe("");
  });

  it("skips non-JSON lines gracefully", () => {
    const output = [
      "some random log output",
      '{"type":"text","part":{"type":"text","text":"extracted"}}',
      "more garbage",
    ].join("\n");

    expect(extractTextFromNDJSON(output)).toBe("extracted");
  });

  it("handles empty input", () => {
    expect(extractTextFromNDJSON("")).toBe("");
  });

  it("handles input with only whitespace lines", () => {
    expect(extractTextFromNDJSON("\n  \n  \n")).toBe("");
  });

  it("concatenates text without separator", () => {
    const output = [
      '{"type":"text","part":{"type":"text","text":"abc"}}',
      '{"type":"text","part":{"type":"text","text":"def"}}',
    ].join("\n");

    expect(extractTextFromNDJSON(output)).toBe("abcdef");
  });

  it("ignores events with wrong type", () => {
    const output = [
      '{"type":"tool_use","part":{"type":"text","text":"should not appear"}}',
      '{"type":"step_finish","data":{}}',
      '{"type":"text","part":{"type":"text","text":"only this"}}',
    ].join("\n");

    expect(extractTextFromNDJSON(output)).toBe("only this");
  });

  it("ignores text events where part.text is not a string", () => {
    const output = [
      '{"type":"text","part":{"type":"text","text":123}}',
      '{"type":"text","part":{"type":"text","text":"valid"}}',
    ].join("\n");

    expect(extractTextFromNDJSON(output)).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// createEvaluatorTransport factory
// ---------------------------------------------------------------------------

describe("createEvaluatorTransport", () => {
  let createEvaluatorTransport: typeof import("../src/evaluator/create-transport").createEvaluatorTransport;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/create-transport");
    createEvaluatorTransport = mod.createEvaluatorTransport;
  });

  it("creates a transport with claude engine", () => {
    const transport = createEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("creates a transport with opencode engine", () => {
    const transport = createEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("defaults to opencode when no engine specified", () => {
    const transport = createEvaluatorTransport({
      spawner: mockSpawner,
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("passes evaluatorModel through to the transport", async () => {
    let spawnedArgs: string[] = [];
    const capturingSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = createEvaluatorTransport({
      spawner: capturingSpawner,
      engineName: "claude",
      evaluatorModel: "haiku",
    });

    await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: true,
      duration_seconds: 10,
    });

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  it("created transport uses engine for command building", async () => {
    let spawnedCommand = "";
    const capturingSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedCommand = command;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = createEvaluatorTransport({
      spawner: capturingSpawner,
      engineName: "claude",
    });

    await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: true,
      duration_seconds: 10,
    });

    expect(spawnedCommand).toBe("claude");
  });

  it("throws when engine binary not found (nonexistent engine)", () => {
    expect(() =>
      createEvaluatorTransport({
        spawner: mockSpawner,
        engineName: "nonexistent-engine",
      }),
    ).toThrow("nonexistent-engine");
  });
});

// ---------------------------------------------------------------------------
// Production wiring: stage-loop-factory accepts evaluatorTransport
// ---------------------------------------------------------------------------

describe("stage-loop-factory evaluator transport wiring", () => {
  let createStageLoop: typeof import("../src/controller/stage-loop-factory").createStageLoop;

  beforeEach(async () => {
    const mod = await import("../src/controller/stage-loop-factory");
    createStageLoop = mod.createStageLoop;
  });

  it("accepts evaluatorTransport option without error", async () => {
    const { EventBus } = await import("../src/events/event-bus");
    const { getEngine } = await import("../src/engines/core/registry");
    const { CONFIG_DEFAULTS } = await import("../src/config/loader");

    const bus = new EventBus();
    const engine = getEngine("claude");
    const config = { ...CONFIG_DEFAULTS, engine: "claude" } as any;

    // Create a mock evaluator transport
    const evaluatorTransport = {
      invoke: async () => validEvaluatorResult(),
    };

    // Create a mock UI adapter
    const ui = {
      onEvent: () => {},
      render: () => {},
      dispose: () => {},
    };

    const handle = createStageLoop({
      workflow: "plan",
      args: { description: "test" },
      config,
      spawner: mockSpawner,
      engine,
      ui: ui as any,
      eventBus: bus,
      evaluatorTransport,
    });

    expect(handle).toBeDefined();
    expect(handle.loop).toBeDefined();
    expect(typeof handle.shutdown).toBe("function");
  });

  it("works without evaluatorTransport (backward compat)", async () => {
    const { EventBus } = await import("../src/events/event-bus");
    const { getEngine } = await import("../src/engines/core/registry");
    const { CONFIG_DEFAULTS } = await import("../src/config/loader");

    const bus = new EventBus();
    const engine = getEngine("claude");
    const config = { ...CONFIG_DEFAULTS, engine: "claude" } as any;

    const ui = {
      onEvent: () => {},
      render: () => {},
      dispose: () => {},
    };

    // No evaluatorTransport — should work fine
    const handle = createStageLoop({
      workflow: "plan",
      args: { description: "test" },
      config,
      spawner: mockSpawner,
      engine,
      ui: ui as any,
      eventBus: bus,
    });

    expect(handle).toBeDefined();
    expect(handle.loop).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config flow: engine config flows from flywheel config to evaluator transport
// ---------------------------------------------------------------------------

describe("Config → evaluator transport model flow", () => {
  it("resolveModels returns dispatcherModel that can be used as evaluatorModel", async () => {
    const { resolveModels, CONFIG_DEFAULTS } = await import("../src/config/loader");

    // When dispatcher.model is set, it flows through
    const configWithModel = {
      ...CONFIG_DEFAULTS,
      dispatcher: { model: "haiku" },
    } as any;
    const { dispatcherModel } = resolveModels(configWithModel);
    expect(dispatcherModel).toBe("haiku");
  });

  it("resolveModels falls back to global model", async () => {
    const { resolveModels, CONFIG_DEFAULTS } = await import("../src/config/loader");

    const configWithGlobal = {
      ...CONFIG_DEFAULTS,
      model: "opus",
    } as any;
    const { dispatcherModel } = resolveModels(configWithGlobal);
    expect(dispatcherModel).toBe("opus");
  });

  it("resolveModels returns undefined when no model configured (engine default used)", async () => {
    const { resolveModels, CONFIG_DEFAULTS } = await import("../src/config/loader");

    const configDefault = { ...CONFIG_DEFAULTS } as any;
    const { dispatcherModel } = resolveModels(configDefault);
    expect(dispatcherModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher and evaluator transports share the same extractTextFromNDJSON
// ---------------------------------------------------------------------------

describe("shared extractTextFromNDJSON used by both transports", () => {
  it("dispatcher transport uses shared utility", async () => {
    // Verify that the dispatcher transport imports from the shared utility
    // by checking it works correctly with NDJSON output
    const mod = await import("../src/dispatcher/subprocess-transport");
    const SubprocessTransport = mod.SubprocessTransport;

    let spawnedOutput = "";
    const capturingSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: spawnedOutput,
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    // Create with opencode engine (uses NDJSON parsing)
    const transport = new SubprocessTransport({
      spawner: capturingSpawner,
      engineName: "opencode",
    });

    // Set output to NDJSON with valid dispatcher decision
    const decision = {
      schema_version: 1,
      phase_index: 0,
      step_index: 0,
      task_content: "Test task",
      context_files: [],
      context_to_inline: [],
      validation_criteria: {
        acceptance_criteria: [],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
    };
    spawnedOutput = wrapNDJSON(JSON.stringify(decision));

    const result = await transport.invoke({
      workflow_id: "test",
      plan: { phases: [] },
      state: "",
      workflow: { name: "work", step_number: 1, total_steps: 1, step_description: "test" },
      config: { max_eval_cycles: 3, worktree_path: "", project_cwd: ".", worker_model: "opus", dispatcher_model: "sonnet" },
      session_budget: { invocations_remaining: null, token_budget_remaining: null, wall_clock_deadline: null },
      available_context: { conventions: [], standards: [], learnings: [] },
    });

    expect(result.task_content).toBe("Test task");
  });

  it("evaluator transport uses shared utility", async () => {
    const mod = await import("../src/evaluator/subprocess-transport");
    const SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;

    const capturingSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult({ reasoning: "shared util works" }))),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: capturingSpawner,
      engineName: "opencode",
    });

    const result = await transport.invoke({
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: true,
      duration_seconds: 10,
    });

    expect(result.reasoning).toBe("shared util works");
  });
});
