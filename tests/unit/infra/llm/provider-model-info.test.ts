import { describe, expect, test } from "bun:test";
import type { CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js";
import type { ModelPricing } from "../../../../src/infra/llm/models.js";
import { enrichProviderModelInfo, fillCatalogRouteModelInfos, mergeRouteModelInfos, providerModelInfo, sharedModelInfos } from "../../../../src/infra/llm/provider-model-info.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";

const priced = (provider: string, input: number, output: number): ModelPricing => ({
  status: "available",
  rateCard: { input, output },
  provenance: { source: "provider-api", provider, model: "gpt-next" },
});

const offering = (wireModelId: string, resolvedMetadata?: ReturnType<typeof providerModelInfo>): CatalogModelOffering => ({
  wireModelId,
  metadata: null,
  dataUse: "standard",
  ...(resolvedMetadata === undefined ? {} : { resolvedMetadata }),
});

describe("shared model metadata", () => {
  test("keeps a model whose routes disagree and takes each field from the first route that states it", () => {
    const subscription = providerModelInfo({ provider: "openai", id: "gpt-next", reasoningEfforts: ["low", "high"], contextLimit: 400_000 });
    const aggregator = providerModelInfo({ provider: "openrouter", id: "gpt-next", pricing: priced("openrouter", 2, 10), contextLimit: 300_000, releaseDate: "2026-09-22" });

    const shared = sharedModelInfos([["gpt-next", [offering("gpt-next", subscription)]], ["gpt-next", [offering("openai/gpt-next", aggregator)]]]).get("gpt-next");

    expect(shared).toMatchObject({
      provider: "openai",
      reasoningEfforts: ["low", "high"],
      contextLimit: 400_000,
      cost: { input: 2, output: 10 },
      pricing: { status: "available", provenance: { provider: "openrouter" } },
      releaseDate: "2026-09-22",
    });
    expect(new Set(shared?.providerFields)).toEqual(new Set(["reasoningEfforts", "contextLimit", "pricing", "releaseDate"]));
  });

  test("prefers another route's catalog value over a route's runtime default", () => {
    const bare = providerModelInfo({ provider: "copilot", id: "claude-next" });
    const catalogFilled = enrichProviderModelInfo(
      providerModelInfo({ provider: "anthropic", id: "claude-next", contextLimit: 1_000_000 }),
      modelInfo("anthropic", "claude-next", "claude", 10, 50, "2026-08-28", { outputLimit: 128_000, knowledgeCutoff: "2026-01" }),
    );

    const shared = mergeRouteModelInfos([bare, catalogFilled]);

    expect(shared).toMatchObject({ family: "anthropic", cost: { input: 10, output: 50 }, outputLimit: 128_000, contextLimit: 1_000_000, releaseDate: "2026-08-28", knowledgeCutoff: "2026-01" });
    expect(shared.providerFields).toEqual(["contextLimit"]);
  });

  test("fills only the defaults of a route and keeps what its own provider and catalog state", () => {
    const shared = mergeRouteModelInfos([providerModelInfo({ provider: "anthropic", id: "claude-next", pricing: priced("anthropic", 10, 50), reasoningEfforts: ["low", "max"], outputLimit: 128_000 })]);
    const ownCatalog = enrichProviderModelInfo(
      providerModelInfo({ provider: "copilot", id: "claude-next", outputLimit: 64_000 }),
      modelInfo("openai", "claude-next", "claude", 0, 0, "2026-08-01"),
    );
    const catalog = new Map([
      ["claude-next", [offering("claude-next")]],
      ["claude-own", [offering("claude-own", ownCatalog)]],
    ]);

    const filled = fillCatalogRouteModelInfos(catalog, new Map([["claude-next", shared], ["claude-own", shared]]), "github-copilot");

    expect(filled.get("claude-next")?.[0]?.resolvedMetadata).toMatchObject({
      provider: "github-copilot",
      cost: { input: 10, output: 50 },
      reasoningEfforts: ["low", "max"],
      outputLimit: 128_000,
    });
    expect(filled.get("claude-own")?.[0]?.resolvedMetadata).toMatchObject({
      outputLimit: 64_000,
      cost: { input: 0, output: 0 },
      reasoningEfforts: ["low", "max"],
    });
  });

  test("leaves a model no source describes untouched", () => {
    const catalog = new Map([["unknown", [offering("unknown")]]]);
    expect(fillCatalogRouteModelInfos(catalog, new Map(), "copilot").get("unknown")?.[0]?.resolvedMetadata).toBeUndefined();
  });
});
