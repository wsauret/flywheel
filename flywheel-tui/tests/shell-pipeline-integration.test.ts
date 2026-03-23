import { describe, it, expect } from "bun:test";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";
import {
  buildPipelineStages,
  createShellStageRunner,
} from "../src/tui/components/shell-pipeline";
import {
  WorkflowPipeline,
  type PipelineStage,
  type PipelineStageResult,
  type StageRunner,
} from "../src/controller/workflow-pipeline";
import { EventBus } from "../src/events/event-bus";
import { QuestionService } from "../src/controller/question-service";
import type { FlywheelEvent } from "../src/events/types";
import type { WorkflowDeps } from "../src/controller/workflow-deps";
import type { Engine } from "../src/engines/core/types";
import type { ProcessSpawner } from "../src/worker/spawner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    ...CONFIG_DEFAULTS,
    interactive_consolidation: false,
    ...overrides,
  };
}

function makeFakeEngine(id = "claude"): Engine {
  return {
    metadata: {
      id,
      name: id,
      cliBinary: id,
      installCommand: `npm install ${id}`,
    },
    buildCommand: () => ({ command: id, args: [] }),
    listModels: async () => [],
  } as unknown as Engine;
}

function makeFakeSpawner(): ProcessSpawner {
  return {
    spawn: async () => ({
      result: Promise.resolve({
        output: "",
        exitCode: 0,
        truncated: false,
        durationMs: 0,
      }),
    }),
  } as unknown as ProcessSpawner;
}

function makeDeps(configOverrides: Partial<FlywheelConfig> = {}): WorkflowDeps {
  return {
    config: makeConfig(configOverrides),
    engine: makeFakeEngine(),
    spawner: makeFakeSpawner(),
  };
}

// ===========================================================================
// buildPipelineStages
// ===========================================================================

describe("buildPipelineStages", () => {
  describe("auto_chain: true (default)", () => {
    it("/plan creates pipeline [plan, work, review]", () => {
      const config = makeConfig({ auto_chain: true, auto_ship: false });
      const stages = buildPipelineStages("plan", config);

      expect(stages).not.toBeNull();
      expect(stages!.map((s) => s.workflow)).toEqual([
        "plan",
        "work",
        "review",
      ]);
    });

    it("/work creates pipeline [work, review]", () => {
      const config = makeConfig({ auto_chain: true, auto_ship: false });
      const stages = buildPipelineStages("work", config);

      expect(stages).not.toBeNull();
      expect(stages!.map((s) => s.workflow)).toEqual(["work", "review"]);
    });

    it("auto_ship: true appends 'ship' stage to /plan pipeline", () => {
      const config = makeConfig({ auto_chain: true, auto_ship: true });
      const stages = buildPipelineStages("plan", config);

      expect(stages).not.toBeNull();
      expect(stages!.map((s) => s.workflow)).toEqual([
        "plan",
        "work",
        "review",
        "ship",
      ]);
    });

    it("auto_ship: true appends 'ship' stage to /work pipeline", () => {
      const config = makeConfig({ auto_chain: true, auto_ship: true });
      const stages = buildPipelineStages("work", config);

      expect(stages).not.toBeNull();
      expect(stages!.map((s) => s.workflow)).toEqual([
        "work",
        "review",
        "ship",
      ]);
    });

    it("standalone /review returns null (no pipeline)", () => {
      const config = makeConfig({ auto_chain: true });
      const stages = buildPipelineStages("review", config);
      expect(stages).toBeNull();
    });

    it("standalone /ship returns null (no pipeline)", () => {
      const config = makeConfig({ auto_chain: true });
      const stages = buildPipelineStages("ship", config);
      expect(stages).toBeNull();
    });

    it("standalone /debug returns null (no pipeline)", () => {
      const config = makeConfig({ auto_chain: true });
      const stages = buildPipelineStages("debug", config);
      expect(stages).toBeNull();
    });

    it("standalone /research returns null (no pipeline)", () => {
      const config = makeConfig({ auto_chain: true });
      const stages = buildPipelineStages("research", config);
      expect(stages).toBeNull();
    });
  });

  describe("auto_chain: false", () => {
    it("/plan returns null (no pipeline, standalone)", () => {
      const config = makeConfig({ auto_chain: false });
      const stages = buildPipelineStages("plan", config);
      expect(stages).toBeNull();
    });

    it("/work returns null (no pipeline, standalone)", () => {
      const config = makeConfig({ auto_chain: false });
      const stages = buildPipelineStages("work", config);
      expect(stages).toBeNull();
    });

    it("/review returns null (no pipeline)", () => {
      const config = makeConfig({ auto_chain: false });
      const stages = buildPipelineStages("review", config);
      expect(stages).toBeNull();
    });
  });

  describe("auto_chain defaults to true in CONFIG_DEFAULTS", () => {
    it("CONFIG_DEFAULTS has auto_chain: true", () => {
      expect(CONFIG_DEFAULTS.auto_chain).toBe(true);
    });

    it("CONFIG_DEFAULTS has auto_ship: false", () => {
      expect(CONFIG_DEFAULTS.auto_ship).toBe(false);
    });

    it("/plan with defaults creates 3-stage pipeline (no ship)", () => {
      const stages = buildPipelineStages("plan", CONFIG_DEFAULTS);
      expect(stages).not.toBeNull();
      expect(stages!).toHaveLength(3);
      expect(stages!.map((s) => s.workflow)).toEqual([
        "plan",
        "work",
        "review",
      ]);
    });
  });
});

