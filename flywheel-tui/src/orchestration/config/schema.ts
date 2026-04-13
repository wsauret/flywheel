import { z } from "zod";
import { SprintConfigSchema } from "../../workflows/queue/steps/sprint/config-schema.js";

// Helpers

const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` },
  );
}

// Sub-schemas

/**
 * Boundaries sub-schema — constraints subprocesses must never violate.
 * Extracted so the type can be shared with prompt builders (e.g. step-prompt.ts).
 */
const BoundariesSchema = z.object({
  /** Allowed port ranges (e.g. ["3000-3100", "8080-8090"]). */
  port_ranges: z.array(z.string()).optional(),
  /** Directories subprocesses must not modify. */
  off_limits_dirs: z.array(z.string()).optional(),
  /** External services subprocesses should be aware of. */
  external_services: z.array(z.string()).optional(),
});

type BoundariesConfig = z.infer<typeof BoundariesSchema>;

/**
 * Commands sub-schema — project commands for scrutiny validation.
 * Extracted so the type can be shared with prompt builders (e.g. scrutiny.ts).
 */
const CommandsSchema = z.object({
  /** Command to run the test suite. */
  test: z.string().optional(),
  /** Command to run typecheck. */
  typecheck: z.string().optional(),
  /** Command to run the linter. */
  lint: z.string().optional(),
});

type CommandsConfig = z.infer<typeof CommandsSchema>;

// Main config schema

/**
 * Full config schema for the TOML loader.
 * Extends the base ConfigSchema with additional fields.
 */
export const FlywheelConfigSchema = z.object({
  /** Engine ID: "claude", "opencode", etc. */
  engine: z.string().default("claude"),
  /** TUI theme name: "opencode", "tokyonight", "dracula", "catppuccin", "nord", "gruvbox". */
  theme: z.string().optional(),
  /** Per-tier config for the dispatcher */
  dispatcher: z.object({
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
  }).default({}),
  /** Per-tier config for the subprocess */
  subprocess: z.object({
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
  }).default({}),
  /** Per-tier config for the evaluator */
  evaluator: z.object({
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
  }).default({}),
  /** Convenience: sets dispatcher.model, subprocess.model, and evaluator.model if not individually overridden */
  model: z.string().optional(),
  /** Convenience: sets dispatcher.effort, subprocess.effort, and evaluator.effort if not individually overridden */
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_minutes: z.number().int().min(1).max(120).default(60),
  project_cwd: noShellMetachars("project_cwd").optional(),
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
    /** Max total subprocess invocations across all steps. 0 = unlimited. */
    max_invocations: z.number().int().min(0).default(0),
    /** Max total tokens consumed. 0 = unlimited. */
    max_tokens: z.number().int().min(0).default(0),
    /** Max wall-clock time in minutes. 0 = unlimited. */
    max_wall_clock_minutes: z.number().int().min(0).default(0),
  }).default({}),

  /** User-facing output directory overrides. */
  paths: z.object({
    plans: z.string().optional(),
    research: z.string().optional(),
    reviews: z.string().optional(),
    solutions: z.string().optional(),
    standards: z.string().optional(),
  }).default({}),

  /** Mission boundaries — constraints subprocesses must never violate. */
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

  /** Tracing configuration. */
  tracing: z.object({
    /** Enable trace collection. Default: true. */
    enabled: z.boolean().default(true),
    /** Maximum number of traces to keep in the index. Default: 100. */
    max_traces: z.number().int().min(1).default(100),
  }).default({}),

  /** Sprint mode configuration. */
  sprint: SprintConfigSchema,
});

export type FlywheelConfig = z.infer<typeof FlywheelConfigSchema>;

/** Single source of truth for defaults — derived from Zod schema `.default()` values. */
export const CONFIG_DEFAULTS: FlywheelConfig = FlywheelConfigSchema.parse({});

// Model / effort resolution

/**
 * Maximum effort level a model supports.
 * Opus supports "max"; all other models cap at "high".
 */
export function resolveMaxEffort(model: string | undefined): "max" | "high" {
  if (model && model.toLowerCase().includes("opus")) return "max";
  return "high";
}

/**
 * Resolved per-tier config blob. Passed as a single object through the
 * transport/command pipeline so new fields don't require plumbing changes.
 */
export interface ResolvedTierConfig {
  model?: string;
  effort?: string;
}

/** Default effort per tier when not explicitly configured. */
const DEFAULT_EFFORTS = {
  dispatcher: "low",
  subprocess: undefined,  // workers inherit engine default — no effort flag unless set
  evaluator: "low",
} as const;

/**
 * Resolve per-tier config for dispatcher, subprocess, and evaluator.
 *
 * Precedence chain (first defined wins):
 *   sprint.tier > tier-specific > per-tier default (or sprint model-aware max)
 *
 * When `mode` is "sprint", the [sprint.worker], [sprint.evaluator], and
 * [sprint.dispatcher] TOML sections are consulted first. Sprint defaults to
 * model-aware max effort (opus→"max", else→"high") when nothing is set.
 */
export function resolveTierConfigs(config: FlywheelConfig, mode?: "sprint"): {
  dispatcher: ResolvedTierConfig;
  subprocess: ResolvedTierConfig;
  evaluator: ResolvedTierConfig;
} {
  const sprint = mode === "sprint" ? config.sprint : undefined;

  function resolve(
    tier: { model?: string; effort?: string },
    sprintTier: { model?: string; effort?: string } | undefined,
    tierDefault: string | undefined,
  ): ResolvedTierConfig {
    const model = sprintTier?.model ?? tier.model ?? config.model;
    const raw = sprintTier?.effort
      ?? tier.effort
      ?? config.effort
      ?? (sprint ? resolveMaxEffort(model) : tierDefault);
    // Clamp: "max" is only valid for opus. Downgrade to "high" for other models.
    const effort = raw === "max" && !model?.toLowerCase().includes("opus") ? "high" : raw;
    return { model, effort };
  }

  return {
    dispatcher: resolve(config.dispatcher, sprint?.dispatcher, DEFAULT_EFFORTS.dispatcher),
    subprocess: resolve(config.subprocess, sprint?.worker, DEFAULT_EFFORTS.subprocess),
    evaluator: resolve(config.evaluator, sprint?.evaluator, DEFAULT_EFFORTS.evaluator),
  };
}
