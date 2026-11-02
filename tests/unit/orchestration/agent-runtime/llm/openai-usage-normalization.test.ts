import { describe, expect, test } from "bun:test";
import { cacheWriteTokens } from "../../../../../src/orchestration/agent-runtime/llm/openai-usage-normalization.js";

describe("OpenAI cache-write usage normalization", () => {
  test("accepts only non-negative safe integers from provider extension fields", () => {
    expect(cacheWriteTokens({ cache_write_tokens: 300 })).toBe(300);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "300", null, undefined]) {
      expect(cacheWriteTokens({ cache_write_tokens: value })).toBe(0);
    }
    expect(cacheWriteTokens(undefined)).toBe(0);
    expect(cacheWriteTokens({})).toBe(0);
  });
});
