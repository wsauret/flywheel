import { canonicalize } from "../../../../../infra/canonical-name.js";

export type ModelFamily = "anthropic" | "openai" | "google";

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

const MODEL_FAMILY_PATTERNS: ReadonlyArray<{ family: ModelFamily; pattern: RegExp }> = [
  { family: "anthropic", pattern: /^claude-/i },
  { family: "openai", pattern: /^(gpt-|o\d|codex-|chatgpt-)/i },
  { family: "google", pattern: /^(gemini-|gemma-|learnlm-)/i },
];

function normalizeModelId(modelId: string): string {
  return canonicalize(modelId).replace(CONTEXT_SUFFIX_RE, "");
}

export function detectModelFamily(modelId: string): ModelFamily | null {
  const normalized = normalizeModelId(modelId);
  for (const { family, pattern } of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(normalized)) return family;
  }
  return null;
}

export function inferModelFamilyFromProvider(providerId: string): ModelFamily | null {
  const normalized = canonicalize(providerId);
  if (normalized === "anthropic" || normalized.startsWith("anthropic-")) return "anthropic";
  if (normalized === "openai" || normalized.startsWith("openai-")) return "openai";
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

export function buildUnknownModelFamilyMessage(modelId: string): string {
  return (
    `Cannot determine model family for "${modelId}". ` +
    "Model name must start with a known family prefix like claude-, gpt-, o, chatgpt-, or gemini-."
  );
}
