/**
 * Shared helpers for LLM provider adapters.
 *
 * Consolidates the model-info caching and cost calculation logic that
 * is structurally identical across Anthropic and OpenAI adapters,
 * differing only in provider hint and default cache rate ratios.
 */

import type { ModelCost, ModelInfo, ModelPricing, ModelPricingProvenance, NormalizedModelCostTier, NormalizedModelRateCard } from "./models.js";

interface CacheRateFallbacks {
  cacheReadRatio: number;
  cacheWriteRatio: number;
}

export type UsagePriceResult =
  | { readonly status: "priced"; readonly amountUsd: number; readonly rateCard: NormalizedModelRateCard; readonly provenance: ModelPricingProvenance }
  | { readonly status: "unavailable"; readonly reason: "missing-rate-card" };

function normalizeTier(tier: ModelCost, fallbacks: CacheRateFallbacks): NormalizedModelCostTier {
  return Object.freeze({
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead ?? tier.input * fallbacks.cacheReadRatio,
    cacheWrite: tier.cacheWrite ?? tier.input * fallbacks.cacheWriteRatio,
    cacheWrite1h: tier.input * 2,
    reasoning: tier.reasoning ?? tier.output,
  });
}

export function computeUsagePrice(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning: number; promptTokens?: number },
  pricing: ModelPricing,
  fallbacks: CacheRateFallbacks = { cacheReadRatio: 0, cacheWriteRatio: 0 },
): UsagePriceResult {
  if (pricing.status === "unavailable") return pricing;
  const standard = normalizeTier(pricing.rateCard, fallbacks);
  const rateCard: NormalizedModelRateCard = Object.freeze({
    standard,
    ...(pricing.rateCard.highContext ? { highContext: normalizeTier({ ...pricing.rateCard.highContext }, fallbacks) } : {}),
  });
  const rates = pricing.rateCard.highContext !== undefined
    && (tokens.promptTokens ?? tokens.input + tokens.cacheRead + tokens.cacheWrite) > pricing.rateCard.highContext.threshold
    ? rateCard.highContext ?? standard
    : standard;
  const write1h = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
  const amountUsd = (
    tokens.input * rates.input
    + tokens.output * rates.output
    + tokens.cacheRead * rates.cacheRead
    + (tokens.cacheWrite - write1h) * rates.cacheWrite
    + write1h * rates.cacheWrite1h
    + tokens.reasoning * rates.reasoning
  ) / 1_000_000;
  return Object.freeze({ status: "priced", amountUsd, rateCard, provenance: Object.freeze({ ...pricing.provenance }) });
}
export function computeCost(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning: number; promptTokens?: number },
  cost: ModelCost,
  fallbacks: CacheRateFallbacks,
): number {
  const totalPrompt = tokens.promptTokens ?? (tokens.input + tokens.cacheRead + tokens.cacheWrite);
  const rates = cost.highContext !== undefined && totalPrompt > cost.highContext.threshold
    ? cost.highContext
    : cost;
  const inputRate = rates.input;
  const outputRate = rates.output;
  const cacheReadRate = rates.cacheRead ?? inputRate * fallbacks.cacheReadRatio;
  const cacheWriteRate = rates.cacheWrite ?? inputRate * fallbacks.cacheWriteRatio;
  // Anthropic charges 2x base input for 1h cache writes; models.dev's
  // cacheWrite rate covers only the default 5m retention (pi
  // `models.ts:650-656`). `cacheWrite1h` is a subset of `cacheWrite`.
  const write1h = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
  const write5m = tokens.cacheWrite - write1h;
  return (
    (tokens.input * inputRate +
      tokens.output * outputRate +
      tokens.cacheRead * cacheReadRate +
      write5m * cacheWriteRate +
      write1h * inputRate * 2) /
    1_000_000
  );
}

interface ModelInfoCache {
  resolveModelInfo(model: string): Promise<ModelInfo | null>;
  getCached(): { model: string; info: ModelInfo } | null;
  contextLimit(info?: ModelInfo | null): number;
}

export function createModelInfoCache(
  selected: { readonly model: string; readonly info: ModelInfo | null },
): ModelInfoCache {
  const cache = selected.info === null ? null : { model: selected.model, info: selected.info };

  return {
    async resolveModelInfo(model: string): Promise<ModelInfo | null> {
      if (cache?.model === model) return cache.info;
      return selected.info;
    },
    getCached() {
      return cache;
    },
    contextLimit(info) {
      const resolvedInfo = info === undefined ? cache?.info ?? null : info;
      if (!resolvedInfo) throw new Error("Model info unavailable; call resolveModelInfo() before accessing contextLimit");
      return resolvedInfo.contextLimit;
    },
  };
}
