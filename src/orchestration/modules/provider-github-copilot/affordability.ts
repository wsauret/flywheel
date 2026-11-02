import type { CatalogJsonValue } from "../../../infra/llm/model-catalog-resolution.js";
import { copilotRequestInitiator } from "./headers.js";
import type { ProviderAffordabilityCapability, ProviderAffordabilityDecision, ProviderAffordabilityEvaluation } from "../../agent-runtime/llm/provider-affordability.js";

interface PriceTier {
  readonly inputPrice: number;
  readonly cachePrice: number;
  readonly outputPrice: number;
  readonly contextMax?: number;
}

interface TokenPrices {
  readonly batchSize: number;
  readonly default: PriceTier;
  readonly longContext?: PriceTier;
}

interface CopilotBilling {
  readonly multiplier?: number;
  readonly tokenPrices?: TokenPrices;
}

interface CatalogFields {
  readonly [key: string]: CatalogJsonValue;
}

function record(value: CatalogJsonValue | undefined): value is CatalogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: CatalogJsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positive(value: CatalogJsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function priceTier(value: CatalogJsonValue | undefined): PriceTier | undefined {
  if (!record(value)) return undefined;
  const source = value;
  const inputPrice = finiteNonNegative(source.inputPrice);
  const cachePrice = finiteNonNegative(source.cachePrice);
  const outputPrice = finiteNonNegative(source.outputPrice);
  if (inputPrice === undefined || cachePrice === undefined || outputPrice === undefined) return undefined;
  const contextMax = source.contextMax === undefined ? undefined : positive(source.contextMax);
  if (source.contextMax !== undefined && contextMax === undefined) return undefined;
  return { inputPrice, cachePrice, outputPrice, ...(contextMax === undefined ? {} : { contextMax }) };
}

function billing(metadata: CatalogJsonValue | undefined): CopilotBilling | undefined {
  if (!record(metadata) || !record(metadata.billing)) return undefined;
  const source = metadata.billing;
  const multiplier = finiteNonNegative(source.multiplier);
  const prices = source.tokenPrices;
  if (!record(prices) && prices !== undefined) return undefined;
  const batchSize = positive(prices?.batchSize);
  const defaultTier = priceTier(prices?.default);
  const longContext = prices?.longContext === undefined ? undefined : priceTier(prices.longContext);
  const tokenPrices = batchSize !== undefined && defaultTier !== undefined
    && (prices?.longContext === undefined || longContext !== undefined)
    ? { batchSize, default: defaultTier, ...(longContext === undefined ? {} : { longContext }) }
    : undefined;
  if (multiplier === undefined && tokenPrices === undefined) return undefined;
  return { ...(multiplier === undefined ? {} : { multiplier }), ...(tokenPrices === undefined ? {} : { tokenPrices }) };
}

function inputPrices(prices: TokenPrices, promptTokens: number): PriceTier | undefined {
  if (prices.default.contextMax === undefined || promptTokens <= prices.default.contextMax) return prices.default;
  if (prices.longContext === undefined) return undefined;
  return prices.longContext.contextMax === undefined || promptTokens <= prices.longContext.contextMax
    ? prices.longContext
    : undefined;
}

export const copilotAffordability: ProviderAffordabilityCapability = Object.freeze({
  async evaluate({ attribution, admission, request }: ProviderAffordabilityEvaluation): Promise<ProviderAffordabilityDecision> {
    if (attribution.candidate.spendMode !== "included" || attribution.catalogProvenance !== "live") return { kind: "eligible" };
    const allowance = admission.subscriptionAllowanceFor?.(attribution.candidate);
    if (allowance?.allowance !== "finite" || allowance.freshness !== "fresh"
      || allowance.remaining === undefined || allowance.metric === undefined) return { kind: "eligible" };
    const modelBilling = billing(attribution.catalogMetadata);
    if (!modelBilling) return { kind: "eligible" };

    if (allowance.metric === "premium_interactions") {
      const multiplier = modelBilling.multiplier;
      if (multiplier === undefined || copilotRequestInitiator(request.messages) === "agent" || allowance.remaining >= multiplier) {
        return { kind: "eligible" };
      }
      return { kind: "unaffordable", detail: `Copilot needs ${multiplier} premium interactions but ${allowance.remaining} remain.` };
    }

    const prices = modelBilling.tokenPrices;
    const uncached = request.tokenClasses.estimatedUncachedInputTokens;
    const cached = request.tokenClasses.estimatedCacheTokens;
    if (prices === undefined || uncached === undefined || cached === undefined
      || !Number.isFinite(uncached) || uncached < 0 || !Number.isFinite(cached) || cached < 0) return { kind: "eligible" };
    const tier = inputPrices(prices, uncached + cached);
    if (!tier) return { kind: "eligible" };
    const unavoidable = (uncached * tier.inputPrice + cached * tier.cachePrice) / prices.batchSize;
    return unavoidable > allowance.remaining
      ? { kind: "unaffordable", detail: `Copilot needs ${unavoidable} AI Credits for the prepared input but ${allowance.remaining} remain.` }
      : { kind: "eligible" };
  },
});
