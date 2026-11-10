import { describe, expect, it } from "bun:test";
import { computeUsagePrice } from "../../../../src/infra/llm/llm-helpers.js";
import type { ModelPricing } from "../../../../src/infra/llm/models.js";

const PRICING: ModelPricing = {
  status: "available",
  rateCard: {
    input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, reasoning: 80,
    highContext: { threshold: 272_000, input: 20, output: 70, cacheRead: 2, cacheWrite: 25, reasoning: 100 },
  },
  provenance: { source: "models.dev", catalog: "live", provider: "anthropic", model: "claude-test" },
};

// Output includes the reasoning tokens: 5,000 of the 10,000 output tokens are reasoning.
const TOKENS = { input: 100_000, output: 10_000, cacheRead: 20_000, cacheWrite: 30_000, cacheWrite1h: 10_000, reasoning: 5_000 };

describe("usage pricing", () => {
  it("returns the amount with an immutable normalized rate-card snapshot and provenance", () => {
    const result = computeUsagePrice(TOKENS, PRICING);

    expect(result).toEqual({
      status: "priced",
      amountUsd: 2.12,
      rateCard: {
        standard: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, reasoning: 80 },
        highContext: { input: 20, output: 70, cacheRead: 2, cacheWrite: 25, cacheWrite1h: 40, reasoning: 100 },
      },
      provenance: PRICING.provenance,
    });
    if (result.status !== "priced") throw new Error("expected priced usage");
    expect(Object.isFrozen(result.rateCard)).toBe(true);
    expect(Object.isFrozen(result.rateCard.standard)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
  });

  it("charges reasoning tokens once, as a part of output, at the output rate when the model states no reasoning rate", () => {
    const result = computeUsagePrice(
      { input: 0, output: 10_000, cacheRead: 0, cacheWrite: 0, reasoning: 9_000 },
      { status: "available", rateCard: { input: 10, output: 50 }, provenance: { source: "provider-docs", provider: "openai", model: "test" } },
    );

    expect(result).toMatchObject({ status: "priced", amountUsd: 0.5 });
  });

  it("preserves high-context, cache, 1h, output, and reasoning rates", () => {
    expect(computeUsagePrice({ ...TOKENS, promptTokens: 272_000 }, PRICING)).toMatchObject({ status: "priced", amountUsd: 2.12 });
    const result = computeUsagePrice({ ...TOKENS, promptTokens: 272_001 }, PRICING);

    expect(result.status).toBe("priced");
    if (result.status === "priced") expect(result.amountUsd).toBeCloseTo(3.79);
  });

  it("returns an explicit unavailable result without inventing a zero price", () => {
    expect(computeUsagePrice(TOKENS, { status: "unavailable", reason: "missing-rate-card" })).toEqual({
      status: "unavailable",
      reason: "missing-rate-card",
    });
  });
});
