import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { errorMessage } from "../../infra/error-message.js";
import { FlywheelConfigSchema, type FlywheelConfig } from "./schema.js";
import { applyEnvOverrides } from "./env.js";

type ConfigErrorCode = "FILE_NOT_FOUND" | "FILE_READ_ERROR" | "PARSE_ERROR" | "VALIDATION";

// Exported for instanceof checks in tests — verifies error classification in config loading.
export class ConfigLoadError extends Error {
  readonly code: ConfigErrorCode;

  constructor(message: string, code: ConfigErrorCode) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
  }
}

interface LoadResult {
  config: FlywheelConfig;
  warnings: string[];
}

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
  raw = deepMerge(raw, envOverrides as Record<string, unknown>);

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
  if (config.max_eval_cycles === 1) {
    warnings.push(
      "WARNING: max_eval_cycles is 1. The evaluator will not retry on failure. " +
        "This means steps that fail evaluation will not be re-attempted.",
    );
  }

  return { config, warnings };
}

function loadTomlFile(filePath: string): Record<string, unknown> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new ConfigLoadError(`Config file not found: ${absPath}`, "FILE_NOT_FOUND");
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    throw new ConfigLoadError(
      `Cannot read config file: ${absPath} (${errorMessage(err)})`,
      "FILE_READ_ERROR",
    );
  }

  try {
    return Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(
      `Failed to parse config file: ${absPath} (${errorMessage(err)})`,
      "PARSE_ERROR",
    );
  }
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
