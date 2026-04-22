/**
 * LLM client factory.
 *
 * Routes to the correct access-provider adapter based on model-family heuristics.
 * Callers get an LLMClient without knowing whether the model is Anthropic,
 * OpenAI, or another supported family.
 */

import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAIAdapter } from "./openai.js";
import { loadStoredTokens } from "../../../../../infra/auth/openai-token-store.js";
import { loadCachedModels } from "../../../../../infra/auth/openai-model-cache.js";
import { Log } from "../../../../../infra/log.js";
import {
  buildMissingAccessProviderMessage,
  getConfiguredAccessProvidersForFamily,
  type AccessProviderId,
} from "./access-provider.js";
import { buildUnknownModelFamilyMessage, detectModelFamily } from "./model-family.js";
import type { ModelsClient } from "./models.js";
import type { LLMClient } from "./types.js";

const log = Log.create({ service: "llm-client-factory" });

const CHATGPT_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2",
]);

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

function normalizeModel(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, "");
}

function createAnthropicApiClient(model: string, modelsClient: ModelsClient): LLMClient {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for Anthropic models",
    );
  }
  return createAnthropicAdapter(apiKey, model, modelsClient);
}

function createChatGPTAccessClient(model: string, modelsClient: ModelsClient): LLMClient {
  const tokens = loadStoredTokens();
  if (!tokens) {
    throw new Error("No ChatGPT tokens found. Run: flywheel auth login");
  }
  const allowedModels = loadCachedModels() ?? CHATGPT_FALLBACK_MODELS;
  if (!allowedModels.has(model)) {
    log.warn(`Model "${model}" not in ChatGPT model list — may not be available`);
  }
  return createOpenAIAdapter({ kind: "chatgpt", ...tokens }, model, modelsClient);
}

function createOpenAIApiClient(model: string, modelsClient: ModelsClient): LLMClient {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for OpenAI models",
    );
  }
  return createOpenAIAdapter({ kind: "apiKey", apiKey }, model, modelsClient);
}

const ACCESS_PROVIDER_FACTORIES: Record<AccessProviderId, (model: string, modelsClient: ModelsClient) => LLMClient> = {
  anthropic_api: createAnthropicApiClient,
  chatgpt: createChatGPTAccessClient,
  openai_api: createOpenAIApiClient,
};

export function createClient(model: string, modelsClient: ModelsClient): LLMClient {
  const normalized = normalizeModel(model);
  const family = detectModelFamily(normalized);
  if (!family) throw new Error(buildUnknownModelFamilyMessage(model));

  const accessProvider = getConfiguredAccessProvidersForFamily(family)[0];
  if (!accessProvider) throw new Error(buildMissingAccessProviderMessage(family));

  return ACCESS_PROVIDER_FACTORIES[accessProvider](normalized, modelsClient);
}
