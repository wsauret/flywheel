import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import {
  loadConfig,
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
  resolveModels,
} from "../src/orchestration/config/loader";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

// ---------------------------------------------------------------------------
// 2.5 Config loader tests
// ---------------------------------------------------------------------------

describe("FlywheelConfigSchema", () => {
  it("applies defaults when no values provided", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.engine).toBe("claude");
      expect(result.data.model).toBeUndefined();
      expect(result.data.dispatcher).toEqual({});
      expect(result.data.worker).toEqual({});
      expect(result.data.max_retries).toBe(3);
      expect(result.data.timeout_minutes).toBe(60);
      expect(result.data.skip_approval_gates).toBe(false);
    }
  });

  it("rejects max_retries > 10", () => {
    const result = FlywheelConfigSchema.safeParse({
      max_retries: 11,
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_retries < 0", () => {
    const result = FlywheelConfigSchema.safeParse({
      max_retries: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts max_retries: 0", () => {
    const result = FlywheelConfigSchema.safeParse({
      max_retries: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects timeout_minutes > 120", () => {
    const result = FlywheelConfigSchema.safeParse({
      timeout_minutes: 121,
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_minutes < 1", () => {
    const result = FlywheelConfigSchema.safeParse({
      timeout_minutes: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters in project_cwd", () => {
    const result = FlywheelConfigSchema.safeParse({
      project_cwd: "/path; rm -rf /",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config loader: file loading
// ---------------------------------------------------------------------------

describe("loadConfig: file loading", () => {
  it("loads from TOML file", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );

    expect(config.engine).toBe("claude");
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.max_retries).toBe(5);
    expect(config.timeout_minutes).toBe(90);
    expect(config.skip_approval_gates).toBe(false);
  });

  it("uses defaults when no config file provided", () => {
    const { config } = loadConfig(undefined, {});

    expect(config.engine).toBe(CONFIG_DEFAULTS.engine);
    expect(config.model).toBeUndefined();
    expect(config.max_retries).toBe(CONFIG_DEFAULTS.max_retries);
    expect(config.timeout_minutes).toBe(CONFIG_DEFAULTS.timeout_minutes);
  });

  it("throws on non-existent config file", () => {
    expect(() => {
      loadConfig("/nonexistent/flywheel.toml", {});
    }).toThrow(/Config file not found/);
  });
});

// ---------------------------------------------------------------------------
// Config loader: env > config > defaults precedence
// ---------------------------------------------------------------------------

describe("loadConfig: precedence (env > config > defaults)", () => {
  it("env overrides config file values", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {
        FLYWHEEL_ENGINE: "opencode",
        FLYWHEEL_MAX_RETRIES: "7",
      },
    );

    // Env overrides
    expect(config.engine).toBe("opencode");
    expect(config.max_retries).toBe(7);

    // Config file values preserved where not overridden
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.timeout_minutes).toBe(90);
  });

  it("env overrides defaults when no config file", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "env-model",
      FLYWHEEL_TIMEOUT_MINUTES: "45",
    });

    expect(config.model).toBe("env-model");
    expect(config.timeout_minutes).toBe(45);

    // Defaults where not overridden
    expect(config.engine).toBe("claude");
    expect(config.max_retries).toBe(3);
  });

  it("config file overrides defaults", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );

    // From config file (overriding defaults)
    expect(config.max_retries).toBe(5);
    expect(config.timeout_minutes).toBe(90);
  });

  it("handles FLYWHEEL_SKIP_APPROVAL_GATES=true", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SKIP_APPROVAL_GATES: "true",
    });
    expect(config.skip_approval_gates).toBe(true);
  });

  it("handles FLYWHEEL_SKIP_APPROVAL_GATES=1", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SKIP_APPROVAL_GATES: "1",
    });
    expect(config.skip_approval_gates).toBe(true);
  });

  it("handles FLYWHEEL_PROJECT_CWD", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_PROJECT_CWD: "/custom/path",
    });
    expect(config.project_cwd).toBe("/custom/path");
  });
});

// ---------------------------------------------------------------------------
// Config loader: warnings
// ---------------------------------------------------------------------------

