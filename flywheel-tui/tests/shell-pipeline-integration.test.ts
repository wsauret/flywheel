import { describe, it, expect } from "bun:test";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";
import {
  buildPipelineStages,
  createShellStageRunner,
} from "../src/tui/components/shell-pipeline";
import type { PipelineStage, PipelineStageResult, StageRunner } from "../src/controller/workflow-pipeline";
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
      pid: 1,
      stdout: null,
      stderr: null,
      exitCode: 0,
      kill: () => {},
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
