import { canonicalize } from "../canonical-name.js";
import { isCustomProviderModel } from "./custom-provider-registry.js";
import { canonicalModelId } from "../model-id.js";

/** The wire family that serves a model: the Anthropic Messages API, the OpenAI Responses API, the vendor-neutral Chat
 *  Completions API, or the Google Generative AI API. It names the wire, not the vendor that trained the model. */
export type ModelFamily = "anthropic" | "openai" | "chat-completions" | "google";

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

// Note: grok-*, oswe*, mai-*, and kimi-* models map to the `openai` family
// because Copilot serves them over OpenAI endpoints. The dispatch layer
// (`provider-github-copilot/model-support.ts`) decides which endpoint each id
// rides (Responses or Chat Completions).
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

function isVendorScopedModelId(model: string): boolean {
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
  // A "vendor/model" id maps to `chat-completions` because an aggregator
  // serves it over one Chat Completions wire, regardless of which vendor sits
  // behind the slash. Mirrored slash ids never occur internally because the
  // aggregator's listing folds them to first-party ids.
  if (isVendorScopedModelId(normalized)) return "chat-completions";
  // Config-declared custom providers speak one Chat Completions wire, so
  // every model they declare is `chat-completions` shaped regardless of which
  // vendor trained it.
  if (isCustomProviderModel(normalized)) return "chat-completions";
  return null;
}

export function inferModelFamilyFromProvider(providerId: string): ModelFamily | null {
  const normalized = canonicalize(providerId);
  if (normalized === "anthropic" || normalized.startsWith("anthropic-")) return "anthropic";
  if (normalized === "openai" || normalized.startsWith("openai-")) return "openai";
  // xAI's catalog serves the SuperGrok subscription, which speaks the Responses API.
  if (normalized === "xai") return "openai";
  // OpenRouter and DeepSeek serve over Chat Completions, and so do the
  // Go and Zen subscription plans by default.
  if (normalized === "openrouter" || normalized === "deepseek") return "chat-completions";
  if (normalized === "opencode" || normalized.startsWith("opencode-")) return "chat-completions";
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

