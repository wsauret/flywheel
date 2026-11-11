import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { clampReasoningEffort } from "../../../../../src/orchestration/agent-runtime/llm/model-compat.js";
import { buildOpenAIParams } from "../../../../../src/orchestration/agent-runtime/llm/openai-helpers.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const baseInfo = {
  provider: "openai",
  family: "openai",
  id: "gpt-test",
  name: "GPT Test",
  openWeights: false,
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: true,
  contextLimit: 200_000,
  outputLimit: 16_384,
  cost: { input: 1, output: 1 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
} satisfies ModelInfo;

function options(cacheRetention?: StreamOptions["cacheRetention"]): StreamOptions {
  return { messages: [], tools: [], systemPrompt: stableSystemPrompt(""), cacheRetention };
}

function params(effort: StreamOptions["reasoningEffort"], info: ModelInfo, accessProvider: "chatgpt" | "openai_api") {
  return buildOpenAIParams("gpt-test", [], undefined, [], accessProvider === "chatgpt", effort ?? "medium", info, options(), accessProvider);
}

describe("provider reasoning effort boundaries", () => {
  it("keeps minimal in provider metadata without adding it to user reasoning effort", () => {
    const info = { ...baseInfo, reasoningEfforts: ["none", "minimal", "low", "medium"] as const };
    expect(clampReasoningEffort("low", info, ["low", "medium", "high"])).toBe("low");
    expect(params("low", info, "openai_api").reasoning).toMatchObject({ effort: "low" });
  });

  it("maps user off to provider none and otherwise selects the lowest declared tier", () => {
    const info = { ...baseInfo, reasoningEfforts: ["none", "minimal", "medium", "high"] as const };
    expect(params("off", info, "openai_api").reasoning).toMatchObject({ effort: "none" });
    expect(params("low", info, "openai_api").reasoning).toMatchObject({ effort: "minimal" });
  });

  it("always requests encrypted reasoning for ChatGPT reasoning models", () => {
    const info = { ...baseInfo, reasoningEfforts: ["none", "minimal", "medium"] as const };
    expect(params("off", info, "chatgpt").include).toEqual(["reasoning.encrypted_content"]);
    expect(params("medium", info, "chatgpt").include).toEqual(["reasoning.encrypted_content"]);
  });

  it("sends provider-advertised ultra unchanged to ChatGPT Responses", () => {
    const info = { ...baseInfo, reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] as const };
    expect(params("ultra", info, "chatgpt").reasoning).toMatchObject({ effort: "ultra" });
  });

  it("sends prompt-cache options only to direct OpenAI models with positive cache-write cost", () => {
    const capable = { ...baseInfo, reasoning: false, cost: { ...baseInfo.cost, cacheWrite: 1 } };
    const incapable = { ...baseInfo, reasoning: false, cost: { ...baseInfo.cost, cacheWrite: 0 } };
    for (const cacheRetention of ["none", "1h", "in_memory"] as const) {
      const direct = buildOpenAIParams("gpt-test", [], undefined, [], false, "off", capable, options(cacheRetention), "openai_api");
      const chatgpt = buildOpenAIParams("gpt-test", [], undefined, [], true, "off", capable, options(cacheRetention), "chatgpt");
      const noWrite = buildOpenAIParams("gpt-test", [], undefined, [], false, "off", incapable, options(cacheRetention), "openai_api");
      // An uncached request opts out explicitly; a cached one asks for the provider default lifetime, so that the
      // response states it. A configured retention policy still goes out beside it.
      expect(direct.prompt_cache_options).toEqual(cacheRetention === "none" ? { mode: "explicit" } : { ttl: "30m" });
      expect(direct.prompt_cache_retention).toBe(cacheRetention === "in_memory" ? "in_memory" : undefined);
      expect(chatgpt).not.toHaveProperty("prompt_cache_options");
      expect(noWrite).not.toHaveProperty("prompt_cache_options");
      expect(noWrite.prompt_cache_retention).toBe(cacheRetention === "in_memory" ? "in_memory" : undefined);
    }
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
