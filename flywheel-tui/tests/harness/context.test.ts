import { describe, expect, it } from "bun:test";
import { estimateTokens, formatUsageStats, limitOutput } from "../../src/harness/context.js";
import { TRUNCATION_MARKER } from "../../src/worker/buffer.js";
import type { UsageInfo } from "../../src/harness/llm.js";

// ═══════════════════════════════════════════════════════════════════════════
// Output Truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("limitOutput", () => {
  it("returns short output unchanged", () => {
    const output = "hello world";
    expect(limitOutput(output)).toBe(output);
  });

  it("truncates output exceeding maxBytes", () => {
    const output = "x".repeat(200);
    const result = limitOutput(output, 100);

    expect(result.length).toBeLessThan(output.length);
    expect(result).toContain("truncated");
  });

  it("preserves first and last halves of long output", () => {
    const first = "AAAA".repeat(50);
    const middle = "BBBB".repeat(500);
    const last = "CCCC".repeat(50);
    const output = first + middle + last;

    const result = limitOutput(output, 500);

    expect(result).toContain("AAAA");
    expect(result).toContain("CCCC");
  });

  it("uses a truncation marker consistent with buffer.ts", () => {
    const output = "x".repeat(200);
    const result = limitOutput(output, 100);

    // The marker from buffer.ts should appear in the truncated output
    expect(result).toContain(TRUNCATION_MARKER.trim());
  });

  it("handles UTF-8 content without corruption", () => {
    const output = "Hello! ".repeat(100) + "Goodbye!";
    const result = limitOutput(output, 200);

    // Should not throw and should contain readable text
    expect(result).toContain("Hello!");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Token Estimation
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 characters", () => {
    const text = "a".repeat(100);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(25);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 chars / 4 = 0.75, ceil = 1
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("provides reasonable estimates for typical code", () => {
    const code = 'function hello() {\n  console.log("world");\n}';
    const tokens = estimateTokens(code);
    // ~47 chars, ~12 tokens — should be in reasonable ballpark
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Usage Stats Formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("formatUsageStats", () => {
  it("formats basic input/output tokens", () => {
    const usage: UsageInfo = { inputTokens: 1000, outputTokens: 500 };
    const result = formatUsageStats(usage);
    expect(result).toBe("tokens(input: 1000, output: 500)");
  });

  it("includes cache stats when present", () => {
    const usage: UsageInfo = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 200,
    };
    const result = formatUsageStats(usage);
    expect(result).toContain("cache_read: 800");
    expect(result).toContain("cache_create: 200");
  });

  it("omits cache stats when zero or undefined", () => {
    const usage: UsageInfo = { inputTokens: 100, outputTokens: 50 };
    const result = formatUsageStats(usage);
    expect(result).not.toContain("cache");
  });
});
