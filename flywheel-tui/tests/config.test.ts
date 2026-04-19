import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { loadConfig } from "../src/orchestration/config/loader";
import {
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
  resolveTierConfigs,
} from "../src/orchestration/config/schema";
import { TIER_TABLE } from "../src/orchestration/config/model-tiers.js";

const A = TIER_TABLE.anthropic;
const O = TIER_TABLE.openai;

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
      expect(result.data.timeout_minutes).toBe(60);
    }
  });

  it("worker schema accepts effort field", () => {
    const result = FlywheelConfigSchema.safeParse({
      worker: { model: "sonnet", effort: "high" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worker.effort).toBe("high");
    }
  });

  it("worker schema rejects invalid effort values", () => {
    const result = FlywheelConfigSchema.safeParse({
      worker: { effort: "turbo" },
    });
    expect(result.success).toBe(false);
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
    expect(config.timeout_minutes).toBe(90);
  });

  it("uses defaults when no config file provided", () => {
    const { config } = loadConfig(undefined, {});

    expect(config.engine).toBe(CONFIG_DEFAULTS.engine);
    expect(config.model).toBeUndefined();
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
      },
    );

    // Env overrides
    expect(config.engine).toBe("opencode");

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
  });

  it("config file overrides defaults", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );

    // From config file (overriding defaults)
    expect(config.timeout_minutes).toBe(90);
  });

  it("handles FLYWHEEL_PROJECT_CWD", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_PROJECT_CWD: "/custom/path",
    });
    expect(config.project_cwd).toBe("/custom/path");
  });
});

// ---------------------------------------------------------------------------
// Config loader: validation errors
// ---------------------------------------------------------------------------

describe("loadConfig: validation errors", () => {
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
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe("worker-override");
    expect(tiers.dispatcher.model).toBe("base-model");
  });

  it("FLYWHEEL_DISPATCHER_MODEL overrides dispatcher model only", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "base-model",
      FLYWHEEL_DISPATCHER_MODEL: "dispatcher-override",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.dispatcher.model).toBe("dispatcher-override");
    expect(tiers.worker.model).toBe("base-model");
  });

  it("FLYWHEEL_MODEL sets both dispatcher and worker model (convenience)", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "shared-model",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.dispatcher.model).toBe("shared-model");
    expect(tiers.worker.model).toBe("shared-model");
  });

  it("precedence: specific > general > config file > defaults", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {
        FLYWHEEL_MODEL: "general-env-model",
        FLYWHEEL_WORKER_MODEL: "specific-worker-model",
      },
    );
    const tiers = resolveTierConfigs(config);

    // Subprocess: specific env (FLYWHEEL_WORKER_MODEL) wins
    expect(tiers.worker.model).toBe("specific-worker-model");
    // Dispatcher: general env (FLYWHEEL_MODEL) wins over config file
    expect(tiers.dispatcher.model).toBe("general-env-model");
  });

  it("resolveTierConfigs applies component defaults when no model is set", () => {
    const { config } = loadConfig(undefined, {});
    const tiers = resolveTierConfigs(config);
    // worker defaults to "powerful" tier, dispatcher/evaluator to "mid"
    expect(tiers.worker.model).toBe(A.powerful);
    expect(tiers.dispatcher.model).toBe(A.mid);
    expect(tiers.evaluator.model).toBe(A.mid);
  });

  it("config file model serves as convenience fallback via resolveTierConfigs", () => {
    const { config } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );
    const tiers = resolveTierConfigs(config);
    // flywheel.toml has model = "claude-sonnet-4-20250514"
    expect(tiers.dispatcher.model).toBe("claude-sonnet-4-20250514");
    expect(tiers.worker.model).toBe("claude-sonnet-4-20250514");
  });
});

// ---------------------------------------------------------------------------
// preferred_vendor config field
// ---------------------------------------------------------------------------

