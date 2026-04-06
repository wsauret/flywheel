// ---------------------------------------------------------------------------
// Environment variable overrides for FlywheelConfig
// ---------------------------------------------------------------------------

/**
 * Map of environment variable names to setter functions that apply the
 * override onto a mutable config record. Each setter handles its own
 * type coercion (string → number, boolean, array, etc.).
 */
const ENV_MAP: Record<string, (val: string, config: Record<string, unknown>) => void> = {
  FLYWHEEL_ENGINE: (val, config) => {
    config.engine = val;
  },
  FLYWHEEL_MODEL: (val, config) => {
    config.model = val;
  },
  FLYWHEEL_SUBPROCESS_MODEL: (val, config) => {
    if (!config.subprocess) config.subprocess = {};
    (config.subprocess as Record<string, unknown>).model = val;
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
      (config.budget as Record<string, unknown>).max_invocations = n;
    }
  },
  FLYWHEEL_BUDGET_MAX_TOKENS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.budget) config.budget = {};
      (config.budget as Record<string, unknown>).max_tokens = n;
    }
  },
  FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.budget) config.budget = {};
      (config.budget as Record<string, unknown>).max_wall_clock_minutes = n;
    }
  },
  FLYWHEEL_WORKTREE_ENABLED: (val, config) => {
    if (!config.worktree) config.worktree = {};
    (config.worktree as Record<string, unknown>).enabled = val === "true" || val === "1";
  },
  FLYWHEEL_WORKTREE_AUTO_REMOVE: (val, config) => {
    if (!config.worktree) config.worktree = {};
    (config.worktree as Record<string, unknown>).auto_remove = val === "true" || val === "1";
  },
  FLYWHEEL_SKIP_SCRUTINY: (val, config) => {
    config.skip_scrutiny = val === "true" || val === "1";
  },
  FLYWHEEL_SKIP_VALIDATION: (val, config) => {
    config.skip_validation = val === "true" || val === "1";
  },
  FLYWHEEL_QUEUE_MAX_STEPS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.queue) config.queue = {};
      (config.queue as Record<string, unknown>).max_steps = n;
    }
  },
  FLYWHEEL_QUEUE_PERSIST_QUEUE: (val, config) => {
    if (!config.queue) config.queue = {};
    (config.queue as Record<string, unknown>).persist_queue = val === "true" || val === "1";
  },
  FLYWHEEL_SPRINT_MAX_ITERATIONS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.sprint) config.sprint = {};
      (config.sprint as Record<string, unknown>).max_iterations = n;
    }
  },
  FLYWHEEL_SPRINT_VERIFICATION_TIMEOUT_MS: (val, config) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (!config.sprint) config.sprint = {};
      (config.sprint as Record<string, unknown>).verification_timeout_ms = n;
    }
  },
  FLYWHEEL_SPRINT_ESCALATE_TO_FULL: (val, config) => {
    if (!config.sprint) config.sprint = {};
    (config.sprint as Record<string, unknown>).escalate_to_full = val === "true" || val === "1";
  },
  FLYWHEEL_SPRINT_SUBPROCESS_CAN_ESCALATE: (val, config) => {
    if (!config.sprint) config.sprint = {};
    (config.sprint as Record<string, unknown>).subprocess_can_escalate = val === "true" || val === "1";
  },
  FLYWHEEL_SPRINT_ESCALATE_ON_STUCK: (val, config) => {
    if (!config.sprint) config.sprint = {};
    (config.sprint as Record<string, unknown>).escalate_on_stuck = val === "true" || val === "1";
  },
};

/**
 * Build an env-override object from the current environment.
 * Returns a partial config record with only the keys that were set via env vars.
 */
export function applyEnvOverrides(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const val = env[envKey];
    if (val !== undefined && val !== "") {
      setter(val, overrides);
    }
  }
  return overrides;
}
