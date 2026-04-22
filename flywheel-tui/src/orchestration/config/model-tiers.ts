import { buildMissingAccessProviderMessage, getConfiguredAccessProvidersForFamily } from "../engines/providers/harness/llm/access-provider.js";
import { buildUnknownModelFamilyMessage, detectModelFamily, type ModelFamily } from "../engines/providers/harness/llm/model-family.js";

type ModelTier = "powerful" | "mid" | "cheap";
type ComponentRole = "worker" | "evaluator" | "dispatcher";

export const TIER_TABLE = {
  anthropic: {
    powerful: "claude-opus-4-6[1m]",
    mid: "claude-sonnet-4-6[1m]",
    cheap: "claude-haiku-4-5-20251001",
  },
  openai: {
    powerful: "gpt-5.4",
    mid: "gpt-5.3-codex",
    cheap: "gpt-5.4-mini",
  },
  google: {
    powerful: "gemini-2.5-pro",
    mid: "gemini-2.5-flash",
    cheap: "gemini-2.5-flash-lite",
  },
} satisfies Record<ModelFamily, Record<ModelTier, string>>;

// User-facing shorthands: family-specific model nicknames → abstract tier names.
const MODEL_TIER_ALIASES: Record<string, ModelTier> = {
  opus: "powerful",
  sonnet: "mid",
  haiku: "cheap",
  pro: "powerful",
  flash: "mid",
  "flash-lite": "cheap",
};

const COMPONENT_DEFAULT_TIERS: Record<ComponentRole, ModelTier> = {
  worker: "powerful",
  evaluator: "mid",
  dispatcher: "mid",
};

export function resolveModelTier(
  raw: string | undefined,
  role: ComponentRole,
  family: ModelFamily,
): string {
  if (raw === undefined) {
    const tier = COMPONENT_DEFAULT_TIERS[role];
    return TIER_TABLE[family][tier];
  }

  const lowered = raw.toLowerCase();

  const familyTiers = TIER_TABLE[family];
  if (lowered in familyTiers) {
    return familyTiers[lowered as ModelTier];
  }

  if (lowered in MODEL_TIER_ALIASES) {
    const tier = MODEL_TIER_ALIASES[lowered]!;
    return familyTiers[tier];
  }

  return raw;
}

export interface ModelValidationError {
  component: string;
  model: string;
  issue: string;
}

export function validateResolvedModels(
  models: { component: string; model: string; engineId: string }[],
  env: Record<string, string | undefined> = process.env,
): ModelValidationError[] {
  const errors: ModelValidationError[] = [];
  for (const { component, model, engineId } of models) {
    const family = detectModelFamily(model);

    if (engineId === "claude" && family !== "anthropic") {
      errors.push({ component, model, issue: `Claude engine requires Claude models, got "${model}"` });
      continue;
    }

    if (!family) {
      errors.push({ component, model, issue: buildUnknownModelFamilyMessage(model) });
      continue;
    }

    if (getConfiguredAccessProvidersForFamily(family, env).length === 0) {
      errors.push({ component, model, issue: buildMissingAccessProviderMessage(family) });
    }
  }
  return errors;
}

export type { ModelTier, ComponentRole };
