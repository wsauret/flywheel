/**
 * LLM client factory.
 *
 * Routes to the correct provider adapter based on model prefix heuristics
 * and models.dev metadata. Callers get an LLMClient without knowing whether
 * the model is Anthropic or OpenAI.
 */

import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAIAdapter } from "./openai.js";
import type { ModelsClient } from "./models.js";
import type { LLMClient } from "./types.js";

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

const BARE_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function normalizeModel(model: string): string {
  const alias = BARE_ALIASES[model.toLowerCase()];
  if (alias) return alias;
  return model.replace(CONTEXT_SUFFIX_RE, "");
}

export function createClient(model: string, modelsClient: ModelsClient): LLMClient {
  const normalized = normalizeModel(model);
  const provider = modelsClient.detectProvider(normalized);

  if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required for Anthropic models",
      );
    }
    return createAnthropicAdapter(apiKey, normalized, modelsClient);
  }

  if (provider === "openai") {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for OpenAI models",
      );
    }
    return createOpenAIAdapter(apiKey, normalized, modelsClient);
  }

  throw new Error(
    `Cannot determine provider for model '${model}'. ` +
      `Model name must start with 'claude-' (Anthropic) or 'gpt-'/'o' (OpenAI).`,
  );
}
