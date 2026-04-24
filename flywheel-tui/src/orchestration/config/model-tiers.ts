import { buildMissingAccessProviderMessage, getConfiguredAccessProvidersForFamily } from "../engines/providers/harness/llm/access-provider.js";
import { buildUnknownModelFamilyMessage, detectModelFamily, type ModelFamily } from "../engines/providers/harness/llm/model-family.js";
import { canonicalize } from "../../infra/canonical-name.js";
import type { AuthContext } from "../../infra/auth/auth-context.js";

type ModelTier = "powerful" | "mid" | "cheap";
type ComponentRole = "worker" | "evaluator" | "dispatcher";

// Exhaustive ordered preference lists per tier, derived from models.dev/api.json.
// Newest models first within each cost band. The runtime availability check
// (via cached model list) filters to what the account can actually use.
// Pricing source: models.dev.
const TIER_PREFERENCES: Record<ModelFamily, Record<ModelTier, readonly string[]>> = {
  anthropic: {
    // Opus line: $5-$15 input. Newest first.
    powerful: [
      "claude-opus-4-7", "claude-opus-4-6[1m]", "claude-opus-4-6",
      "claude-opus-4-5-20251101", "claude-opus-4-5",
      "claude-opus-4-1-20250805", "claude-opus-4-1",
    ],
    // Sonnet line: $3 input. Newest first.
    mid: [
      "claude-sonnet-4-6[1m]", "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929", "claude-sonnet-4-5",
      "claude-sonnet-4-0", "claude-sonnet-4-20250514",
    ],
    // Haiku line: $0.25-$1 input. Newest first.
    cheap: [
      "claude-haiku-4-5-20251001", "claude-haiku-4-5",
      "claude-3-5-haiku-20241022", "claude-3-5-haiku-latest",
      "claude-3-haiku-20240307",
    ],
  },
  openai: {
    // Full-size base + codex models: $1.25-$2.50 input. Newest first.
    powerful: [
      "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark",
      "gpt-5.2-codex", "gpt-5.2",
      "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1",
    ],
    // Mini + mini-reasoning models: $0.15-$1.10 input. Newest first.
    mid: [
      "gpt-5.4-mini",
      "gpt-5.1-codex-mini", "gpt-5-mini",
      "o4-mini", "o3-mini",
    ],
    // Nano models: $0.05-$0.20 input. Newest first.
    cheap: [
      "gpt-5.4-nano", "gpt-5-nano",
      "gpt-4.1-nano",
    ],
  },
  google: {
    // Pro line: $1.25-$2 input. Newest first.
    powerful: [
      "gemini-3.1-pro-preview", "gemini-3-pro-preview",
      "gemini-2.5-pro",
    ],
    // Flash line: $0.10-$0.50 input. Newest first.
    mid: [
      "gemini-3-flash-preview",
      "gemini-2.5-flash", "gemini-2.0-flash",
    ],
    // Flash-lite / small: $0.04-$0.10 input. Newest first.
    cheap: [
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-flash-lite", "gemini-2.0-flash-lite",
    ],
  },
};

// User-facing shorthands: family-specific model nicknames → abstract tier names.
const MODEL_TIER_ALIASES: Record<string, ModelTier> = {
  opus: "powerful",
  sonnet: "mid",
  haiku: "cheap",
  pro: "powerful",
  flash: "mid",
  "flash-lite": "cheap",
};

const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(["powerful", "mid", "cheap"]);
export function isModelTier(value: string): value is ModelTier {
  return MODEL_TIERS.has(value);
}

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
    return resolveModelForTier(tier, family);
  }

  const lowered = canonicalize(raw);

  if (isModelTier(lowered)) {
    return resolveModelForTier(lowered, family);
  }

  if (lowered in MODEL_TIER_ALIASES) {
    const tier = MODEL_TIER_ALIASES[lowered]!;
    return resolveModelForTier(tier, family);
  }

  return raw;
}

interface ModelValidationError {
  component: string;
  model: string;
  issue: string;
}

export function validateResolvedModels(
  models: { component: string; model: string; engineId: string }[],
  auth: AuthContext,
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

    if (getConfiguredAccessProvidersForFamily(family, auth).length === 0) {
      errors.push({ component, model, issue: buildMissingAccessProviderMessage(family) });
    }
  }
  return errors;
}

export function resolveModelForTier(
  tier: ModelTier,
  family: ModelFamily,
  availableModels?: ReadonlySet<string>,
): string {
  const preferences = TIER_PREFERENCES[family][tier];
  if (availableModels && availableModels.size > 0) {
    for (const model of preferences) {
      if (availableModels.has(model)) return model;
    }
  }
  return preferences[0]!;
}

export type { ComponentRole };