describe("loadConfig: warnings", () => {
  it("emits warning when max_retries is 0", () => {
    const { warnings } = loadConfig(
      path.join(FIXTURES_DIR, "zero-retries.toml"),
      {},
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("max_retries is 0");
  });

  it("no warning when max_retries > 0", () => {
    const { warnings } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );

    expect(warnings).toHaveLength(0);
  });

  it("emits warning when max_retries is 0 via env", () => {
    const { warnings } = loadConfig(undefined, {
      FLYWHEEL_MAX_RETRIES: "0",
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("max_retries is 0");
  });
});

// ---------------------------------------------------------------------------
// Config loader: validation errors
// ---------------------------------------------------------------------------

describe("loadConfig: validation errors", () => {
  it("throws on out-of-range max_retries via env", () => {
    expect(() => {
      loadConfig(undefined, {
        FLYWHEEL_MAX_RETRIES: "11",
      });
    }).toThrow(/Invalid configuration/);
  });

  it("throws on out-of-range timeout_minutes via env", () => {
    expect(() => {
      loadConfig(undefined, {
        FLYWHEEL_TIMEOUT_MINUTES: "200",
      });
    }).toThrow(/Invalid configuration/);
  });
});

// ---------------------------------------------------------------------------
// Per-tier model config
// ---------------------------------------------------------------------------

describe("Per-tier model config", () => {
  it("dispatcher.model and worker.model are separate fields", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_DISPATCHER_MODEL: "dispatcher-model",
      FLYWHEEL_WORKER_MODEL: "worker-model",
    });
    expect(config.dispatcher.model).toBe("dispatcher-model");
    expect(config.worker.model).toBe("worker-model");
  });

  it("FLYWHEEL_ENGINE sets engine for both tiers", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_ENGINE: "opencode",
    });
    expect(config.engine).toBe("opencode");
  });

  it("FLYWHEEL_WORKER_MODEL overrides worker model only", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "base-model",
      FLYWHEEL_WORKER_MODEL: "worker-override",
    });
    const models = resolveModels(config);
    expect(models.workerModel).toBe("worker-override");
    expect(models.dispatcherModel).toBe("base-model");
  });

  it("FLYWHEEL_DISPATCHER_MODEL overrides dispatcher model only", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "base-model",
      FLYWHEEL_DISPATCHER_MODEL: "dispatcher-override",
    });
    const models = resolveModels(config);
    expect(models.dispatcherModel).toBe("dispatcher-override");
    expect(models.workerModel).toBe("base-model");
  });

  it("FLYWHEEL_MODEL sets both dispatcher and worker model (convenience)", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "shared-model",
    });
    const models = resolveModels(config);
    expect(models.dispatcherModel).toBe("shared-model");
    expect(models.workerModel).toBe("shared-model");
  });

  it("precedence: specific > general > config file > defaults", () => {
    // Config file sets model = "claude-sonnet-4-20250514"
    // FLYWHEEL_MODEL overrides that for both tiers
    // FLYWHEEL_WORKER_MODEL overrides worker specifically
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {
        FLYWHEEL_MODEL: "general-env-model",
        FLYWHEEL_WORKER_MODEL: "specific-worker-model",
      },
    );
    const models = resolveModels(config);

    // Worker: specific env (FLYWHEEL_WORKER_MODEL) wins
    expect(models.workerModel).toBe("specific-worker-model");
    // Dispatcher: general env (FLYWHEEL_MODEL) wins over config file
    expect(models.dispatcherModel).toBe("general-env-model");
  });

  it("resolveModels returns undefined when no model is set", () => {
    const { config } = loadConfig(undefined, {});
    const models = resolveModels(config);
    expect(models.dispatcherModel).toBeUndefined();
    expect(models.workerModel).toBeUndefined();
  });

  it("config file model serves as convenience fallback via resolveModels", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );
    const models = resolveModels(config);
    // flywheel.toml has model = "claude-sonnet-4-20250514"
    expect(models.dispatcherModel).toBe("claude-sonnet-4-20250514");
    expect(models.workerModel).toBe("claude-sonnet-4-20250514");
  });
});

// ---------------------------------------------------------------------------
// Pipeline config fields (Step 4)
// ---------------------------------------------------------------------------

