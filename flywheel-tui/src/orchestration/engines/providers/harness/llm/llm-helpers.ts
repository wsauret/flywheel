/**
 * Shared helpers for LLM provider adapters.
 *
 * Consolidates the model-info caching and cost calculation logic that
 * is structurally identical across Anthropic and OpenAI adapters,
 * differing only in provider hint and default cache rate ratios.
 */

import type { ModelCost, ModelInfo, ModelsClient } from "./models.js";

interface CacheRateFallbacks {
  cacheReadRatio: number;
  cacheWriteRatio: number;
}

export function computeCost(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; promptTokens?: number },
  cost: ModelCost,
  fallbacks: CacheRateFallbacks,
): number {
  const totalPrompt = tokens.promptTokens ?? (tokens.input + tokens.cacheRead + tokens.cacheWrite);
  const rates = totalPrompt > 200_000
    ? cost.contextOver200k ?? cost
    : cost;
  const inputRate = rates.input;
  const outputRate = rates.output;
  const cacheReadRate = rates.cacheRead ?? inputRate * fallbacks.cacheReadRatio;
  const cacheWriteRate = rates.cacheWrite ?? inputRate * fallbacks.cacheWriteRatio;
  return (
    (tokens.input * inputRate +
      tokens.output * outputRate +
      tokens.cacheRead * cacheReadRate +
      tokens.cacheWrite * cacheWriteRate) /
    1_000_000
  );
}

interface ModelInfoCache {
  resolveModelInfo(model: string): Promise<ModelInfo | null>;
  getCached(): { model: string; info: ModelInfo } | null;
}

export function createModelInfoCache(
  modelsClient: ModelsClient,
  providerHint: string,
): ModelInfoCache {
  let cache: { model: string; info: ModelInfo } | null = null;

  return {
    async resolveModelInfo(model: string): Promise<ModelInfo | null> {
      if (cache?.model === model) return cache.info;
      const info = await modelsClient.getModelInfo(model, providerHint);
      if (info) cache = { model, info };
      return info;
    },
    getCached() {
      return cache;
    },
  };
}
