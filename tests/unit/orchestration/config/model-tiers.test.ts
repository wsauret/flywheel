import { describe, test, expect } from "bun:test";
import {
  recommendedModelsForFamily,
  resolveModelForTier,
  resolveModelForTierAcrossFamilies,
  resolveModelTier,
} from "../../../../src/orchestration/config/model-tiers.js";
import { modelTierForReference } from "../../../../src/protocol/model-tier-reference.js";
import { fakeModelInfos, makeModelsClient, modelInfo, tierAvailableModels, tierModelIds } from "../../../helpers/model-tier-fixtures.js";

const tierOptions = { userDataRoot: "/scratch", modelInfos: fakeModelInfos };
const anthropicAvailable = tierAvailableModels.get("anthropic")!;
const openaiAvailable = tierAvailableModels.get("openai")!;
const googleAvailable = tierAvailableModels.get("google")!;

describe("resolveModelTier", () => {
  test("resolves tier aliases through the dynamic catalog", async () => {
    expect(modelTierForReference(undefined)).toBeUndefined();
    expect(modelTierForReference("powerful")).toBe("powerful");
    expect(await resolveModelTier("powerful", "openai", openaiAvailable, tierOptions)).toBe(tierModelIds.openai.powerful);
    expect(await resolveModelTier("mid", "google", googleAvailable, tierOptions)).toBe(tierModelIds.google.mid);
    expect(await resolveModelTier("cheap", "anthropic", anthropicAvailable, tierOptions)).toBe(tierModelIds.anthropic.cheap);
    expect(await resolveModelTier("opus", "openai", openaiAvailable, tierOptions)).toBe(tierModelIds.openai.powerful);
    expect(await resolveModelTier("flash", "google", googleAvailable, tierOptions)).toBe(tierModelIds.google.mid);
  });

  test("passes explicit model IDs through unchanged without needing a catalog", async () => {
    expect(await resolveModelTier("claude-opus-4-7", "anthropic", undefined, tierOptions)).toBe("claude-opus-4-7");
    expect(await resolveModelTier("gpt-5.4", "openai", undefined, tierOptions)).toBe("gpt-5.4");
    expect(await resolveModelTier("my-custom-model-v2", "anthropic", undefined, tierOptions)).toBe("my-custom-model-v2");
  });

  test("requires provider availability for abstract tier resolution", async () => {
    await expect(resolveModelForTier("powerful", "anthropic", undefined, tierOptions)).rejects.toThrow("provider listing");
    await expect(resolveModelForTier("powerful", "anthropic", new Set(), tierOptions)).rejects.toThrow("provider listing");
  });
});

