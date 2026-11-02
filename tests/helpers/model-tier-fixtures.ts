import type { ModelFamily } from "../../src/infra/llm/model-family.js";
import type { ModelInfo, ModelsClient } from "../../src/infra/llm/models.js";
import { canonicalCatalogModelId, canonicalModelId } from "../../src/infra/llm/model-id.js";

export const tierModelIds = {
  anthropic: {
    powerful: "claude-opus-4.6",
    mid: "claude-sonnet-4.6",
    cheap: "claude-haiku-4.5",
  },
  openai: {
    powerful: "gpt-5.5",
    mid: "gpt-5.4",
    cheap: "gpt-5-mini",
  },
  google: {
    powerful: "gemini-2.5-pro",
    mid: "gemini-2.5-pro",
    cheap: "gemini-2.5-flash",
  },
} as const;

export const tierAvailableModels = new Map<ModelFamily, ReadonlySet<string>>([
  ["anthropic", new Set([
    tierModelIds.anthropic.powerful,
    tierModelIds.anthropic.mid,
    tierModelIds.anthropic.cheap,
  ])],
  ["openai", new Set([
    tierModelIds.openai.powerful,
    tierModelIds.openai.mid,
    tierModelIds.openai.cheap,
    "gpt-5.5-pro",
    "gpt-5-nano",
    "gpt-5.3-chat-latest",
    "gpt-4.1",
    "gpt-4o",
  ])],
  ["google", new Set([
    tierModelIds.google.powerful,
    tierModelIds.google.mid,
    tierModelIds.google.cheap,
  ])],
]);

export const fakeModelInfos = new Map<string, ModelInfo>(Object.entries({
  "gpt-6-luna": modelInfo("openai", "gpt-6-luna", "gpt-luna", 2, 10, "2026-08-01"),
  "gpt-6-astra": modelInfo("openai", "gpt-6-astra", "gpt-astra", 2, 10, "2026-09-01"),
  "gpt-6.1-sol": modelInfo("openai", "gpt-6.1-sol", "gpt-sol", 2, 10, "2026-09-01"),
  "claude-opus-4-7": modelInfo("anthropic", "claude-opus-4-7", "claude-opus", 5, 25, "2026-03-01"),
  "claude-opus-4-6": modelInfo("anthropic", "claude-opus-4-6", "claude-opus", 5, 25, "2026-02-04"),
  "claude-sonnet-4-6": modelInfo("anthropic", "claude-sonnet-4-6", "claude-sonnet", 3, 15, "2026-02-05"),
  "claude-haiku-4-5": modelInfo("anthropic", "claude-haiku-4-5", "claude-haiku", 1, 5, "2026-02-05"),
  "gpt-5.5": modelInfo("openai", "gpt-5.5", "gpt", 5, 30, "2026-04-01"),
  "gpt-5.5-pro": modelInfo("openai", "gpt-5.5-pro", "gpt-pro", 30, 180, "2026-04-01"),
  "gpt-5.4": modelInfo("openai", "gpt-5.4", "gpt", 2.5, 15, "2026-03-01"),
  "gpt-5.3-chat-latest": modelInfo("openai", "gpt-5.3-chat-latest", "gpt", 2.5, 15, "2026-02-15"),
  "gpt-5-mini": modelInfo("openai", "gpt-5-mini", "gpt-mini", 0.25, 2, "2026-02-05"),
  "gpt-5-nano": modelInfo("openai", "gpt-5-nano", "gpt-nano", 0.05, 0.4, "2026-02-05"),
  "gpt-4.1": modelInfo("openai", "gpt-4.1", "gpt", 2, 8, "2025-04-01"),
  "gpt-4o": modelInfo("openai", "gpt-4o", "gpt", 2.5, 10, "2024-08-01"),
  "moonshotai/kimi-k3": modelInfo("openai", "moonshotai/kimi-k3", "kimi", 0.6, 3, "2026-08-01"),
  "grok-4": modelInfo("openai", "grok-4", "grok", 3, 15, "2026-01-01"),
  "gemini-2.5-pro": modelInfo("google", "gemini-2.5-pro", "gemini-pro", 1.25, 10, "2026-02-05"),
  "gemini-2.5-flash": modelInfo("google", "gemini-2.5-flash", "gemini-flash", 0.3, 2.5, "2026-02-05"),
  "gemini-2.5-flash-lite": modelInfo("google", "gemini-2.5-flash-lite", "gemini-flash-lite", 0.1, 0.4, "2026-02-05"),
}).map(([id, info]) => [canonicalModelId(id), info]));

export const fakeModelsClient = makeModelsClient(Object.fromEntries(fakeModelInfos));

export function makeModelsClient(models: { [model: string]: ModelInfo }): ModelsClient & { readonly modelInfos: ReadonlyMap<string, ModelInfo> } {
  const byCanonicalId = new Map(Object.entries(models).map(([model, info]) => [canonicalModelId(model), info]));
  return {
    modelInfos: byCanonicalId,
    async refresh() {},
    getProviderCatalog(providerIds) {
      return [...byCanonicalId.values()].flatMap((info) => {
        if (!providerIds.includes(info.provider)) return [];
        const npm = info.family === "anthropic"
          ? "@ai-sdk/anthropic"
          : info.family === "google" ? "@ai-sdk/google" : "@ai-sdk/openai";
        return [{
          providerId: info.provider,
          providerName: info.provider,
          wireModelId: info.id,
          dataUse: canonicalCatalogModelId(info.id).dataUse,
          metadata: info,
          provenance: "bundled" as const,
          canonical: { providerId: info.provider, modelId: info.id },
          transport: { npm },
        }];
      });
    },
    getTokenizerIdentity() {
      return undefined;
    },
  };
}

export function modelInfo(
  provider: ModelFamily,
  id: string,
  modelFamily: string,
  inputCost: number,
  outputCost: number,
  releaseDate: string,
  overrides: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    provider,
    family: provider,
    id,
    name: id,
    modelFamily,
    releaseDate,
    lastUpdated: releaseDate,
    openWeights: false,
    reasoning: true,
    toolCall: true,
    attachment: true,
    temperature: true,
    contextLimit: 200_000,
    outputLimit: 8_192,
    cost: { input: inputCost, output: outputCost },
    pricing: {
      status: "available",
      rateCard: { input: inputCost, output: outputCost },
      provenance: { source: "models.dev", catalog: "bundled", provider, model: id },
    },
    modalities: { input: ["text"], output: ["text"] },
    ...overrides,
  };
}
