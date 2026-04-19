/**
 * LLM client factory.
 *
 * Routes to the correct provider adapter based on model prefix heuristics
 * and models.dev metadata. Callers get an LLMClient without knowing whether
 * the model is Anthropic or OpenAI.
 */

import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAIAdapter } from "./openai.js";
import { loadStoredTokens } from "../../../../../infra/auth/openai-token-store.js";
import { loadCachedModels } from "../../../../../infra/auth/openai-model-cache.js";
import { Log } from "../../../../../infra/log.js";
import type { ModelsClient } from "./models.js";
import type { LLMClient } from "./types.js";

const log = Log.create({ service: "llm-client-factory" });

const CHATGPT_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2",
]);

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
    const authMode = process.env["FLYWHEEL_OPENAI_AUTH"];
    if (authMode === "chatgpt") {
      const tokens = loadStoredTokens();
      if (!tokens) {
        throw new Error("No ChatGPT tokens found. Run: flywheel auth login");
      }
      const allowedModels = loadCachedModels() ?? CHATGPT_FALLBACK_MODELS;
      if (!allowedModels.has(normalized)) {
        log.warn(`Model "${normalized}" not in ChatGPT model list — may not be available`);
      }
      return createOpenAIAdapter({ kind: "chatgpt", ...tokens }, normalized, modelsClient);
    }
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for OpenAI models",
      );
    }
    return createOpenAIAdapter({ kind: "apiKey", apiKey }, normalized, modelsClient);
  }

  throw new Error(
    `Cannot determine provider for model '${model}'. ` +
      `Model name must start with 'claude-' (Anthropic) or 'gpt-'/'o' (OpenAI).`,
  );
}
