import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../../workflows/shared/error-message";
import { FlywheelConfigSchema, type FlywheelConfig } from "./schema";
import { applyEnvOverrides } from "./env";

// Re-export schema symbols so existing consumers of config/loader keep working.
export {
  FlywheelConfigSchema,
  BoundariesSchema,
  type BoundariesConfig,
  CommandsSchema,
  type CommandsConfig,
  CONFIG_DEFAULTS,
  resolveModels,
  type FlywheelConfig,
} from "./schema";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ConfigErrorCode = "FILE_NOT_FOUND" | "FILE_READ_ERROR" | "PARSE_ERROR" | "VALIDATION";

export class ConfigLoadError extends Error {
  readonly code: ConfigErrorCode;

  constructor(message: string, code: ConfigErrorCode) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
  }
}

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
  const envOverrides = applyEnvOverrides(env);
  raw = deepMerge(raw, envOverrides);

  // Warn about unrecognized top-level keys before Zod strips them
  const knownKeys = new Set(Object.keys(FlywheelConfigSchema.shape));
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      warnings.push(
        `WARNING: Unrecognized config key "${key}". This key will be ignored. ` +
          "Check for typos in your config file.",
      );
    }
  }

  // Validate with Zod (defaults are applied here)
  const result = FlywheelConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigLoadError(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      "VALIDATION",
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

  if (config.max_eval_cycles === 1) {
    warnings.push(
      "WARNING: max_eval_cycles is 1. The evaluator will not retry on failure. " +
        "This means steps that fail evaluation will not be re-attempted.",
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
    throw new ConfigLoadError(`Config file not found: ${absPath}`, "FILE_NOT_FOUND");
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    throw new ConfigLoadError(
      `Cannot read config file: ${absPath} (${errorMessage(err)})`,
      "FILE_READ_ERROR",
    );
  }

  try {
    // Use Bun's built-in TOML parser
    const BunGlobal = globalThis as unknown as { Bun?: { TOML?: { parse(s: string): unknown } } };
    if (BunGlobal.Bun?.TOML) {
      return BunGlobal.Bun.TOML.parse(content) as Record<string, unknown>;
    }

    // Fallback: minimal TOML parser for simple key=value and [section] syntax
    return parseSimpleToml(content);
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(
      `Failed to parse config file: ${absPath} (${errorMessage(err)})`,
      "PARSE_ERROR",
    );
  }
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
