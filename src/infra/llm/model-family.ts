import { canonicalize } from "../canonical-name.js";
import { isCustomProviderModel } from "./custom-provider-registry.js";
import { canonicalModelId } from "./model-id.js";

export type ModelFamily = "anthropic" | "openai" | "google";

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

// Note: grok-*, oswe*, mai-*, and kimi-* models map to the `openai` family
// because Copilot serves them over OpenAI-compatible endpoints. The dispatch
// layer (`copilot-model-support.ts`) decides which of those endpoints each id
// rides (Responses vs chat-completions).
const MODEL_FAMILY_PATTERNS: ReadonlyArray<{ family: ModelFamily; pattern: RegExp }> = [ // provider-model-literal-allow: display -- legacy labels and error copy only
  { family: "anthropic", pattern: /^claude-/i },
  { family: "openai", pattern: /^(gpt-|o\d|codex-|chatgpt-|grok-|oswe|mai-|kimi-)/i },
  { family: "google", pattern: /^(gemini-|gemma-|learnlm-)/i },
];

function normalizeModelId(modelId: string): string {
  return canonicalModelId(modelId).replace(CONTEXT_SUFFIX_RE, "");
}

/** A `vendor/model` id with an optional `:variant` suffix: the spelling an
 *  aggregator uses for a model it routes. OpenRouter's wire ids are the one
 *  case Flywheel knows, and the aggregator folds the ids it mirrors to their
 *  first-party form at its own boundary. */
const VENDOR_SCOPED_MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

export function isVendorScopedModelId(model: string): boolean {
  return VENDOR_SCOPED_MODEL_ID.test(canonicalize(model));
}

/** The id prefixes of the OpenAI GPT, o-series, coding, and ChatGPT models: the models trained on the apply_patch grammar. */
const APPLY_PATCH_MODEL_ID = /^(gpt-|o\d(?:$|-)|codex-|chatgpt-)/i;

export function isApplyPatchModel(modelId: string): boolean {
  return APPLY_PATCH_MODEL_ID.test(normalizeModelId(modelId));
}

export function detectModelFamily(modelId: string): ModelFamily | null { // provider-model-literal-allow: display -- legacy labels and error copy only
  const normalized = normalizeModelId(modelId);
  for (const { family, pattern } of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(normalized)) return family;
  }
  // A "vendor/model" id maps to `openai` because an aggregator serves it over
  // one OpenAI-compatible chat-completions wire, regardless of which vendor
  // sits behind the slash. Mirrored slash ids never occur internally because
  // the aggregator's listing folds them to first-party ids.
  if (isVendorScopedModelId(normalized)) return "openai";
  // Config-declared custom providers speak one OpenAI-compatible
  // chat-completions wire, so every model they declare is `openai` shaped
  // regardless of which vendor trained it.
  if (isCustomProviderModel(normalized)) return "openai";
  return null;
}

/** Whether only a config-declared custom provider can serve `modelId`: a
 *  declared custom id that no base family pattern or provider wire shape
 *  claims. Ids a base pattern claims stay shared (a custom proxy may declare
 *  gpt-4o and serve it beside the first-party OpenAI providers); ids that
 *  exist in Flywheel's universe only through a [custom_providers] entry must
 *  be rejected by every other provider rather than falsely admitted to an
 *  API that does not know them. */
export function isCustomProviderOnlyModel(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return (
    isCustomProviderModel(normalized) &&
    !MODEL_FAMILY_PATTERNS.some(({ pattern }) => pattern.test(normalized)) &&
    !isVendorScopedModelId(normalized)
  );
}

export function inferModelFamilyFromProvider(providerId: string): ModelFamily | null {
  const normalized = canonicalize(providerId);
  if (normalized === "anthropic" || normalized.startsWith("anthropic-")) return "anthropic";
  if (normalized === "openai" || normalized.startsWith("openai-")) return "openai";
  // OpenRouter, xAI, and DeepSeek use OpenAI-compatible wires.
  if (normalized === "openrouter" || normalized === "xai" || normalized === "deepseek") return "openai";
  // The Go and Zen subscription plans serve their models over
  // OpenAI-compatible wires.
  if (normalized === "opencode" || normalized.startsWith("opencode-")) return "openai";
  if (
    normalized === "google" ||
    normalized.startsWith("google-") ||
    normalized.startsWith("vertex") ||
    normalized.includes("gemini")
  ) {
    return "google";
  }
  return null;
}