describe("preferred_vendor config field", () => {
  it("parses 'anthropic' correctly", () => {
    const result = FlywheelConfigSchema.safeParse({ preferred_vendor: "anthropic" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferred_vendor).toBe("anthropic");
    }
  });

  it("parses 'openai' correctly", () => {
    const result = FlywheelConfigSchema.safeParse({ preferred_vendor: "openai" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferred_vendor).toBe("openai");
    }
  });

  it("defaults to 'anthropic' when omitted", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferred_vendor).toBe("anthropic");
    }
  });

  it("rejects invalid vendor string", () => {
    const result = FlywheelConfigSchema.safeParse({ preferred_vendor: "google" });
    expect(result.success).toBe(false);
  });

  it("FLYWHEEL_PREFERRED_VENDOR env var overrides config value", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_PREFERRED_VENDOR: "openai",
    });
    expect(config.preferred_vendor).toBe("openai");
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
// Sprint max-effort enforcement
// ---------------------------------------------------------------------------

describe("resolveMaxEffort (via resolveTierConfigs in sprint mode)", () => {
  it("returns 'max' for opus model", () => {
    const config = FlywheelConfigSchema.parse({ model: "opus" });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.worker.effort).toBe("max");
  });

  it("returns 'high' for sonnet model", () => {
    const config = FlywheelConfigSchema.parse({ model: "sonnet" });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.worker.effort).toBe("high");
  });

  it("is case-insensitive (OPUS)", () => {
    const config = FlywheelConfigSchema.parse({ model: "OPUS" });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.worker.effort).toBe("max");
  });
});

