import type { FlywheelConfig } from "./schema.js";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] };

type ConfigOverrides = DeepPartial<FlywheelConfig>;

type EnvSetter = (val: string, config: ConfigOverrides) => void;

function parseBool(val: string): boolean { return val === "true" || val === "1"; }
function parseIntSafe(val: string): number | undefined { const n = parseInt(val, 10); return isNaN(n) ? undefined : n; }
function ensure<K extends keyof ConfigOverrides>(config: ConfigOverrides, key: K): NonNullable<ConfigOverrides[K]> {
  if (!config[key]) (config as Record<string, unknown>)[key] = {};
  return config[key] as NonNullable<ConfigOverrides[K]>;
}

const ENV_MAP: Record<string, EnvSetter> = {
  FLYWHEEL_ENGINE: (val, c) => { c.engine = val },
  FLYWHEEL_MODEL: (val, c) => { c.model = val },
  FLYWHEEL_SHOW_THINKING: (val, c) => { c.show_thinking = parseBool(val) },
  FLYWHEEL_SUBPROCESS_MODEL: (val, c) => { ensure(c, "subprocess").model = val },
  FLYWHEEL_DISPATCHER_MODEL: (val, c) => { ensure(c, "dispatcher").model = val },
  FLYWHEEL_TIMEOUT_MINUTES: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) c.timeout_minutes = n },
  FLYWHEEL_PROJECT_CWD: (val, c) => { c.project_cwd = val },
  FLYWHEEL_SKIP_EVALUATION: (val, c) => { c.skip_evaluation = parseBool(val) },
  FLYWHEEL_MAX_EVAL_CYCLES: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) c.max_eval_cycles = n },
  FLYWHEEL_MAX_REVISIONS: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) c.max_revisions = n },
  FLYWHEEL_BUDGET_MAX_INVOCATIONS: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) ensure(c, "budget").max_invocations = n },
  FLYWHEEL_BUDGET_MAX_TOKENS: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) ensure(c, "budget").max_tokens = n },
  FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) ensure(c, "budget").max_wall_clock_minutes = n },
  FLYWHEEL_QUEUE_MAX_STEPS: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) ensure(c, "queue").max_steps = n },
  FLYWHEEL_QUEUE_PERSIST_QUEUE: (val, c) => { ensure(c, "queue").persist_queue = parseBool(val) },
  FLYWHEEL_SPRINT_MAX_ITERATIONS: (val, c) => { const n = parseIntSafe(val); if (n !== undefined) ensure(c, "sprint").max_iterations = n },
  FLYWHEEL_SPRINT_DETECT_STUCK: (val, c) => { ensure(c, "sprint").detect_stuck = parseBool(val) },
};

export function applyEnvOverrides(env: Record<string, string | undefined>): ConfigOverrides {
  const overrides = {};
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      setter(val, overrides);
    }
  }
  return overrides;
}
