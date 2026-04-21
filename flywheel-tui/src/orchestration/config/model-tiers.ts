type ModelTier = "powerful" | "mid" | "cheap";
type Vendor = "anthropic" | "openai";
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
} satisfies Record<Vendor, Record<ModelTier, string>>;

// User-facing shorthands: Anthropic family names → abstract tier names.
const MODEL_FAMILY_ALIASES: Record<string, ModelTier> = {
  opus: "powerful",
  sonnet: "mid",
  haiku: "cheap",
};

const COMPONENT_DEFAULT_TIERS: Record<ComponentRole, ModelTier> = {
  worker: "powerful",
  evaluator: "mid",
  dispatcher: "mid",
};

export function resolveModelTier(
  raw: string | undefined,
  role: ComponentRole,
  vendor: Vendor,
): string {
  if (raw === undefined) {
    const tier = COMPONENT_DEFAULT_TIERS[role];
    return TIER_TABLE[vendor][tier];
  }

  const lowered = raw.toLowerCase();

  const vendorTiers = TIER_TABLE[vendor];
  if (lowered in vendorTiers) {
    return vendorTiers[lowered as ModelTier];
  }

  if (lowered in MODEL_FAMILY_ALIASES) {
    const tier = MODEL_FAMILY_ALIASES[lowered]!;
    return vendorTiers[tier];
  }

  return raw;
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

const OPENAI_MODEL_RE = /^(gpt-|o\d|codex-|chatgpt-)/;

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
    if (engineId === "claude" && !model.toLowerCase().startsWith("claude-")) {
      errors.push({ component, model, issue: `Claude engine requires Claude models, got "${model}"` });
      continue;
    }

    const lower = model.toLowerCase();
    if (lower.startsWith("claude-")) {
      if (!env["ANTHROPIC_API_KEY"]) {
        errors.push({ component, model, issue: "Missing ANTHROPIC_API_KEY" });
      }
    } else if (OPENAI_MODEL_RE.test(lower)) {
      if (env["FLYWHEEL_OPENAI_AUTH"] !== "chatgpt" && !env["OPENAI_API_KEY"]) {
        errors.push({ component, model, issue: "Missing OPENAI_API_KEY" });
      }
    }
  }
  return errors;
}

export type { ModelTier, Vendor, ComponentRole };