describe("dynamic tier catalog", () => {
  test("admits old models from source capability", async () => {
    const models = await recommendedModelsForFamily("openai", openaiAvailable, tierOptions);
    expect(models).toContain("gpt-5.4");
    expect(models).toContain("gpt-5-mini");
    expect(models).toContain("gpt-5-nano");
    expect(models).toContain("gpt-5.3-chat-latest");
    expect(models).toContain("gpt-4.1");
    expect(models).toContain("gpt-4o");
  });


  test("uses release dates only to sort recommendations", async () => {
    const client = makeModelsClient({
      "claude-opus-4-6": modelInfo("anthropic", "claude-opus-4-6", "claude-opus", 5, 25, "2026-02-04"),
      "claude-opus-4-5": modelInfo("anthropic", "claude-opus-4-5", "claude-opus", 5, 25, "2026-02-03"),
    });

    const models = await recommendedModelsForFamily("anthropic", new Set(["claude-opus-4-6", "claude-opus-4-5"]), {
      ...tierOptions,
      modelInfos: client.modelInfos,
    });

    expect(models).toEqual(["claude-opus-4.6", "claude-opus-4.5"]);
  });

  test("admits models without release dates", async () => {
    const client = makeModelsClient({
      "claude-opus-unknown": modelInfo("anthropic", "claude-opus-unknown", "claude-opus", 5, 25, "2026-03-01", {
        releaseDate: undefined,
        lastUpdated: "2026-08-01",
      }),
    });

    const models = await recommendedModelsForFamily("anthropic", new Set(["claude-opus-unknown"]), {
      ...tierOptions,
      modelInfos: client.modelInfos,
    });

    expect(models).toEqual(["claude-opus-unknown"]);
  });

  test("filters models that lack tool calls or text output", async () => {
    const client = makeModelsClient({
      "gpt-6": modelInfo("openai", "gpt-6", "gpt", 4, 20, "2026-03-01"),
      "gpt-6-no-tools": modelInfo("openai", "gpt-6-no-tools", "gpt", 4, 20, "2026-03-01", { toolCall: false }),
      "gpt-6-audio": modelInfo("openai", "gpt-6-audio", "gpt", 4, 20, "2026-03-01", { modalities: { input: ["text"], output: ["audio"] } }),
    });
    const models = await recommendedModelsForFamily("openai", new Set(["gpt-6", "gpt-6-no-tools", "gpt-6-audio"]), { ...tierOptions, modelInfos: client.modelInfos });
    expect(models).toEqual(["gpt-6"]);
  });

  test("resolves unpriced custom models by stable id only after every ranked tier is empty", async () => {
    const custom = new Set(["fixture-model-small", "fixture-model"]);
    for (const tier of ["powerful", "mid", "cheap"] as const) {
      expect(await resolveModelForTier(tier, "openai", custom, tierOptions)).toBe("fixture-model");
      expect(await resolveModelForTier(tier, "openai", new Set([...custom, ...openaiAvailable]), tierOptions)).toBe(await resolveModelForTier(tier, "openai", openaiAvailable, tierOptions));
    }
  });

  test("selects the newest model across families without leaving a populated requested tier", async () => {
    const client = makeModelsClient({
      "older-mid": modelInfo("anthropic", "older-mid", "fixture", 3, 15, "2026-05-01"),
      "newer-mid": modelInfo("openai", "newer-mid", "fixture", 2, 10, "2026-09-01"),
      "newest-powerful": modelInfo("openai", "newest-powerful", "fixture", 5, 25, "2026-10-01"),
    });
    const available = new Map([
      ["anthropic", new Set(["older-mid"])],
      ["openai", new Set(["newer-mid", "newest-powerful"])],
    ] as const);
    expect(await resolveModelForTierAcrossFamilies("mid", available, { ...tierOptions, modelInfos: client.modelInfos }))
      .toEqual({ family: "openai", model: "newer-mid" });
  });

  test("uses cheap before powerful only when mid is empty, even across families", async () => {
    const client = makeModelsClient({
      "cheap": modelInfo("openai", "cheap", "fixture", 1, 5, "2026-05-01"),
      "powerful": modelInfo("anthropic", "powerful", "fixture", 4, 20, "2026-10-01"),
    });
    const available = new Map([
      ["anthropic", new Set(["powerful"])],
      ["openai", new Set(["cheap", "unpriced-custom"])],
    ] as const);
    expect(await resolveModelForTierAcrossFamilies("mid", available, { ...tierOptions, modelInfos: client.modelInfos }))
      .toEqual({ family: "openai", model: "cheap" });
  });

  test("orders unranked models across families by known date then stable id", async () => {
    const client = makeModelsClient({
      "older-custom": modelInfo("anthropic", "older-custom", "fixture", 0, 0, "2026-05-01", { pricing: { status: "unavailable", reason: "missing-rate-card" } }),
      "newer-custom": modelInfo("openai", "newer-custom", "fixture", 0, 0, "2026-09-01", { pricing: { status: "unavailable", reason: "missing-rate-card" } }),
    });
    const available = new Map([
      ["anthropic", new Set(["older-custom", "z-custom"])],
      ["openai", new Set(["newer-custom", "a-custom"])],
    ] as const);
    const options = { ...tierOptions, modelInfos: client.modelInfos };
    expect(await resolveModelForTierAcrossFamilies("mid", available, options)).toEqual({ family: "openai", model: "newer-custom" });
    const undescribed = new Map([
      ["anthropic", new Set(["z-custom"])],
      ["openai", new Set(["a-custom"])],
    ] as const);
    expect(await resolveModelForTierAcrossFamilies("mid", undescribed, options)).toEqual({ family: "openai", model: "a-custom" });
    expect(await resolveModelForTierAcrossFamilies("mid", new Map([["openai", new Set(["a-custom"])]]), options))
      .toEqual({ family: "openai", model: "a-custom" });
  });

  test("dedupes dated snapshots when the stable alias is also listed", async () => {
    const client = makeModelsClient({
      "gpt-5.5": modelInfo("openai", "gpt-5.5", "gpt", 5, 30, "2026-04-23"),
    });
    const models = await recommendedModelsForFamily("openai", new Set(["gpt-5.5", "gpt-5.5-2026-04-23"]), { ...tierOptions, modelInfos: client.modelInfos });
    expect(models).toEqual(["gpt-5.5"]);
  });

  test("uses canonical model metadata for a dated snapshot identity", async () => {
    const client = makeModelsClient({
      "gpt-5.5": modelInfo("openai", "gpt-5.5", "gpt", 5, 30, "2026-04-23"),
    });
    await expect(resolveModelForTier("powerful", "openai", new Set(["gpt-5.5-2026-04-23"]), { ...tierOptions, modelInfos: client.modelInfos }))
      .resolves.toBe("gpt-5.5");
  });

  test("uses provider-local price only for unknown semantic families", async () => {
    const client = makeModelsClient({
      "learnlm-low": modelInfo("google", "learnlm-low", "learnlm", 0.1, 0.4, "2026-03-01"),
      "learnlm-cheap-high": modelInfo("google", "learnlm-cheap-high", "learnlm", 1, 4, "2026-03-01"),
      "learnlm-mid": modelInfo("google", "learnlm-mid", "learnlm", 1.1, 4, "2026-03-01"),
      "learnlm-high": modelInfo("google", "learnlm-high", "learnlm", 10, 40, "2026-03-01"),
    });
    const available = new Set(["learnlm-low", "learnlm-cheap-high", "learnlm-mid", "learnlm-high"]);
    expect(await resolveModelForTier("cheap", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-low");
    expect(await resolveModelForTier("mid", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-mid");
    expect(await resolveModelForTier("powerful", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-high");
  });

  test("classifies input prices at or above $4 as powerful", async () => {
    const client = makeModelsClient({
      "learnlm-below-powerful": modelInfo("google", "learnlm-below-powerful", "learnlm", 3.99, 12, "2026-03-01"),
      "learnlm-at-powerful": modelInfo("google", "learnlm-at-powerful", "learnlm", 4, 12, "2026-03-01"),
    });
    const available = new Set(["learnlm-below-powerful", "learnlm-at-powerful"]);

    expect(await resolveModelForTier("mid", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-below-powerful");
    expect(await resolveModelForTier("powerful", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-at-powerful");
  });

  test("prefers lower input cost when release dates match", async () => {
    const available = new Set(["gpt-5.5", "gpt-5.5-pro"]);
    expect(await resolveModelForTier("powerful", "openai", available, tierOptions)).toBe("gpt-5.5");
  });

  test("catalogs every OpenRouter slash id", async () => {
    const client = makeModelsClient({
      "moonshotai/kimi-k3": modelInfo("openai", "moonshotai/kimi-k3", "kimi", 1.2, 5, "2026-05-01"),
      "openai/gpt-6-astra": modelInfo("openai", "openai/gpt-6-astra", "gpt", 2, 10, "2026-05-01"),
    });
    const models = await recommendedModelsForFamily(
      "openai",
      new Set(["moonshotai/kimi-k3", "openai/gpt-6-astra"]),
      { ...tierOptions, modelInfos: client.modelInfos },
    );
    expect(models).toEqual(["moonshotai/kimi-k3", "openai/gpt-6-astra"]);
  });
});

describe("selected route rank", () => {
  test("does not use collapsed metadata for a selected exact wire", async () => {
    const calls: string[] = [];
    const modelsClient = makeModelsClient({
      "model-contributor": modelInfo("openai", "model-contributor", "model", 7, 20, "2026-08-01"),
    });
    const ranks = await import("../../../../src/orchestration/config/model-tiers.js").then(({ resolveSelectedRouteRanks }) =>
      resolveSelectedRouteRanks([{
        key: "selected",
        wireModelId: "model-contributor",
        providerHint: "gateway",
      }], {
        userDataRoot: "/scratch/flywheel-test",
        modelInfos: new Map([["model-contributor", {
          ...modelsClient.modelInfos.get("model-contributor")!,
          cost: { input: 7, output: 20, cacheRead: 0.7 },
        }]]),
      }));

    expect(ranks.get("selected")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("uses metadata from each selected provider route for a shared canonical model", async () => {
    const lowerCost = modelInfo("openai", "provider-a/shared-model", "shared", 1, 4, "2026-08-01");
    const higherCost = modelInfo("openai", "provider-b/shared-model", "shared", 8, 24, "2026-08-01");
    const { resolveSelectedRouteRanks } = await import("../../../../src/orchestration/config/model-tiers.js");

    const ranks = await resolveSelectedRouteRanks([
      { key: "provider-a:shared-model", wireModelId: "provider-a/shared-model", providerHint: "provider-a", metadata: lowerCost },
      { key: "provider-b:shared-model", wireModelId: "provider-b/shared-model", providerHint: "provider-b", metadata: higherCost },
    ], { userDataRoot: "/scratch/flywheel-test" });

    expect(ranks.get("provider-a:shared-model")).toMatchObject({ cost: { input: 1, output: 4 } });
    expect(ranks.get("provider-b:shared-model")).toMatchObject({ cost: { input: 8, output: 24 } });
  });
});
