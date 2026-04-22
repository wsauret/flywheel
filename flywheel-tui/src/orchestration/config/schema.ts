import { z } from "zod";
import { EffortSchema, TierConfigSchema } from "../../infra/workflow-types.js";
import { SprintConfigSchema } from "../../workflows/queue/steps/sprint/config-schema.js";
import { resolveModelTier } from "./model-tiers.js";
import type { ModelFamily } from "../engines/providers/harness/llm/model-family.js";
import { canonicalize } from "../../infra/canonical-name.js";
import type { ComponentRole } from "./model-tiers.js";

const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` },
  );
}

export const FlywheelConfigSchema = z.object({
  engine: z.string().default("claude"),
  preferred_model_family: z.enum(["anthropic", "openai", "google"]).default("anthropic"),
  openai_auth: z.enum(["api_key", "chatgpt"]).default("api_key"),
  openai_email: z.string().email().optional(),
  theme: z.string().optional(),
  show_thinking: z.boolean().default(true),
  dispatcher: TierConfigSchema,
  worker: TierConfigSchema,
  evaluator: TierConfigSchema,
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  project_cwd: noShellMetachars("project_cwd").optional(),
  skip_evaluation: z.boolean().default(false),
  max_eval_cycles: z.number().int().min(1).max(10).default(3),
  max_revisions: z.number().int().min(0).max(5).default(1),
  queue: z.object({
    max_steps: z.number().int().min(1).max(1000).default(50),
  }).default({}),
  tracing: z.object({
    enabled: z.boolean().default(true),
    max_traces: z.number().int().min(1).default(100),
  }).default({}),
  sprint: SprintConfigSchema,
});

export type FlywheelConfig = z.infer<typeof FlywheelConfigSchema>;

export const CONFIG_DEFAULTS: FlywheelConfig = FlywheelConfigSchema.parse({});

function resolveMaxEffort(model: string | undefined): "max" | "high" {
  if (model && canonicalize(model).includes("opus")) return "max";
  return "high";
}

interface ResolvedTierConfig {
  engine: string;
  model: string;
  effort?: string;
}

const DEFAULT_EFFORTS = {
  dispatcher: "low",
  worker: undefined,
  evaluator: "low",
} as const;

export function resolveTierConfigs(config: FlywheelConfig, mode?: "sprint"): {
  dispatcher: ResolvedTierConfig;
  worker: ResolvedTierConfig;
  evaluator: ResolvedTierConfig;
} {
  const sprint = mode === "sprint" ? config.sprint : undefined;
  const defaultEngine = config.engine;
  const family: ModelFamily = config.preferred_model_family;

  function resolve(
    tier: { engine?: string; model?: string; effort?: string },
    sprintTier: { model?: string; effort?: string } | undefined,
    tierDefault: string | undefined,
    role: ComponentRole,
  ): ResolvedTierConfig {
    const engine = tier.engine ?? defaultEngine;
    const effectiveFamily: ModelFamily = engine === "claude" ? "anthropic" : family;
    const rawModel = sprintTier?.model ?? tier.model ?? config.model;
    const model = resolveModelTier(rawModel, role, effectiveFamily);
    const raw = sprintTier?.effort
      ?? tier.effort
      ?? config.effort
      ?? (sprint ? resolveMaxEffort(model) : tierDefault);
    const effort = raw === "max" && !canonicalize(model).includes("opus") ? "high" : raw;
    return { engine, model, effort };
  }

  return {
    dispatcher: resolve(config.dispatcher, sprint?.dispatcher, DEFAULT_EFFORTS.dispatcher, "dispatcher"),
    worker: resolve(config.worker, sprint?.worker, DEFAULT_EFFORTS.worker, "worker"),
    evaluator: resolve(config.evaluator, sprint?.evaluator, DEFAULT_EFFORTS.evaluator, "evaluator"),
  };
}