describe("Pipeline config fields", () => {
  it("interactive_consolidation defaults to false", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interactive_consolidation).toBe(false);
    }
  });

  it("auto_ship defaults to false", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auto_ship).toBe(false);
    }
  });

  it("auto_chain defaults to true", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auto_chain).toBe(true);
    }
  });

  it("CONFIG_DEFAULTS includes pipeline fields", () => {
    expect(CONFIG_DEFAULTS.interactive_consolidation).toBe(false);
    expect(CONFIG_DEFAULTS.auto_ship).toBe(false);
    expect(CONFIG_DEFAULTS.auto_chain).toBe(true);
  });

  it("env var FLYWHEEL_INTERACTIVE_CONSOLIDATION overrides config", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_INTERACTIVE_CONSOLIDATION: "true",
    });
    expect(config.interactive_consolidation).toBe(true);
  });

  it("env var FLYWHEEL_AUTO_SHIP overrides config", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_AUTO_SHIP: "1",
    });
    expect(config.auto_ship).toBe(true);
  });

  it("env var FLYWHEEL_AUTO_CHAIN can disable chaining", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_AUTO_CHAIN: "false",
    });
    expect(config.auto_chain).toBe(false);
  });

  it("env var FLYWHEEL_AUTO_CHAIN=0 disables chaining", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_AUTO_CHAIN: "0",
    });
    expect(config.auto_chain).toBe(false);
  });

  it("env var FLYWHEEL_AUTO_CHAIN=true enables chaining", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_AUTO_CHAIN: "true",
    });
    expect(config.auto_chain).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget and Eval Config Fields (Step 1)
// ---------------------------------------------------------------------------

describe("max_eval_cycles config field", () => {
  it("defaults to 3", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_eval_cycles).toBe(3);
    }
  });

  it("accepts values 1-10", () => {
    for (const val of [1, 2, 5, 10]) {
      const result = FlywheelConfigSchema.safeParse({ max_eval_cycles: val });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.max_eval_cycles).toBe(val);
      }
    }
  });

  it("rejects max_eval_cycles < 1", () => {
    const result = FlywheelConfigSchema.safeParse({ max_eval_cycles: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects max_eval_cycles > 10", () => {
    const result = FlywheelConfigSchema.safeParse({ max_eval_cycles: 11 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer max_eval_cycles", () => {
    const result = FlywheelConfigSchema.safeParse({ max_eval_cycles: 2.5 });
    expect(result.success).toBe(false);
  });

  it("env var FLYWHEEL_MAX_EVAL_CYCLES overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MAX_EVAL_CYCLES: "5",
    });
    expect(config.max_eval_cycles).toBe(5);
  });

  it("emits warning when max_eval_cycles is 1", () => {
    const { warnings } = loadConfig(undefined, {
      FLYWHEEL_MAX_EVAL_CYCLES: "1",
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("max_eval_cycles is 1"))).toBe(true);
  });

  it("no warning when max_eval_cycles > 1", () => {
    const { warnings } = loadConfig(undefined, {
      FLYWHEEL_MAX_EVAL_CYCLES: "5",
    });
    expect(warnings.every((w) => !w.includes("max_eval_cycles"))).toBe(true);
  });

  it("CONFIG_DEFAULTS includes max_eval_cycles", () => {
    expect(CONFIG_DEFAULTS.max_eval_cycles).toBe(3);
  });
});

describe("fallback_agents config field", () => {
  it("defaults to empty array", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallback_agents).toEqual([]);
    }
  });

  it("accepts array of strings", () => {
    const result = FlywheelConfigSchema.safeParse({
      fallback_agents: ["claude", "opencode"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fallback_agents).toEqual(["claude", "opencode"]);
    }
  });

  it("env var FLYWHEEL_FALLBACK_AGENTS sets comma-separated values", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_FALLBACK_AGENTS: "claude,opencode",
    });
    expect(config.fallback_agents).toEqual(["claude", "opencode"]);
  });

  it("env var FLYWHEEL_FALLBACK_AGENTS handles whitespace around commas", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_FALLBACK_AGENTS: "claude , opencode , gemini",
    });
    expect(config.fallback_agents).toEqual(["claude", "opencode", "gemini"]);
  });

  it("env var FLYWHEEL_FALLBACK_AGENTS handles trailing comma", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_FALLBACK_AGENTS: "claude,opencode,",
    });
    expect(config.fallback_agents).toEqual(["claude", "opencode"]);
  });

  it("env var FLYWHEEL_FALLBACK_AGENTS handles empty string", () => {
    // Empty string should not trigger the env override (it's filtered out)
    const { config } = loadConfig(undefined, {
      FLYWHEEL_FALLBACK_AGENTS: "",
    });
    expect(config.fallback_agents).toEqual([]);
  });

  it("env var FLYWHEEL_FALLBACK_AGENTS handles single value", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_FALLBACK_AGENTS: "claude",
    });
    expect(config.fallback_agents).toEqual(["claude"]);
  });

  it("CONFIG_DEFAULTS includes fallback_agents", () => {
    expect(CONFIG_DEFAULTS.fallback_agents).toEqual([]);
  });
});