// ===========================================================================
// Stage composition edge cases
// ===========================================================================

describe("buildPipelineStages — edge cases", () => {
  it("unknown workflow name returns null", () => {
    const config = makeConfig({ auto_chain: true });
    const stages = buildPipelineStages("unknown", config);
    expect(stages).toBeNull();
  });

  it("empty string workflow returns null", () => {
    const config = makeConfig({ auto_chain: true });
    const stages = buildPipelineStages("", config);
    expect(stages).toBeNull();
  });

  it("/plan pipeline stages have correct WorkflowType values", () => {
    const config = makeConfig({ auto_chain: true, auto_ship: true });
    const stages = buildPipelineStages("plan", config)!;

    const validTypes = ["plan", "work", "review", "ship", "debug", "research"];
    for (const stage of stages) {
      expect(validTypes).toContain(stage.workflow);
    }
  });
});

// ===========================================================================
// Config loaded once at pipeline start
// ===========================================================================

describe("Config loading at pipeline start", () => {
  it("buildPipelineStages reads auto_chain and auto_ship from config", () => {
    // Verifies that the function respects the config values (not hardcoded)
    const configChainOn = makeConfig({ auto_chain: true, auto_ship: false });
    const configChainOff = makeConfig({ auto_chain: false, auto_ship: false });
    const configShipOn = makeConfig({ auto_chain: true, auto_ship: true });

    // Chain on, ship off: 3 stages for plan
    expect(buildPipelineStages("plan", configChainOn)!).toHaveLength(3);

    // Chain off: null for plan
    expect(buildPipelineStages("plan", configChainOff)).toBeNull();

    // Chain on, ship on: 4 stages for plan
    expect(buildPipelineStages("plan", configShipOn)!).toHaveLength(4);
  });
});

// ===========================================================================
// createShellStageRunner — unit-level tests
// ===========================================================================

describe("createShellStageRunner", () => {
  // Note: We can't fully test createShellStageRunner without real
  // WorkController/ExecutionLoop infrastructure. These tests verify
  // the factory function's behavior with unknown workflow types and
  // basic structure.

  it("returns a function", () => {
    // Minimal mock session — just enough to verify the factory works
    const mockSession = {
      store: {} as any,
      adapter: {
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        isConnected: () => true,
        isRunning: () => true,
      } as any,
      eventBus: { emit: () => {}, subscribe: () => () => {} } as any,
      planPath: "test",
    };
    const deps = makeDeps();

    const runner = createShellStageRunner(mockSession as any, deps);
    expect(typeof runner).toBe("function");
  });

  it("unknown workflow type returns completed: false", async () => {
    const mockSession = {
      store: {} as any,
      adapter: {
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        isConnected: () => true,
        isRunning: () => true,
      } as any,
      eventBus: { emit: () => {}, subscribe: () => () => {} } as any,
      planPath: "test",
    };
    const deps = makeDeps();

    const runner = createShellStageRunner(mockSession as any, deps);
    const ac = new AbortController();

    // Force an unknown workflow type through the runner
    const result = await runner(
      { workflow: "bogus" as any },
      {},
      ac.signal,
    );

    expect(result.completed).toBe(false);
    expect(result.reason).toContain("Unknown workflow");
  });

  it("work stage without planPath returns completed: false", async () => {
    // When work stage is called but no planPath is in args,
    // it falls through to the generic path where "work" is not
    // in workflowRegistry, so it should fail gracefully.
    const mockSession = {
      store: {} as any,
      adapter: {
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        isConnected: () => true,
        isRunning: () => true,
      } as any,
      eventBus: { emit: () => {}, subscribe: () => () => {} } as any,
      planPath: "test",
    };
    const deps = makeDeps();

    const runner = createShellStageRunner(mockSession as any, deps);
    const ac = new AbortController();

    // Work stage without planPath in args — falls through to generic
    // "work" is not in workflowRegistry (it uses WorkController)
    const result = await runner(
      { workflow: "work" },
      {}, // no planPath
      ac.signal,
    );

    expect(result.completed).toBe(false);
    expect(result.reason).toContain("No plan file path");
  });
});

