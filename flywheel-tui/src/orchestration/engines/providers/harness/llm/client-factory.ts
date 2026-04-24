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
import type { AuthContext } from "../../../../../infra/auth/auth-context.js";
import type { ModelsClient } from "./models.js";
import type { LLMClient } from "./types.js";

const log = Log.create({ service: "llm-client-factory" });

const CHATGPT_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5", "gpt-5-mini",
]);

const CONTEXT_SUFFIX_RE = /\[\w+\]$/;

function normalizeModel(model: string): string {
  return model.replace(CONTEXT_SUFFIX_RE, "");
}

function createAnthropicApiClient(model: string, modelsClient: ModelsClient, auth: AuthContext): LLMClient {
  if (!auth.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for Anthropic models",
    );
  }
  return createAnthropicAdapter(auth.anthropicApiKey, model, modelsClient);
}

function createChatGPTAccessClient(model: string, modelsClient: ModelsClient, _auth: AuthContext): LLMClient {
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

function createOpenAIApiClient(model: string, modelsClient: ModelsClient, auth: AuthContext): LLMClient {
  if (!auth.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for OpenAI models",
    );
  }
  return createOpenAIAdapter({ kind: "apiKey", apiKey: auth.openaiApiKey }, model, modelsClient);
}

const ACCESS_PROVIDER_FACTORIES: Record<
  AccessProviderId,
  (model: string, modelsClient: ModelsClient, auth: AuthContext) => LLMClient
> = {
  anthropic_api: createAnthropicApiClient,
  chatgpt: createChatGPTAccessClient,
  openai_api: createOpenAIApiClient,
};

export function createClient(model: string, modelsClient: ModelsClient, auth: AuthContext): LLMClient {
  const normalized = normalizeModel(model);
  const family = detectModelFamily(normalized);
  if (!family) throw new Error(buildUnknownModelFamilyMessage(model));

  const accessProvider = getConfiguredAccessProvidersForFamily(family, auth)[0];
  if (!accessProvider) throw new Error(buildMissingAccessProviderMessage(family));

  return ACCESS_PROVIDER_FACTORIES[accessProvider](normalized, modelsClient, auth);
}
