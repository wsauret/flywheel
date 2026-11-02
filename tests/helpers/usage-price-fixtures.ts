import type { UsagePriceResult } from "../../src/infra/llm/llm-helpers.js";

const provenance = Object.freeze({
  source: "models.dev" as const,
  catalog: "bundled" as const,
  provider: "test-provider",
  model: "test-model",
});

export function pricedUsage(perTokenUsd: number, tokens: { input: number; output?: number }): UsagePriceResult {
  const perMillionUsd = perTokenUsd * 1_000_000;
  const standard = Object.freeze({
    input: perMillionUsd,
    output: perMillionUsd,
    cacheRead: perMillionUsd,
    cacheWrite: perMillionUsd,
    cacheWrite1h: perMillionUsd,
    reasoning: perMillionUsd,
  });
  return Object.freeze({
    status: "priced",
    amountUsd: (tokens.input + (tokens.output ?? 0)) * perTokenUsd,
    rateCard: Object.freeze({ standard }),
    provenance,
  });
}
