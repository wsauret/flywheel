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

const mockSpawner: ProcessSpawner = {
  async spawn(command, args, options) {
    // Write verdict to handoff file (evaluator transport reads from file, not stdout)
    const pIdx = args.indexOf("-p");
    const prompt = pIdx > -1 ? args[pIdx + 1] : options?.stdin ?? "";
    const match = prompt.match(/`([^`]+\.json)`/);
    if (match) await Bun.write(match[1], JSON.stringify(validEvaluatorResult()));
    return {
      result: Promise.resolve({
        output: "",
        exitCode: 0,
        truncated: false,
        durationMs: 100,
        handoffPath: "/tmp/unused",
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// createEvaluatorTransport factory
// ---------------------------------------------------------------------------

describe("createEvaluatorTransport", () => {
  let createEvaluatorTransport: typeof import("../src/evaluator/create-transport").createEvaluatorTransport;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/create-transport");
    createEvaluatorTransport = mod.createEvaluatorTransport;
  });

  it("creates a transport with claude engine", async () => {
    const transport = await createEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("creates a transport with opencode engine", async () => {
    const transport = await createEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("defaults to opencode when no engine specified", async () => {
    const transport = await createEvaluatorTransport({
      spawner: mockSpawner,
    });
    expect(transport).toBeDefined();
    expect(typeof transport.invoke).toBe("function");
  });

  it("passes evaluatorModel through to the transport", async () => {
    let spawnedArgs: string[] = [];
    const capturingSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        // Write verdict to handoff file
        const pIdx = args.indexOf("-p");
        const prompt = pIdx > -1 ? args[pIdx + 1] : options?.stdin ?? "";
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(validEvaluatorResult()));
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = await createEvaluatorTransport({
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
      async spawn(command, args, options) {
        spawnedCommand = command;
        // Write verdict to handoff file
        const pIdx = args.indexOf("-p");
        const prompt = pIdx > -1 ? args[pIdx + 1] : options?.stdin ?? "";
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(validEvaluatorResult()));
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = await createEvaluatorTransport({
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

  it("throws when engine binary not found (nonexistent engine)", async () => {
    await expect(
      createEvaluatorTransport({
        spawner: mockSpawner,
        engineName: "nonexistent-engine",
      }),
    ).rejects.toThrow("nonexistent-engine");
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
// Dispatcher and evaluator transports share handoff-based file reading
// ---------------------------------------------------------------------------

describe("shared handoff-based reading used by both transports", () => {
  it("dispatcher transport reads decision from handoff file (not stdout)", async () => {
    // Verify that the dispatcher transport uses handoff files for decision reading
    const mod = await import("../src/dispatcher/subprocess-transport");
    const SubprocessTransport = mod.SubprocessTransport;

    const handoff = {
      schema_version: 1,
      phase_index: 0,
      task_content: "Test task via handoff",
      context_files: [],
    };

    const capturingSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        // Write handoff file from prompt
        const pIdx = args.indexOf("-p");
        const prompt = pIdx > -1 ? args[pIdx + 1] : options?.stdin ?? "";
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(handoff));
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    // Create with opencode engine
    const transport = new SubprocessTransport({
      spawner: capturingSpawner,
      engineName: "opencode",
    });

    const result = await transport.invoke({
      workflow_id: "test",
      plan: { phases: [] },
      state: "",
      workflow: { name: "work", step_number: 1, total_steps: 1, step_description: "test" },
      config: { max_eval_cycles: 3, worktree_path: "", project_cwd: ".", worker_model: "opus", dispatcher_model: "sonnet" },
      session_budget: { invocations_remaining: null, token_budget_remaining: null, wall_clock_deadline: null },
      available_context: { conventions: [], standards: [], learnings: [] },
    } as any);

    expect(result.task_content).toBe("Test task via handoff");
  });

  it("evaluator transport reads verdict from handoff file (not stdout)", async () => {
    const mod = await import("../src/evaluator/subprocess-transport");
    const SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;

    const verdict = validEvaluatorResult({ reasoning: "handoff verdict works" });
    const capturingSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        // Write verdict to handoff file
        const pIdx = args.indexOf("-p");
        const prompt = pIdx > -1 ? args[pIdx + 1] : options?.stdin ?? "";
        const match = prompt.match(/`([^`]+\.json)`/);
        if (match) await Bun.write(match[1], JSON.stringify(verdict));
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
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

    expect(result.reasoning).toBe("handoff verdict works");
  });
});
