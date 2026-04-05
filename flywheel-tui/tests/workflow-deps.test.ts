import { describe, it, expect } from "bun:test";
import { prepareWorkflowDeps } from "../src/orchestration/engines/workflow-deps";
import type { FlywheelConfig } from "../src/orchestration/config/loader";
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
    max_retries: 3,
    timeout_minutes: 60,
    skip_approval_gates: false,
    skip_evaluation: false,
    worktree: { enabled: false, auto_remove: false, grace_period_ms: 300_000 },
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
  const spawnerCalls: number[] = [];

  return {
    loadConfig: opts.failConfig
      ? () => { throw new Error(opts.failConfig); }
      : () => ({ config, warnings: [] }),
    getEngine: opts.failEngine
      ? () => { throw new Error(opts.failEngine); }
      : (id: string) => makeFakeEngine(id),
    createSpawner: (timeout: number) => {
      spawnerCalls.push(timeout);
      return { spawn: async () => ({} as any), _testTimeoutMinutes: timeout } as any;
    },
  };
}

// ---------------------------------------------------------------------------
// prepareWorkflowDeps
// ---------------------------------------------------------------------------

describe("prepareWorkflowDeps", () => {
  it("returns { config, engine, spawner } on success", () => {
    const deps = prepareWorkflowDeps(makeOverrides());

    expect(deps).toBeDefined();
    expect(deps.config).toBeDefined();
    expect(deps.engine).toBeDefined();
    expect(deps.spawner).toBeDefined();
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

  it("creates spawner with correct timeout from config", () => {
    const config = makeConfig({ timeout_minutes: 45 });
    let spawnerTimeout: number | undefined;

    const overrides = makeOverrides({ config });
    overrides.createSpawner = (timeout: number) => {
      spawnerTimeout = timeout;
      return { spawn: async () => ({} as any) } as any;
    };

    prepareWorkflowDeps(overrides);

    expect(spawnerTimeout).toBe(45);
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
    const config = makeConfig({ max_retries: 7, timeout_minutes: 90 });
    const deps = prepareWorkflowDeps(makeOverrides({ config }));

    expect(deps.config.max_retries).toBe(7);
    expect(deps.config.timeout_minutes).toBe(90);
  });
});
