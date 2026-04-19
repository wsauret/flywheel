import { z } from "zod";
import { EffortSchema, TierConfigSchema } from "../../infra/workflow-types.js";
import { SprintConfigSchema } from "../../workflows/queue/steps/sprint/config-schema.js";
import { resolveModelTier } from "./model-tiers.js";
import type { ComponentRole, Vendor } from "./model-tiers.js";

const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` },
  );
}

const BoundariesSchema = z.object({
  /** Allowed port ranges (e.g. ["3000-3100", "8080-8090"]). */
  port_ranges: z.array(z.string()).optional(),
  /** Directories workers must not modify. */
  off_limits_dirs: z.array(z.string()).optional(),
  /** External services workers should be aware of. */
  external_services: z.array(z.string()).optional(),
});

const CommandsSchema = z.object({
  /** Command to run the test suite. */
  test: z.string().optional(),
  /** Command to run typecheck. */
  typecheck: z.string().optional(),
  /** Command to run the linter. */
  lint: z.string().optional(),
});

export const FlywheelConfigSchema = z.object({
  /** Engine ID: "claude", "opencode", etc. */
  engine: z.string().default("claude"),
  preferred_vendor: z.enum(["anthropic", "openai"]).default("anthropic"),
  openai_auth: z.enum(["api_key", "chatgpt"]).default("api_key"),
  openai_email: z.string().email().optional(),
  /** TUI theme name: "opencode", "tokyonight", "dracula", "catppuccin", "nord", "gruvbox". */
  theme: z.string().optional(),
  /** Show thinking/reasoning blocks in the output window. Default: true. */
  show_thinking: z.boolean().default(true),
  /** Per-tier config for the dispatcher */
  dispatcher: TierConfigSchema,
  /** Per-tier config for the worker */
  worker: TierConfigSchema,
  /** Per-tier config for the evaluator */
  evaluator: TierConfigSchema,
  /** Convenience: sets dispatcher.model, worker.model, and evaluator.model if not individually overridden */
  model: z.string().optional(),
  /** Convenience: sets dispatcher.effort, worker.effort, and evaluator.effort if not individually overridden */
  effort: EffortSchema.optional(),
  timeout_minutes: z.number().int().min(1).max(120).default(60),
  project_cwd: noShellMetachars("project_cwd").optional(),
  skip_evaluation: z.boolean().default(false),

  /** Max evaluator retry cycles per step. 1 = single attempt (no retries). Default: 3. */
  max_eval_cycles: z.number().int().min(1).max(10).default(3),

  /** Max revision attempts after evaluator failure. 0 = no revisions. Default: 1. */
  max_revisions: z.number().int().min(0).max(5).default(1),

  /** Budget limits for workflow execution. 0 = unlimited for all fields. */
  budget: z.object({
    /** Max total engine invocations across all steps. 0 = unlimited. */
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

  /** Mission boundaries — constraints workers must never violate. */
  boundaries: BoundariesSchema.optional(),

  /** Project commands for scrutiny validation (test, typecheck, lint). */
  commands: CommandsSchema.optional(),

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

export const CONFIG_DEFAULTS: FlywheelConfig = FlywheelConfigSchema.parse({});

function resolveMaxEffort(model: string | undefined): "max" | "high" {
  if (model && model.toLowerCase().includes("opus")) return "max";
  return "high";
}

export interface ResolvedTierConfig {
  /** Engine ID for this tier. Always populated (tier override > top-level default). */
  engine: string;
  /** Concrete model ID. Always populated (tier name resolution + component defaults). */
  model: string;
  effort?: string;
}

const DEFAULT_EFFORTS = {
  dispatcher: "low",
  worker: undefined,  // workers inherit engine default — no effort flag unless set
  evaluator: "low",
} as const;

// Precedence: sprint.tier > tier-specific > per-tier default (or sprint model-aware max).
// Engine precedence: tier.engine > config.engine (step-level overrides happen downstream).
export function resolveTierConfigs(config: FlywheelConfig, mode?: "sprint"): {
  dispatcher: ResolvedTierConfig;
  worker: ResolvedTierConfig;
  evaluator: ResolvedTierConfig;
} {
  const sprint = mode === "sprint" ? config.sprint : undefined;
  const defaultEngine = config.engine;
  const vendor: Vendor = config.preferred_vendor as Vendor;

  function resolve(
    tier: { engine?: string; model?: string; effort?: string },
    sprintTier: { model?: string; effort?: string } | undefined,
    tierDefault: string | undefined,
    role: ComponentRole,
  ): ResolvedTierConfig {
    const engine = tier.engine ?? defaultEngine;
    const effectiveVendor: Vendor = engine === "claude" ? "anthropic" : vendor;
    const rawModel = sprintTier?.model ?? tier.model ?? config.model;
    const model = resolveModelTier(rawModel, role, effectiveVendor);
    const raw = sprintTier?.effort
      ?? tier.effort
      ?? config.effort
      ?? (sprint ? resolveMaxEffort(model) : tierDefault);
    // Clamp: "max" is only valid for opus. Downgrade to "high" for other models.
    const effort = raw === "max" && !model.toLowerCase().includes("opus") ? "high" : raw;
    return { engine, model, effort };
  }

  return {
    dispatcher: resolve(config.dispatcher, sprint?.dispatcher, DEFAULT_EFFORTS.dispatcher, "dispatcher"),
    worker: resolve(config.worker, sprint?.worker, DEFAULT_EFFORTS.worker, "worker"),
    evaluator: resolve(config.evaluator, sprint?.evaluator, DEFAULT_EFFORTS.evaluator, "evaluator"),
  };
}
