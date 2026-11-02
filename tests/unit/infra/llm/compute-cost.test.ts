/**
 * computeCost pricing: the 1h cache-write split. Anthropic bills 1h-retention
 * cache writes at 2x base input while models.dev's cacheWrite rate covers only
 * the default 5m retention (1.25x). Port source: pi `models.ts:650-656`.
 */

import { describe, expect, it } from "bun:test";
import { computeCost } from "../../../../src/infra/llm/llm-helpers.js";
import type { ModelCost } from "../../../../src/infra/llm/models.js";

const ANTHROPIC_FALLBACKS = { cacheReadRatio: 0.1, cacheWriteRatio: 1.25 };

const COST: ModelCost = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
};

describe("computeCost 1h cache-write split", () => {
  it("prices 5m writes at the cacheWrite rate when no 1h split is reported", () => {
    const cost = computeCost(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, reasoning: 0 },
      COST,
      ANTHROPIC_FALLBACKS,
    );
    expect(cost).toBeCloseTo(12.5);
  });

  it("prices the 1h subset at 2x input and the remainder at the cacheWrite rate", () => {
    const cost = computeCost(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000, reasoning: 0 },
      COST,
      ANTHROPIC_FALLBACKS,
    );
    // 600k at 12.5/M + 400k at 2x10/M = 7.5 + 8 = 15.5
    expect(cost).toBeCloseTo(15.5);
  });

  it("clamps a 1h reading that exceeds the total write count", () => {
    const cost = computeCost(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 200_000, reasoning: 0 },
      COST,
      ANTHROPIC_FALLBACKS,
    );
    expect(cost).toBeCloseTo(2);
  });
});
