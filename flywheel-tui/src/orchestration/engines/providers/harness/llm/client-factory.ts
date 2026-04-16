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

export function createClient(model: string, modelsClient: ModelsClient): LLMClient {
  const provider = modelsClient.detectProvider(model);

  if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required for Anthropic models",
      );
    }
    return createAnthropicAdapter(apiKey, model, modelsClient);
  }

  if (provider === "openai") {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for OpenAI models",
      );
    }
    return createOpenAIAdapter(apiKey, model, modelsClient);
  }

  throw new Error(
    `Cannot determine provider for model '${model}'. ` +
      `Model name must start with 'claude-' (Anthropic) or 'gpt-'/'o' (OpenAI).`,
  );
}
