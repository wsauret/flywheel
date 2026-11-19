import { describe, test, expect } from "bun:test";
import {
  modelPowerSortRank,
  resolveModelForTierAcrossFamilies,
  type TierResolutionOptions,
} from "../../../../src/orchestration/config/model-tiers.js";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import { modelTierForReference } from "../../../../src/protocol/model-tier-reference.js";
import { fakeModelInfos, makeModelsClient, modelInfo, tierAvailableModels, tierModelIds } from "../../../helpers/model-tier-fixtures.js";

const tierOptions = { userDataRoot: "/scratch", modelInfos: fakeModelInfos };
const anthropicAvailable = tierAvailableModels.get("anthropic")!;
const openaiAvailable = tierAvailableModels.get("openai")!;
const googleAvailable = tierAvailableModels.get("google")!;

/** The model that tier resolution picks when the provider listing names `available` in one family alone. */
async function resolveInFamily(tier: "powerful" | "mid" | "cheap", family: ModelFamily, available: ReadonlySet<string> | undefined, options: TierResolutionOptions): Promise<string> {
  return (await resolveModelForTierAcrossFamilies(tier, available === undefined ? undefined : new Map([[family, available]]), options)).model;
}

describe("tier resolution in one family", () => {
  test("resolves tier aliases through the dynamic catalog", async () => {
    expect(modelTierForReference(undefined)).toBeUndefined();
    expect(modelTierForReference("powerful")).toBe("powerful");
    expect(modelTierForReference("opus")).toBe("powerful");
    expect(modelTierForReference("flash")).toBe("mid");
    expect(await resolveInFamily("powerful", "openai", openaiAvailable, tierOptions)).toBe(tierModelIds.openai.powerful);
    expect(await resolveInFamily("mid", "google", googleAvailable, tierOptions)).toBe(tierModelIds.google.mid);
    expect(await resolveInFamily("cheap", "anthropic", anthropicAvailable, tierOptions)).toBe(tierModelIds.anthropic.cheap);
  });

  test("requires provider availability for abstract tier resolution", async () => {
    await expect(resolveInFamily("powerful", "anthropic", undefined, tierOptions)).rejects.toThrow("provider listing");
    await expect(resolveInFamily("powerful", "anthropic", new Set(), tierOptions)).rejects.toThrow("provider listing");
  });
});

