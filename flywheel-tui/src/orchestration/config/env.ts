// Environment variable overrides for FlywheelConfig

import type { FlywheelConfig } from "./schema.js";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] };

type ConfigOverrides = DeepPartial<FlywheelConfig>;

type EnvSetter = (val: string, config: ConfigOverrides) => void;

const ENV_MAP: Record<string, EnvSetter> = {
  FLYWHEEL_ENGINE: (val, config) => { config.engine = val },
  FLYWHEEL_MODEL: (val, config) => { config.model = val },
  FLYWHEEL_SUBPROCESS_MODEL: (val, config) => {
    if (!config.subprocess) config.subprocess = {};
    config.subprocess.model = val;
  },
  FLYWHEEL_DISPATCHER_MODEL: (val, config) => {
    if (!config.dispatcher) config.dispatcher = {};
    config.dispatcher.model = val;
  },
  FLYWHEEL_MAX_RETRIES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.max_retries = n;
  },
  FLYWHEEL_TIMEOUT_MINUTES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.timeout_minutes = n;
  },
  FLYWHEEL_PROJECT_CWD: (val, config) => { config.project_cwd = val },
  FLYWHEEL_SKIP_EVALUATION: (val, config) => { config.skip_evaluation = val === "true" || val === "1" },
  FLYWHEEL_INTERACTIVE_CONSOLIDATION: (val, config) => { config.interactive_consolidation = val === "true" || val === "1" },
  FLYWHEEL_AUTO_SHIP: (val, config) => { config.auto_ship = val === "true" || val === "1" },
  FLYWHEEL_AUTO_CHAIN: (val, config) => { config.auto_chain = val !== "false" && val !== "0" },
  FLYWHEEL_MAX_EVAL_CYCLES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.max_eval_cycles = n;
  },
  FLYWHEEL_MAX_REVISIONS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) config.max_revisions = n;
  },
  FLYWHEEL_FALLBACK_AGENTS: (val, config) => {
    config.fallback_agents = val.split(",").map((s) => s.trim()).filter(Boolean);
  },
  FLYWHEEL_BUDGET_MAX_INVOCATIONS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.budget) config.budget = {};
      config.budget.max_invocations = n;
    }
  },
  FLYWHEEL_BUDGET_MAX_TOKENS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.budget) config.budget = {};
      config.budget.max_tokens = n;
    }
  },
  FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.budget) config.budget = {};
      config.budget.max_wall_clock_minutes = n;
    }
  },
  FLYWHEEL_SKIP_SCRUTINY: (val, config) => { config.skip_scrutiny = val === "true" || val === "1" },
  FLYWHEEL_SKIP_VALIDATION: (val, config) => { config.skip_validation = val === "true" || val === "1" },
  FLYWHEEL_QUEUE_MAX_STEPS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.queue) config.queue = {};
      config.queue.max_steps = n;
    }
  },
  FLYWHEEL_QUEUE_PERSIST_QUEUE: (val, config) => {
    if (!config.queue) config.queue = {};
    config.queue.persist_queue = val === "true" || val === "1";
  },
  FLYWHEEL_SPRINT_MAX_ITERATIONS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.sprint) config.sprint = {};
      config.sprint.max_iterations = n;
    }
  },
  FLYWHEEL_SPRINT_DETECT_STUCK: (val, config) => {
    if (!config.sprint) config.sprint = {};
    config.sprint.detect_stuck = val === "true" || val === "1";
  },
};

export function applyEnvOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const overrides: ConfigOverrides = {};
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      setter(val, overrides);
    }
  }
  return overrides as Record<string, unknown>;
}