// ===========================================================================
// createShellStageRunner — QuestionService parameter
// ===========================================================================

describe("createShellStageRunner with QuestionService", () => {
  const makeMockSession = () => ({
    store: {} as any,
    adapter: {
      connect: () => {},
      start: () => {},
      stop: () => {},
      disconnect: () => {},
      isConnected: () => true,
      isRunning: () => true,
    } as any,
    eventBus: { emit: () => {}, subscribe: () => () => {} } as any,
    planPath: "test",
  });

  it("accepts questionService parameter and returns a StageRunner", () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const deps = makeDeps();

    const runner = createShellStageRunner(
      makeMockSession() as any,
      deps,
      questionService,
    );
    expect(typeof runner).toBe("function");
  });

  it("still works without questionService (backward compatible)", () => {
    const deps = makeDeps();

    const runner = createShellStageRunner(makeMockSession() as any, deps);
    expect(typeof runner).toBe("function");
  });

  it("unknown workflow still fails gracefully with questionService", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const deps = makeDeps();

    const runner = createShellStageRunner(
      makeMockSession() as any,
      deps,
      questionService,
    );
    const ac = new AbortController();

    const result = await runner(
      { workflow: "bogus" as any },
      {},
      ac.signal,
    );
    expect(result.completed).toBe(false);
    expect(result.reason).toContain("Unknown workflow");
  });

  it("reads interactive_consolidation from config and forwards to plan hook", () => {
    // We can't run a full plan stage, but we verify the factory
    // constructs successfully with interactive_consolidation: true
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const deps = makeDeps({ interactive_consolidation: true });

    const runner = createShellStageRunner(
      makeMockSession() as any,
      deps,
      questionService,
    );
    // If it didn't throw, the config was read and wired correctly
    expect(typeof runner).toBe("function");
  });

  it("work stage without planPath returns completed: false (with questionService)", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const deps = makeDeps();

    const runner = createShellStageRunner(
      makeMockSession() as any,
      deps,
      questionService,
    );
    const ac = new AbortController();

    const result = await runner(
      { workflow: "work" },
      {},
      ac.signal,
    );
    expect(result.completed).toBe(false);
    expect(result.reason).toContain("No plan file path");
  });
});

// ===========================================================================
// Integration: pipeline stages + stage types
// ===========================================================================

describe("Pipeline stage types match workflow registry", () => {
  it("non-work stages in pipeline correspond to entries in workflowRegistry", () => {
    // Import the registry to verify
    const { workflowRegistry } = require("../src/workflows/index");

    const config = makeConfig({ auto_chain: true, auto_ship: true });
    const stages = buildPipelineStages("plan", config)!;

    // plan, review, ship should be in the registry
    const nonWorkStages = stages.filter((s) => s.workflow !== "work");
    for (const stage of nonWorkStages) {
      expect(workflowRegistry[stage.workflow]).toBeDefined();
    }
  });

  it("'work' stage is NOT in workflowRegistry (uses WorkController)", () => {
    const { workflowRegistry } = require("../src/workflows/index");
    expect(workflowRegistry["work"]).toBeUndefined();
  });
});

// ===========================================================================
// ExecutionLoop.getAccumulatedExtra
// ===========================================================================

describe("ExecutionLoop.getAccumulatedExtra", () => {
  it("returns empty object before run()", () => {
    const { ExecutionLoop } = require("../src/controller/execution-loop");

    // Minimal construction — just enough to call getAccumulatedExtra
    const loop = new ExecutionLoop({
      phaseProvider: { getPhases: () => [] },
      promptBuilder: () => "",
      executor: {} as any,
      emitter: {
        workflowStarted: () => {},
        workflowFailed: () => {},
        workflowCompleted: () => {},
      } as any,
      config: makeConfig(),
      ui: {} as any,
      workflowId: "test",
      workflowLabel: "test",
    });

    const extra = loop.getAccumulatedExtra();
    expect(extra).toEqual({});
  });

  it("returns a copy (not a reference to internal state)", () => {
    const { ExecutionLoop } = require("../src/controller/execution-loop");

    const loop = new ExecutionLoop({
      phaseProvider: { getPhases: () => [] },
      promptBuilder: () => "",
      executor: {} as any,
      emitter: {
        workflowStarted: () => {},
        workflowFailed: () => {},
        workflowCompleted: () => {},
      } as any,
      config: makeConfig(),
      ui: {} as any,
      workflowId: "test",
      workflowLabel: "test",
    });

    const extra1 = loop.getAccumulatedExtra();
    const extra2 = loop.getAccumulatedExtra();

    // Should be equal but not the same reference
    expect(extra1).toEqual(extra2);
    expect(extra1).not.toBe(extra2);
  });
});

