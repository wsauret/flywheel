import { expect, test } from "bun:test";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import type { CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";

const CANDIDATE = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const;
const ACCOUNT_KEY = accessProviderAccountKey(CANDIDATE);

test("preference mutations retain enriched canonical metadata and release dates", async () => {
  const resolvedMetadata = modelInfo("openai", "gpt-6.1-sol", "gpt", 1, 2, "2026-08-12");
  const releaseDate = resolvedMetadata.releaseDate;
  if (releaseDate === undefined) throw new Error("fixture release date is absent");
  const definition: AccessProviderDefinition = {
    id: "openrouter",
    displayName: "OpenRouter",
    shortName: "OpenRouter",
    rank: 1,
    supportedFamilies: ["openai"],
    configHints: [],
    catalogId: undefined,
    dynamicCatalog: {
      limits: TEST_CATALOG_LIMITS,
      extractRows: (body) => Array.isArray(body) ? body : [],
      canonicalize: (row) => typeof row === "object" && row !== null && "id" in row && row.id === "openai/gpt-6.1-sol"
        ? { modelId: row.id, wireModelId: row.id, metadata: { pricing: { prompt: 0.000_001 } } }
        : undefined,
      modelsDevCatalogIds: ["openrouter"],
      fetch: async ({ credential }) => ({ discovery: { kind: "rows", rows: [{ id: "openai/gpt-6.1-sol" }] }, credential }),
    },
    auth: { kind: "api_key", statusRank: 1 },
    cli: { name: "openrouter" },
    billing: "metered",
    spendMode: "aggregator",
  };
  const listing = createModelListingClient({
    classifySlot: () => definition.billing,
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([definition]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [{
        providerId: "openrouter",
        providerName: "OpenRouter",
        wireModelId: "openai/gpt-6.1-sol",
        dataUse: "standard",
        metadata: resolvedMetadata,
        provenance: "live",
        canonical: { providerId: "openai", modelId: "gpt-6.1-sol" },
        transport: { npm: "@openrouter/ai-sdk-provider" },
      }],
    },
  });
  const listed = await listing.getModelCatalogs({
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { openrouter: "key" } }),
    credentialLineages: { openrouter: "lineage" },
  }, { mode: "fresh" });
  const listedCandidate = listed.candidates.get(ACCOUNT_KEY);
  const canonicalOfferings = listedCandidate?.models;
  if (canonicalOfferings === null || canonicalOfferings === undefined) throw new Error("fresh canonical catalog is absent");
  expect(listedCandidate?.visibleModels).toBe(canonicalOfferings);
  const offering: CatalogModelOffering | undefined = canonicalOfferings.get("gpt-6.1-sol")?.[0];
  if (offering === undefined) throw new Error("fresh enriched offering is absent");
  const models = {
    catalog: new Set(["gpt-6.1-sol"]),
    curatedDefault: new Set(["gpt-6.1-sol"]),
    enabled: new Set<string>(),
    disabled: new Set<string>(),
    effective: new Set(["gpt-6.1-sol"]),
  };
  const service = createProviderModelPreferenceService({
    displayName: (id) => id,
    allowTrainingRoutes: () => false,
    persist: async () => "preferences-next",
    persistAllDeselected: async () => "preferences-next",
  });
  service.publish(service.prepare({
    profileId: "work",
    authRevision: "auth",
    preferenceRevision: "preferences",
    catalogs: new Map([["openrouter", models]]),
    accountCatalogs: new Map([[ACCOUNT_KEY, models]]),
    inventoryCandidates: new Map([[ACCOUNT_KEY, {
      candidate: CANDIDATE,
      configured: true,
      currentConnection: true,
      enabledOfferings: canonicalOfferings,
      inventoryOfferings: canonicalOfferings,
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
    }]]),
    releaseDates: new Map([["gpt-6.1-sol", releaseDate]]),
  }));

  await service.set({
    queriedProfileId: "work",
    queriedEligibilityRevision: 1,
    target: { kind: "singleton", providerId: "openrouter" },
    modelId: "gpt-6.1-sol",
    checked: false,
  });

  const retained = service.state()?.inventoryCandidates.get(ACCOUNT_KEY)?.inventoryOfferings?.get("gpt-6.1-sol")?.[0];
  expect(retained?.resolvedMetadata).toBe(resolvedMetadata);
  expect(retained?.metadata).toEqual(offering.metadata);
  expect(offering.metadata).toMatchObject({ releaseDate: "2026-08-12", pricing: { prompt: 0.000_001 } });
  expect(service.state()?.releaseDates.get("gpt-6.1-sol")).toBe("2026-08-12");
  await service.dispose();
});
