import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { clampReasoningEffort, supportsAdaptiveThinking, supportsReasoningOff } from "../../../../../src/orchestration/agent-runtime/llm/model-compat.js";

const baseModelInfo = {
  provider: "anthropic",
  family: "anthropic",
  id: "claude-test",
  name: "Claude Test",
  openWeights: false,
  reasoning: true,
  toolCall: true,
  attachment: true,
  temperature: true,
  contextLimit: 200_000,
  outputLimit: 64_000,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
} satisfies ModelInfo;

function modelInfo(releaseDate: string): ModelInfo {
  return { ...baseModelInfo, releaseDate };
}

function withEfforts(reasoningEfforts: ModelInfo["reasoningEfforts"]): ModelInfo {
  return { ...baseModelInfo, ...(reasoningEfforts ? { reasoningEfforts } : {}) };
}

describe("supportsAdaptiveThinking", () => {
  it("uses release date as the adaptive-thinking boundary", () => {
    expect(supportsAdaptiveThinking("claude-fable-5", modelInfo("2026-01-31"))).toBe(false);
    expect(supportsAdaptiveThinking("claude-fable-5", modelInfo("2026-02-01"))).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-20250514", modelInfo("2025-05-14"))).toBe(false);
    expect(supportsAdaptiveThinking("gpt-5", modelInfo("2026-02-01"))).toBe(false);
  });

  it("keeps metadata-less legacy Claude models on budget-based thinking", () => {
    expect(supportsAdaptiveThinking("claude-3-7-sonnet-20250219")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-20250514")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("defaults metadata-less future Claude models to adaptive thinking", () => {
    expect(supportsAdaptiveThinking("claude-fable-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(supportsAdaptiveThinking("gpt-5")).toBe(false);
  });

  it("marks the OpenCode Go qwen family adaptive (the budget shape 400s on qwen3.8-max)", () => {
    expect(supportsAdaptiveThinking("qwen3.7-max")).toBe(true);
    expect(supportsAdaptiveThinking("qwen3.8-max")).toBe(true);
    expect(supportsAdaptiveThinking("qwen3.5-plus")).toBe(true);
  });
});

describe("clampReasoningEffort", () => {
  it("passes declared tiers through", () => {
    const info = withEfforts(["low", "medium", "high", "xhigh", "max"]);
    expect(clampReasoningEffort("max", info, ["low", "medium", "high"])).toBe("max");
    expect(clampReasoningEffort("low", info, ["low", "medium", "high"])).toBe("low");
  });

  it("resolves an undeclared tier to the nearest declared one, rounding ties up", () => {
    // Opus 4.6 shape: max declared, xhigh not -- xhigh upgrades to max.
    const opus46 = withEfforts(["low", "medium", "high", "max"]);
    expect(clampReasoningEffort("xhigh", opus46, ["low", "medium", "high"])).toBe("max");
    // gpt-5.1 shape: nothing above high -- xhigh and max clamp down.
    const gpt51 = withEfforts(["none", "low", "medium", "high"]);
    expect(clampReasoningEffort("xhigh", gpt51, ["low", "medium", "high", "xhigh"])).toBe("high");
    expect(clampReasoningEffort("max", gpt51, ["low", "medium", "high", "xhigh"])).toBe("high");
  });

  it("uses the fallback set when the model declares nothing", () => {
    expect(clampReasoningEffort("max", null, ["low", "medium", "high"])).toBe("high");
    expect(clampReasoningEffort("max", withEfforts(undefined), ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampReasoningEffort("medium", null, ["low", "medium", "high"])).toBe("medium");
  });

  it("ignores a declared off tier when clamping", () => {
    const info = withEfforts(["none", "low"]);
    expect(clampReasoningEffort("high", info, ["low", "medium", "high"])).toBe("low");
  });
});

describe("supportsReasoningOff", () => {
  it("requires a declared off tier", () => {
    expect(supportsReasoningOff(withEfforts(["none", "low", "medium", "high"]))).toBe(true);
    expect(supportsReasoningOff(withEfforts(["low", "medium", "high"]))).toBe(false);
    expect(supportsReasoningOff(withEfforts(undefined))).toBe(false);
    expect(supportsReasoningOff(null)).toBe(false);
  });
});