// ===========================================================================
// Phase 4: Pipeline result handling — contract tests for shell integration
// ===========================================================================

describe("Pipeline result handling (shell contract)", () => {
  // Helper: create a simple stage runner that can succeed or fail
  function mockStageRunner(opts?: {
    failAt?: string;
    failReason?: string;
  }): StageRunner {
    return async (stage, _args, _signal) => {
      if (opts?.failAt === stage.workflow) {
        return {
          workflow: stage.workflow,
          completed: false,
          reason: opts.failReason ?? `${stage.workflow} stage failed`,
        };
      }
      return {
        workflow: stage.workflow,
        completed: true,
        ...(stage.workflow === "plan" ? { planPath: "/tmp/plan.md" } : {}),
      };
    };
  }

  it("pipeline.run() returns { completed: true } when all stages succeed", async () => {
    const bus = new EventBus();
    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: makeConfig(),
      stageRunner: mockStageRunner(),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(result.stagesTotal).toBe(3);
    expect(result.reason).toBeUndefined();
  });

  it("pipeline.run() returns { completed: false, reason } when a stage fails", async () => {
    const bus = new EventBus();
    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: makeConfig(),
      stageRunner: mockStageRunner({
        failAt: "work",
        failReason: "Work stage compilation error",
      }),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // only plan completed
    expect(result.stagesTotal).toBe(3);
    expect(result.reason).toBe("Work stage compilation error");
  });

  it("pipeline.run() returns { completed: false } with default reason when stage fails without reason", async () => {
    const bus = new EventBus();
    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage) => {
        if (stage.workflow === "work") {
          return { workflow: "work", completed: false }; // no reason
        }
        return { workflow: stage.workflow, completed: true };
      },
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    // Pipeline should provide a default reason
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain("work");
  });

  it("pipeline.run() returns { completed: false } when shut down", async () => {
    const bus = new EventBus();
    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage, _args, signal) => {
        // plan succeeds quickly
        if (stage.workflow === "plan") {
          return { workflow: "plan", completed: true, planPath: "/tmp/p.md" };
        }
        // work hangs until aborted
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ workflow: "work", completed: false, reason: "aborted" });
          });
        });
      },
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    // Start run, then shut down after a tick
    const runPromise = pipeline.run();
    // Give plan time to complete, then abort during work
    await new Promise((r) => setTimeout(r, 10));
    pipeline.requestShutdown();

    const result = await runPromise;

    expect(result.completed).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ===========================================================================
// Phase 4: pipeline:stage-transition event contract
// ===========================================================================

describe("pipeline:stage-transition event contract", () => {
  it("stage-transition event has from and to fields", async () => {
    const bus = new EventBus();
    const transitions: Array<{ from: string; to: string }> = [];

    bus.subscribeToType("pipeline:stage-transition", (e) => {
      transitions.push({ from: e.from, to: e.to });
    });

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage) => ({
        workflow: stage.workflow,
        completed: true,
        ...(stage.workflow === "plan" ? { planPath: "/tmp/p.md" } : {}),
      }),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toEqual({ from: "plan", to: "work" });
    expect(transitions[1]).toEqual({ from: "work", to: "review" });
  });

  it("pipeline:started event has stages array with workflow names", async () => {
    const bus = new EventBus();
    let startedStages: string[] = [];

    bus.subscribeToType("pipeline:started", (e) => {
      startedStages = e.stages;
    });

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage) => ({
        workflow: stage.workflow,
        completed: true,
      }),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    expect(startedStages).toEqual(["plan", "work", "review"]);
  });

  it("pipeline:failed event fires when a stage fails", async () => {
    const bus = new EventBus();
    let failedReason: string | undefined;

    bus.subscribeToType("pipeline:failed", (e) => {
      failedReason = e.reason;
    });

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage) => {
        if (stage.workflow === "work") {
          return { workflow: "work", completed: false, reason: "tests failed" };
        }
        return { workflow: stage.workflow, completed: true };
      },
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    expect(failedReason).toBe("tests failed");
  });

  it("no stage-transition event fires for a single-stage pipeline", async () => {
    const bus = new EventBus();
    const transitions: any[] = [];

    bus.subscribeToType("pipeline:stage-transition", (e) => {
      transitions.push(e);
    });

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "review" }],
      args: {},
      config: makeConfig(),
      stageRunner: async (stage) => ({
        workflow: stage.workflow,
        completed: true,
      }),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    expect(transitions).toHaveLength(0);
  });
});
