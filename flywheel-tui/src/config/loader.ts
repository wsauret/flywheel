import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` },
  );
}

/**
 * Full config schema for the TOML loader.
 * Extends the base ConfigSchema with additional fields.
 */
export const FlywheelConfigSchema = z.object({
  /** Engine ID: "claude", "opencode", etc. */
  engine: z.string().default("claude"),
  /** Per-tier model config for the dispatcher */
  dispatcher: z.object({
    model: z.string().optional(),
  }).default({}),
  /** Per-tier model config for the worker */
  worker: z.object({
    model: z.string().optional(),
  }).default({}),
  /** Convenience: sets both dispatcher.model and worker.model if not individually overridden */
  model: z.string().optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_minutes: z.number().int().min(1).max(120).default(60),
  project_cwd: noShellMetachars("project_cwd").optional(),
  skip_approval_gates: z.boolean().default(false),
  use_dispatcher: z.boolean().default(true),
  skip_evaluation: z.boolean().default(false),

  /** Present open questions to user during plan consolidation. Default: false (auto-resolve). */
  interactive_consolidation: z.boolean().default(false),
  /** Automatically run ship after review completes. Default: false. */
  auto_ship: z.boolean().default(false),
  /** Chain workflows automatically (plan -> work -> review). Default: true.
   * Decision #1: intentional behavior change — /work now chains to review. */
  auto_chain: z.boolean().default(true),

  /** Worktree (Worktrunk) integration configuration. */
  worktree: z.object({
    /** Enable worktree integration. Default: false (auto-detected from wt CLI). */
    enabled: z.boolean().default(false),
    /** Automatically remove worktree when session is archived. */
    auto_remove: z.boolean().default(false),
    /** Grace period (ms) before trashed session worktrees are cleaned up. Default: 300000 (5 min). */
    grace_period_ms: z.number().int().min(0).default(300_000),
  }).default({}),
});

export type FlywheelConfig = z.infer<typeof FlywheelConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const CONFIG_DEFAULTS: FlywheelConfig = {
  engine: "claude",
  dispatcher: {},
  worker: {},
  max_retries: 3,
  timeout_minutes: 60,
  skip_approval_gates: false,
  use_dispatcher: true,
  skip_evaluation: false,
  interactive_consolidation: false,
  auto_ship: false,
  auto_chain: true,
  worktree: {
    enabled: false,
    auto_remove: false,
    grace_period_ms: 300_000,
  },
};

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the final model for each tier.
 * Precedence: tier-specific (dispatcher.model / worker.model) > convenience (model) > undefined (engine default).
 */
export function resolveModels(config: FlywheelConfig): { dispatcherModel?: string; workerModel?: string } {
  return {
    dispatcherModel: config.dispatcher.model ?? config.model,
    workerModel: config.worker.model ?? config.model,
  };
}

// ---------------------------------------------------------------------------
// Environment variable mapping
// ---------------------------------------------------------------------------

const ENV_MAP: Record<string, (val: string, config: Record<string, unknown>) => void> = {
  FLYWHEEL_ENGINE: (val, config) => {
    config.engine = val;
  },
  FLYWHEEL_MODEL: (val, config) => {
    config.model = val;
  },
  FLYWHEEL_WORKER_MODEL: (val, config) => {
    if (!config.worker) config.worker = {};
    (config.worker as Record<string, unknown>).model = val;
  },
  FLYWHEEL_DISPATCHER_MODEL: (val, config) => {
    if (!config.dispatcher) config.dispatcher = {};
    (config.dispatcher as Record<string, unknown>).model = val;
  },
  FLYWHEEL_MAX_RETRIES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.max_retries = n;
  },
  FLYWHEEL_TIMEOUT_MINUTES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.timeout_minutes = n;
  },
  FLYWHEEL_PROJECT_CWD: (val, config) => {
    config.project_cwd = val;
  },
  FLYWHEEL_SKIP_APPROVAL_GATES: (val, config) => {
    config.skip_approval_gates = val === "true" || val === "1";
  },
  FLYWHEEL_USE_DISPATCHER: (val, config) => {
    config.use_dispatcher = val !== "false" && val !== "0";
  },
  FLYWHEEL_SKIP_EVALUATION: (val, config) => {
    config.skip_evaluation = val === "true" || val === "1";
  },
  FLYWHEEL_INTERACTIVE_CONSOLIDATION: (val, config) => {
    config.interactive_consolidation = val === "true" || val === "1";
  },
  FLYWHEEL_AUTO_SHIP: (val, config) => {
    config.auto_ship = val === "true" || val === "1";
  },
  FLYWHEEL_AUTO_CHAIN: (val, config) => {
    config.auto_chain = val !== "false" && val !== "0";
  },
  FLYWHEEL_WORKTREE_ENABLED: (val, config) => {
    if (!config.worktree) config.worktree = {};
    (config.worktree as Record<string, unknown>).enabled = val === "true" || val === "1";
  },
  FLYWHEEL_WORKTREE_AUTO_REMOVE: (val, config) => {
    if (!config.worktree) config.worktree = {};
    (config.worktree as Record<string, unknown>).auto_remove = val === "true" || val === "1";
  },
};

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export interface LoadResult {
  config: FlywheelConfig;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load configuration with precedence: env > config file > defaults.
 *
 * @param configPath Path to TOML config file (optional)
 * @param env Environment variables (defaults to process.env)
 * @returns Validated config + any warnings
 */
export function loadConfig(
  configPath?: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): LoadResult {
  const warnings: string[] = [];

  // Start with empty object — Zod defaults will fill in
  let raw: Record<string, unknown> = {};

  // Layer 1: Config file
  if (configPath) {
    const fileConfig = loadTomlFile(configPath);
    raw = deepMerge(raw, fileConfig);
  }

  // Layer 2: Environment variables (highest precedence)
  const envOverrides: Record<string, unknown> = {};
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      setter(val, envOverrides);
    }
  }
  raw = deepMerge(raw, envOverrides);

  // Validate with Zod (defaults are applied here)
  const result = FlywheelConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }

  const config = result.data;

  // Emit warnings
  if (config.max_retries === 0) {
    warnings.push(
      "WARNING: max_retries is 0. The worker will not retry on failure. " +
        "This is unusual and may lead to premature failure.",
    );
  }

  return { config, warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadTomlFile(filePath: string): Record<string, unknown> {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Config file not found: ${absPath}`);
  }

  const content = fs.readFileSync(absPath, "utf-8");

  // Use Bun's built-in TOML parser
  const BunGlobal = globalThis as unknown as { Bun?: { TOML?: { parse(s: string): unknown } } };
  if (BunGlobal.Bun?.TOML) {
    return BunGlobal.Bun.TOML.parse(content) as Record<string, unknown>;
  }

  // Fallback: minimal TOML parser for simple key=value and [section] syntax
  return parseSimpleToml(content);
}

/**
 * Minimal TOML parser for flat configs with [section] tables.
 * Only used as fallback when Bun.TOML is unavailable (e.g., testing edge cases).
 */
function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;
  let currentSectionName: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Section header
    const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSectionName = sectionMatch[1];
      if (!result[currentSectionName]) {
        result[currentSectionName] = {};
      }
      currentSection = result[currentSectionName] as Record<string, unknown>;
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawVal] = kvMatch;
      currentSection[key] = parseTomlValue(rawVal.trim());
    }
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // String (quoted)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Integer
  const num = Number(raw);
  if (!isNaN(num) && raw === String(num)) return num;
  // Bare string (shouldn't happen in valid TOML, but handle gracefully)
  return raw;
}

/**
 * Deep merge two objects. Source values override target values.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}
