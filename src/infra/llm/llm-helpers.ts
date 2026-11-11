/**
 * Shared helpers for LLM provider adapters.
 *
 * Consolidates the model-info caching and cost calculation logic that
 * is structurally identical across Anthropic and OpenAI adapters,
 * differing only in provider hint and default cache rate ratios.
 */

import type { ModelCost, ModelInfo, ModelPricing, ModelPricingProvenance, NormalizedModelCostTier, NormalizedModelRateCard } from "./models.js";

/** The cache rates that a provider states as ratios of the input rate, for a rate card that omits them. Without a
 *  one-hour ratio, one-hour cache writes price at the card's cache-write rate. */
interface CacheRateFallbacks {
  cacheReadRatio: number;
  cacheWriteRatio: number;
  cacheWrite1hRatio?: number;
}

export type UsagePriceResult =
  | { readonly status: "priced"; readonly amountUsd: number; readonly rateCard: NormalizedModelRateCard; readonly provenance: ModelPricingProvenance }
  | { readonly status: "unavailable"; readonly reason: "missing-rate-card" };

function normalizeTier(tier: ModelCost, fallbacks: CacheRateFallbacks): NormalizedModelCostTier {
  const cacheWrite = tier.cacheWrite ?? tier.input * fallbacks.cacheWriteRatio;
  return Object.freeze({
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead ?? tier.input * fallbacks.cacheReadRatio,
    cacheWrite,
    cacheWrite1h: fallbacks.cacheWrite1hRatio === undefined ? cacheWrite : tier.input * fallbacks.cacheWrite1hRatio,
    reasoning: tier.reasoning ?? tier.output,
  });
}

/** Prices one request's normalized usage against a rate card. `output` includes `reasoning` (ARCH-PROVIDERS-076),
 *  so reasoning tokens are charged once, as a part of output, at the reasoning rate. */
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
    + (tokens.output - tokens.reasoning) * rates.output
    + tokens.reasoning * rates.reasoning
    + tokens.cacheRead * rates.cacheRead
    + (tokens.cacheWrite - write1h) * rates.cacheWrite
    + write1h * rates.cacheWrite1h
  ) / 1_000_000;
  return Object.freeze({ status: "priced", amountUsd, rateCard, provenance: Object.freeze({ ...pricing.provenance }) });
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