describe("dynamic tier catalog", () => {
  test("admits old models from source capability", async () => {
    for (const model of ["gpt-5.4", "gpt-5-mini", "gpt-5-nano", "gpt-5.3-chat-latest", "gpt-4.1", "gpt-4o"]) {
      expect(await modelPowerSortRank("openai", model, openaiAvailable, tierOptions)).toBeDefined();
    }
  });


  test("uses release dates only to sort recommendations", async () => {
    const client = makeModelsClient({
      "claude-opus-4-6": modelInfo("anthropic", "claude-opus-4-6", "claude-opus", 5, 25, "2026-02-04"),
      "claude-opus-4-5": modelInfo("anthropic", "claude-opus-4-5", "claude-opus", 5, 25, "2026-02-03"),
    });

    const available = new Set(["claude-opus-4-6", "claude-opus-4-5"]);
    const options = { ...tierOptions, modelInfos: client.modelInfos };

    expect(await modelPowerSortRank("anthropic", "claude-opus-4-6", available, options)).toMatchObject({ tier: 0, index: 0 });
    expect(await modelPowerSortRank("anthropic", "claude-opus-4-5", available, options)).toMatchObject({ tier: 0, index: 1 });
  });

  test("admits models without release dates", async () => {
    const client = makeModelsClient({
      "claude-opus-unknown": modelInfo("anthropic", "claude-opus-unknown", "claude-opus", 5, 25, "2026-03-01", {
        releaseDate: undefined,
        lastUpdated: "2026-08-01",
      }),
    });

    const available = new Set(["claude-opus-unknown"]);

    expect(await modelPowerSortRank("anthropic", "claude-opus-unknown", available, { ...tierOptions, modelInfos: client.modelInfos })).toBeDefined();
  });

  test("filters models that lack tool calls or text output", async () => {
    const client = makeModelsClient({
      "gpt-6": modelInfo("openai", "gpt-6", "gpt", 4, 20, "2026-03-01"),
      "gpt-6-no-tools": modelInfo("openai", "gpt-6-no-tools", "gpt", 4, 20, "2026-03-01", { toolCall: false }),
      "gpt-6-audio": modelInfo("openai", "gpt-6-audio", "gpt", 4, 20, "2026-03-01", { modalities: { input: ["text"], output: ["audio"] } }),
    });
    const available = new Set(["gpt-6", "gpt-6-no-tools", "gpt-6-audio"]);
    const options = { ...tierOptions, modelInfos: client.modelInfos };
    expect(await modelPowerSortRank("openai", "gpt-6", available, options)).toBeDefined();
    expect(await modelPowerSortRank("openai", "gpt-6-no-tools", available, options)).toBeUndefined();
    expect(await modelPowerSortRank("openai", "gpt-6-audio", available, options)).toBeUndefined();
  });

  test("resolves unpriced custom models by stable id only after every ranked tier is empty", async () => {
    const custom = new Set(["fixture-model-small", "fixture-model"]);
    for (const tier of ["powerful", "mid", "cheap"] as const) {
      expect(await resolveInFamily(tier, "openai", custom, tierOptions)).toBe("fixture-model");
      expect(await resolveInFamily(tier, "openai", new Set([...custom, ...openaiAvailable]), tierOptions)).toBe(await resolveInFamily(tier, "openai", openaiAvailable, tierOptions));
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

  test("prefers a subscription-served model inside the requested tier and falls back to paid-only models", async () => {
    const client = makeModelsClient({
      "paid-newest-cheap": modelInfo("anthropic", "paid-newest-cheap", "fixture", 0.1, 0.4, "2026-10-01"),
      "paid-newer-cheap": modelInfo("openai", "paid-newer-cheap", "fixture", 0.2, 0.8, "2026-09-01"),
      "included-cheap": modelInfo("openai", "included-cheap", "fixture", 0.5, 2, "2026-05-01"),
      "included-mid": modelInfo("openai", "included-mid", "fixture", 2, 8, "2026-10-01"),
    });
    const available = new Map([
      ["anthropic", new Set(["paid-newest-cheap"])],
      ["openai", new Set(["paid-newer-cheap", "included-cheap", "included-mid"])],
    ] as const);
    const options = { ...tierOptions, modelInfos: client.modelInfos, includedModels: new Set(["included-cheap", "included-mid"]) };
    expect(await resolveModelForTierAcrossFamilies("cheap", available, options)).toEqual({ family: "openai", model: "included-cheap" });
    expect(await resolveModelForTierAcrossFamilies("cheap", available, { ...options, includedModels: new Set(["included-mid"]) }))
      .toEqual({ family: "anthropic", model: "paid-newest-cheap" });
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
    const available = new Set(["gpt-5.5", "gpt-5.5-2026-04-23"]);
    const options = { ...tierOptions, modelInfos: client.modelInfos };
    // A second catalog entry for the snapshot would rank the stable alias second.
    expect(await modelPowerSortRank("openai", "gpt-5.5", available, options)).toMatchObject({ index: 0 });
    expect(await resolveInFamily("powerful", "openai", available, options)).toBe("gpt-5.5");
  });

  test("uses canonical model metadata for a dated snapshot identity", async () => {
    const client = makeModelsClient({
      "gpt-5.5": modelInfo("openai", "gpt-5.5", "gpt", 5, 30, "2026-04-23"),
    });
    await expect(resolveInFamily("powerful", "openai", new Set(["gpt-5.5-2026-04-23"]), { ...tierOptions, modelInfos: client.modelInfos }))
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
    expect(await resolveInFamily("cheap", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-low");
    expect(await resolveInFamily("mid", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-mid");
    expect(await resolveInFamily("powerful", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-high");
  });

  test("classifies input prices at or above $4 as powerful", async () => {
    const client = makeModelsClient({
      "learnlm-below-powerful": modelInfo("google", "learnlm-below-powerful", "learnlm", 3.99, 12, "2026-03-01"),
      "learnlm-at-powerful": modelInfo("google", "learnlm-at-powerful", "learnlm", 4, 12, "2026-03-01"),
    });
    const available = new Set(["learnlm-below-powerful", "learnlm-at-powerful"]);

    expect(await resolveInFamily("mid", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-below-powerful");
    expect(await resolveInFamily("powerful", "google", available, { ...tierOptions, modelInfos: client.modelInfos })).toBe("learnlm-at-powerful");
  });

  test("prefers lower input cost when release dates match", async () => {
    const available = new Set(["gpt-5.5", "gpt-5.5-pro"]);
    expect(await resolveInFamily("powerful", "openai", available, tierOptions)).toBe("gpt-5.5");
  });

  test("catalogs every OpenRouter slash id", async () => {
    const client = makeModelsClient({
      "moonshotai/kimi-k3": modelInfo("openai", "moonshotai/kimi-k3", "kimi", 1.2, 5, "2026-05-01"),
      "openai/gpt-6-astra": modelInfo("openai", "openai/gpt-6-astra", "gpt", 2, 10, "2026-05-01"),
    });
    const available = new Set(["moonshotai/kimi-k3", "openai/gpt-6-astra"]);
    const options = { ...tierOptions, modelInfos: client.modelInfos };
    expect(await modelPowerSortRank("openai", "moonshotai/kimi-k3", available, options)).toBeDefined();
    expect(await modelPowerSortRank("openai", "openai/gpt-6-astra", available, options)).toBeDefined();
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
