import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` },
  );
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Boundaries sub-schema — constraints workers must never violate.
 * Extracted so the type can be shared with prompt builders (e.g. step-prompt.ts).
 */
export const BoundariesSchema = z.object({
  /** Allowed port ranges (e.g. ["3000-3100", "8080-8090"]). */
  port_ranges: z.array(z.string()).optional(),
  /** Directories workers must not modify. */
  off_limits_dirs: z.array(z.string()).optional(),
  /** External services workers should be aware of. */
  external_services: z.array(z.string()).optional(),
});

export type BoundariesConfig = z.infer<typeof BoundariesSchema>;

/**
 * Commands sub-schema — project commands for scrutiny validation.
 * Extracted so the type can be shared with prompt builders (e.g. scrutiny.ts).
 */
export const CommandsSchema = z.object({
  /** Command to run the test suite. */
  test: z.string().optional(),
  /** Command to run typecheck. */
  typecheck: z.string().optional(),
  /** Command to run the linter. */
  lint: z.string().optional(),
});

export type CommandsConfig = z.infer<typeof CommandsSchema>;

// ---------------------------------------------------------------------------
// Main config schema
// ---------------------------------------------------------------------------

/**
 * Full config schema for the TOML loader.
 * Extends the base ConfigSchema with additional fields.
 */
export const FlywheelConfigSchema = z.object({
  /** Engine ID: "claude", "opencode", etc. */
  engine: z.string().default("claude"),
  /** TUI theme name: "opencode", "tokyonight", "dracula", "catppuccin", "nord", "gruvbox". */
  theme: z.string().optional(),
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
  skip_evaluation: z.boolean().default(false),

  /** Present open questions to user during plan consolidation. Default: false (auto-resolve). */
  interactive_consolidation: z.boolean().default(false),
  /** Automatically run ship after review completes. Default: false. */
  auto_ship: z.boolean().default(false),
  /** Chain workflows automatically (plan -> work -> review). Default: true.
   * Decision #1: intentional behavior change — /work now chains to review. */
  auto_chain: z.boolean().default(true),

  /** Max evaluator retry cycles per step. 1 = single attempt (no retries). Default: 3. */
  max_eval_cycles: z.number().int().min(1).max(10).default(3),

  /** Max revision attempts after evaluator failure. 0 = no revisions. Default: 1. */
  max_revisions: z.number().int().min(0).max(5).default(1),

  /** Fallback engine IDs to try when the primary engine fails. Validated at runtime. */
  fallback_agents: z.array(z.string()).default([]),

  /** Budget limits for workflow execution. 0 = unlimited for all fields. */
  budget: z.object({
    /** Max total worker invocations across all steps. 0 = unlimited. */
    max_invocations: z.number().int().min(0).default(0),
    /** Max total tokens consumed. 0 = unlimited. */
    max_tokens: z.number().int().min(0).default(0),
    /** Max wall-clock time in minutes. 0 = unlimited. */
    max_wall_clock_minutes: z.number().int().min(0).default(0),
  }).default({}),

  /** Worktree (Worktrunk) integration configuration. */
  worktree: z.object({
    /** Enable worktree integration. Default: true (requires wt CLI available). */
    enabled: z.boolean().default(true),
    /** Automatically remove worktree when session is archived. */
    auto_remove: z.boolean().default(false),
    /** Grace period (ms) before trashed session worktrees are cleaned up. Default: 300000 (5 min). */
    grace_period_ms: z.number().int().min(0).default(300_000),
  }).default({}),

  /** User-facing output directory overrides. */
  paths: z.object({
    plans: z.string().optional(),
    research: z.string().optional(),
    reviews: z.string().optional(),
    solutions: z.string().optional(),
    standards: z.string().optional(),
  }).default({}),

  /** Mission boundaries — constraints workers must never violate. */
  boundaries: BoundariesSchema.optional(),

  /** Project commands for scrutiny validation (test, typecheck, lint). */
  commands: CommandsSchema.optional(),

  /** Skip scrutiny validation step injection at milestone boundaries. Default: false. */
  skip_scrutiny: z.boolean().default(false),

  /** Skip behavioral validation step injection at milestone boundaries. Default: false. */
  skip_validation: z.boolean().default(false),

  /** Queue execution engine configuration. */
  queue: z.object({
    /** Maximum number of steps allowed in a single queue. Default: 50. */
    max_steps: z.number().int().min(1).max(1000).default(50),
    /** Persist queue state to disk for crash recovery. Default: true. */
    persist_queue: z.boolean().default(true),
  }).default({}),

  /** Dispatcher intelligence configuration. */
  dispatcher_intelligence: z.object({
    /** Enable dispatcher queue mutations. Default: true. */
    enabled: z.boolean().default(true),
    /** Max mutations per step completion. Default: 3. */
    max_mutations_per_step: z.number().int().min(0).max(10).default(3),
    /** Max total steps inserted per session. Default: 20. */
    max_inserted_steps: z.number().int().min(0).max(100).default(20),
    /** Auto-insert fix steps from review findings. Default: true. */
    auto_fix_insertion: z.boolean().default(true),
    /** Separate budget for replan decisions (0 = unlimited). Default: 0. */
    replan_cost_budget_usd: z.number().min(0).default(0),
    /** Recent handoffs in full detail (older summarized). Default: 3. */
    handoff_detail_window: z.number().int().min(1).max(20).default(3),
  }).default({}),

  /** Sprint mode configuration. */
  sprint: z.object({
    /** Max sprint iterations before escalation. Default: 5. */
    max_iterations: z.number().int().min(1).max(10).default(5),
    /** Timeout (ms) for verification script execution. Default: 30000. */
    verification_timeout_ms: z.number().int().min(1000).default(30000),
    /** Escalate to full queue when sprint exhausts iterations. Default: true. */
    escalate_to_full: z.boolean().default(true),
    /** Allow worker to signal escalation via needs_plan. Default: false. */
    worker_can_escalate: z.boolean().default(false),
    /** Escalate early on repeated identical verification failures. Default: false. */
    escalate_on_stuck: z.boolean().default(false),
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
  skip_evaluation: false,
  interactive_consolidation: false,
  auto_ship: false,
  auto_chain: true,
  max_eval_cycles: 3,
  max_revisions: 1,
  fallback_agents: [],
  budget: {
    max_invocations: 0,
    max_tokens: 0,
    max_wall_clock_minutes: 0,
  },
  worktree: {
    enabled: true,
    auto_remove: false,
    grace_period_ms: 300_000,
  },
  paths: {},
  skip_scrutiny: false,
  skip_validation: false,
  queue: {
    max_steps: 50,
    persist_queue: true,
  },
  dispatcher_intelligence: {
    enabled: true,
    max_mutations_per_step: 3,
    max_inserted_steps: 20,
    auto_fix_insertion: true,
    replan_cost_budget_usd: 0,
    handoff_detail_window: 3,
  },
  sprint: {
    max_iterations: 5,
    verification_timeout_ms: 30_000,
    escalate_to_full: true,
    worker_can_escalate: false,
    escalate_on_stuck: false,
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