describe("budget config section", () => {
  it("defaults to all zeros (unlimited)", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget).toEqual({
        max_invocations: 0,
        max_tokens: 0,
        max_wall_clock_minutes: 0,
      });
    }
  });

  it("accepts valid budget values", () => {
    const result = FlywheelConfigSchema.safeParse({
      budget: {
        max_invocations: 100,
        max_tokens: 500_000,
        max_wall_clock_minutes: 30,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget.max_invocations).toBe(100);
      expect(result.data.budget.max_tokens).toBe(500_000);
      expect(result.data.budget.max_wall_clock_minutes).toBe(30);
    }
  });

  it("rejects negative budget values", () => {
    const result = FlywheelConfigSchema.safeParse({
      budget: { max_invocations: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer budget values", () => {
    const result = FlywheelConfigSchema.safeParse({
      budget: { max_tokens: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it("allows partial budget (missing fields get defaults)", () => {
    const result = FlywheelConfigSchema.safeParse({
      budget: { max_invocations: 50 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget.max_invocations).toBe(50);
      expect(result.data.budget.max_tokens).toBe(0);
      expect(result.data.budget.max_wall_clock_minutes).toBe(0);
    }
  });

  it("env var FLYWHEEL_BUDGET_MAX_INVOCATIONS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_BUDGET_MAX_INVOCATIONS: "200",
    });
    expect(config.budget.max_invocations).toBe(200);
  });

  it("env var FLYWHEEL_BUDGET_MAX_TOKENS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_BUDGET_MAX_TOKENS: "1000000",
    });
    expect(config.budget.max_tokens).toBe(1_000_000);
  });

  it("env var FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: "45",
    });
    expect(config.budget.max_wall_clock_minutes).toBe(45);
  });

  it("CONFIG_DEFAULTS includes budget section", () => {
    expect(CONFIG_DEFAULTS.budget).toEqual({
      max_invocations: 0,
      max_tokens: 0,
      max_wall_clock_minutes: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Skip validation config flags
// ---------------------------------------------------------------------------

describe("skip_scrutiny and skip_validation config flags", () => {
  it("defaults skip_scrutiny to false", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skip_scrutiny).toBe(false);
    }
  });

  it("defaults skip_validation to false", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skip_validation).toBe(false);
    }
  });

  it("accepts skip_scrutiny: true", () => {
    const result = FlywheelConfigSchema.safeParse({ skip_scrutiny: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skip_scrutiny).toBe(true);
    }
  });

  it("accepts skip_validation: true", () => {
    const result = FlywheelConfigSchema.safeParse({ skip_validation: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skip_validation).toBe(true);
    }
  });

  it("both flags are independent", () => {
    const result = FlywheelConfigSchema.safeParse({
      skip_scrutiny: true,
      skip_validation: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skip_scrutiny).toBe(true);
      expect(result.data.skip_validation).toBe(false);
    }
  });

  it("env var FLYWHEEL_SKIP_SCRUTINY overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SKIP_SCRUTINY: "true",
    });
    expect(config.skip_scrutiny).toBe(true);
  });

  it("env var FLYWHEEL_SKIP_VALIDATION overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SKIP_VALIDATION: "true",
    });
    expect(config.skip_validation).toBe(true);
  });

  it("CONFIG_DEFAULTS includes skip flags", () => {
    expect(CONFIG_DEFAULTS.skip_scrutiny).toBe(false);
    expect(CONFIG_DEFAULTS.skip_validation).toBe(false);
  });
});