describe("resolveTierConfigs with sprint mode", () => {
  it("sprint mode: opus model defaults all tiers to max effort", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "opus",
    });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.dispatcher.effort).toBe("max");
    expect(tiers.worker.effort).toBe("max");
    expect(tiers.evaluator.effort).toBe("max");
  });

  it("sprint mode: sonnet model defaults all tiers to high effort", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MODEL: "sonnet",
    });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.dispatcher.effort).toBe("high");
    expect(tiers.worker.effort).toBe("high");
    expect(tiers.evaluator.effort).toBe("high");
  });

  it("sprint tier config overrides global tier config", () => {
    const config = FlywheelConfigSchema.parse({
      model: "sonnet",
      sprint: {
        worker: { model: "opus", effort: "max" },
        evaluator: { model: "opus", effort: "max" },
      },
    });
    const tiers = resolveTierConfigs(config, "sprint");
    // Worker and evaluator overridden by sprint config (tier names resolved)
    expect(tiers.worker.model).toBe(A.powerful);
    expect(tiers.worker.effort).toBe("max");
    expect(tiers.evaluator.model).toBe(A.powerful);
    expect(tiers.evaluator.effort).toBe("max");
    // Dispatcher falls back to global model + model-aware max
    expect(tiers.dispatcher.model).toBe(A.mid);
    expect(tiers.dispatcher.effort).toBe("high");
  });

  it("clamps max effort to high for non-opus models", () => {
    const config = FlywheelConfigSchema.parse({
      model: "sonnet",
      sprint: {
        worker: { effort: "max" }, // invalid: sonnet can't do max
      },
    });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.worker.effort).toBe("high"); // clamped
  });

  it("non-sprint mode ignores sprint tier config", () => {
    const config = FlywheelConfigSchema.parse({
      model: "sonnet",
      sprint: {
        worker: { model: "opus", effort: "max" },
      },
    });
    const tiers = resolveTierConfigs(config); // no mode
    expect(tiers.worker.model).toBe(A.mid); // resolved from "sonnet", not opus
    expect(tiers.worker.effort).toBeUndefined(); // worker default
  });

  it("explicit tier effort takes precedence over sprint default", () => {
    const config = FlywheelConfigSchema.parse({
      model: "opus",
      evaluator: { effort: "medium" },
    });
    const tiers = resolveTierConfigs(config, "sprint");
    // No sprint.evaluator override, so tier effort "medium" wins over sprint default
    expect(tiers.evaluator.effort).toBe("medium");
  });

  it("top-level effort propagates to all tiers as fallback", () => {
    const config = FlywheelConfigSchema.parse({
      model: "opus",
      effort: "max",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.dispatcher.effort).toBe("max");
    expect(tiers.worker.effort).toBe("max");
    expect(tiers.evaluator.effort).toBe("max");
  });

  it("tier-specific effort overrides top-level effort", () => {
    const config = FlywheelConfigSchema.parse({
      effort: "max",
      model: "opus",
      dispatcher: { effort: "low" },
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.dispatcher.effort).toBe("low");
    expect(tiers.worker.effort).toBe("max");
    expect(tiers.evaluator.effort).toBe("max");
  });

  it("top-level effort is clamped for non-opus models", () => {
    const config = FlywheelConfigSchema.parse({
      model: "sonnet",
      effort: "max",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.dispatcher.effort).toBe("high");
    expect(tiers.worker.effort).toBe("high");
    expect(tiers.evaluator.effort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// resolveTierConfigs with model tier names + preferred_vendor
// ---------------------------------------------------------------------------

describe("resolveTierConfigs with model tier names", () => {
  it("'powerful' + anthropic resolves to opus", () => {
    const config = FlywheelConfigSchema.parse({
      model: "powerful",
      preferred_vendor: "anthropic",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe(A.powerful);
    expect(tiers.dispatcher.model).toBe(A.powerful);
    expect(tiers.evaluator.model).toBe(A.powerful);
  });

  it("'powerful' + openai resolves via tier table (non-claude engine)", () => {
    const config = FlywheelConfigSchema.parse({
      engine: "harness",
      model: "powerful",
      preferred_vendor: "openai",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe(O.powerful);
    expect(tiers.dispatcher.model).toBe(O.powerful);
    expect(tiers.evaluator.model).toBe(O.powerful);
  });

  it("per-tier tier names resolve independently", () => {
    const config = FlywheelConfigSchema.parse({
      model: "powerful",
      worker: { model: "cheap" },
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe(A.cheap);
    expect(tiers.dispatcher.model).toBe(A.powerful);
    expect(tiers.evaluator.model).toBe(A.powerful);
  });

  it("sprint mode works with tier names", () => {
    const config = FlywheelConfigSchema.parse({
      model: "mid",
      sprint: {
        worker: { model: "powerful" },
      },
    });
    const tiers = resolveTierConfigs(config, "sprint");
    expect(tiers.worker.model).toBe(A.powerful);
    expect(tiers.dispatcher.model).toBe(A.mid);
  });

  it("resolveMaxEffort returns 'max' when 'powerful' resolves to opus", () => {
    const config = FlywheelConfigSchema.parse({ model: "powerful" });
    const tiers = resolveTierConfigs(config, "sprint");
    // "powerful" resolves to an opus model -> max
    expect(tiers.worker.effort).toBe("max");
  });

  it("resolveMaxEffort returns 'high' when preferred_vendor is openai (non-claude engine)", () => {
    const config = FlywheelConfigSchema.parse({
      engine: "harness",
      model: "powerful",
      preferred_vendor: "openai",
    });
    const tiers = resolveTierConfigs(config, "sprint");
    // "powerful" + openai resolves to a non-opus model -> high
    expect(tiers.worker.effort).toBe("high");
  });

  it("component defaults apply when no model specified", () => {
    const config = FlywheelConfigSchema.parse({});
    const tiers = resolveTierConfigs(config);
    // worker -> powerful tier
    expect(tiers.worker.model).toBe(A.powerful);
    // evaluator -> mid -> claude-sonnet-4-6
    expect(tiers.evaluator.model).toBe(A.mid);
    // dispatcher -> mid -> claude-sonnet-4-6
    expect(tiers.dispatcher.model).toBe(A.mid);
  });

  it("legacy alias 'opus' resolves correctly through resolveTierConfigs", () => {
    const config = FlywheelConfigSchema.parse({ model: "opus" });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe(A.powerful);
    expect(tiers.dispatcher.model).toBe(A.powerful);
  });

  it("claude engine forces anthropic vendor regardless of preferred_vendor", () => {
    const config = FlywheelConfigSchema.parse({
      engine: "claude",
      preferred_vendor: "openai",
      model: "powerful",
    });
    const tiers = resolveTierConfigs(config);
    // claude engine forces anthropic -> powerful tier
    expect(tiers.worker.model).toBe(A.powerful);
  });

  it("non-claude engine uses preferred_vendor", () => {
    const config = FlywheelConfigSchema.parse({
      engine: "harness",
      preferred_vendor: "openai",
      model: "powerful",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe(O.powerful);
  });

  it("concrete model strings pass through unchanged", () => {
    const config = FlywheelConfigSchema.parse({
      model: "claude-sonnet-4-20250514",
    });
    const tiers = resolveTierConfigs(config);
    expect(tiers.worker.model).toBe("claude-sonnet-4-20250514");
    expect(tiers.dispatcher.model).toBe("claude-sonnet-4-20250514");
  });
});
