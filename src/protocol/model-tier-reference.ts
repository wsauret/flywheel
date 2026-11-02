import { canonicalize } from "../infra/canonical-name.js"
import type { ModelTier } from "./model-assignment-protocol-types.js"

// A model reference names a model id, a tier, or a family alias of a tier.
// This vocabulary stays apart from tier resolution, which loads the bundled
// model catalog, so that a client can recognize a tier without that cost.
const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(["powerful", "mid", "cheap"])
const MODEL_TIER_ALIASES = {
  opus: "powerful",
  sonnet: "mid",
  haiku: "cheap",
  pro: "powerful",
  flash: "mid",
  "flash-lite": "cheap",
} satisfies { readonly [K in string]: ModelTier }

function isModelTier(value: string): value is ModelTier {
  return MODEL_TIERS.has(value)
}

function isModelTierAlias(value: string): value is keyof typeof MODEL_TIER_ALIASES {
  return value in MODEL_TIER_ALIASES
}

/** The tier that a model reference names, or undefined when it names a model id. Case and separators do not matter. */
export function modelTierForReference(raw: string | undefined): ModelTier | undefined {
  if (raw === undefined) return undefined
  const lowered = canonicalize(raw)
  if (isModelTier(lowered)) return lowered
  return isModelTierAlias(lowered) ? MODEL_TIER_ALIASES[lowered] : undefined
}

export function isModelTierReference(value: string): boolean {
  return modelTierForReference(value) !== undefined
}
