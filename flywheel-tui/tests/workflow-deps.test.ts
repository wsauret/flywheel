import { describe, it, expect } from "bun:test";
import { prepareWorkflowDeps } from "../src/orchestration/engines/workflow-deps";
import type { FlywheelConfig } from "../src/orchestration/config/schema";
import type { Engine } from "../src/orchestration/engines/core/types";
import type { WorkflowDepsOverrides } from "../src/orchestration/engines/workflow-deps";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    engine: "claude",
    dispatcher: {},
    worker: {},
    timeout_minutes: 60,
    skip_evaluation: false,
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

function makeOverrides(
  opts: {
    config?: FlywheelConfig;
    engineId?: string;
    failConfig?: string;
    failEngine?: string;
  } = {},
): WorkflowDepsOverrides {
  const config = opts.config ?? makeConfig();

  return {
    loadConfig: opts.failConfig
      ? () => { throw new Error(opts.failConfig); }
      : () => ({ config, warnings: [] }),
    getEngine: opts.failEngine
      ? () => { throw new Error(opts.failEngine); }
      : (id: string) => makeFakeEngine(id),
  };
}

// ---------------------------------------------------------------------------
// prepareWorkflowDeps
// ---------------------------------------------------------------------------

describe("prepareWorkflowDeps", () => {
  it("returns { config, engine } on success", () => {
    const deps = prepareWorkflowDeps(makeOverrides());

    expect(deps).toBeDefined();
    expect(deps.config).toBeDefined();
    expect(deps.engine).toBeDefined();
    expect(deps.config.engine).toBe("claude");
  });

  it("uses the engine from config", () => {
    const config = makeConfig({ engine: "opencode" });
    let requestedEngineId: string | undefined;

    const overrides = makeOverrides({ config });
    const origGetEngine = overrides.getEngine!;
    overrides.getEngine = (id: string) => {
      requestedEngineId = id;
      return origGetEngine(id);
    };

    prepareWorkflowDeps(overrides);

    expect(requestedEngineId).toBe("opencode");
  });

  it("throws when config loading fails", () => {
    const overrides = makeOverrides({
      failConfig: "Invalid configuration: engine is required",
    });

    expect(() => prepareWorkflowDeps(overrides)).toThrow("Invalid configuration");
  });

  it("throws when engine lookup fails", () => {
    const overrides = makeOverrides({
      failEngine: 'Unknown engine "bad-engine". Available engines: claude, opencode',
    });

    expect(() => prepareWorkflowDeps(overrides)).toThrow("Unknown engine");
  });

  it("returns config from loadConfig result", () => {
    const config = makeConfig({ timeout_minutes: 90 });
    const deps = prepareWorkflowDeps(makeOverrides({ config }));

    expect(deps.config.timeout_minutes).toBe(90);
  });
});
