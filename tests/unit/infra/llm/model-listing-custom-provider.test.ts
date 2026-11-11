import { afterEach, expect, test } from "bun:test";
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js";
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { staticOfferingMap } from "../../../../src/infra/llm/model-listing-rows.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { testCapabilityModules, testProviderSelection } from "../../../helpers/provider-authority.js";
import { AUTH_DIR, AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());

afterEach(() => {
  installCustomProviders([]);
});

test("configured custom providers publish static singleton candidate catalogs described by their models.dev provider", async () => {
  installCustomProviders([{
    id: "local_llama",
    displayName: "Local Llama",
    baseUrl: "http://localhost:8080/v1",
    modelIds: new Set(["llama-3.3-70b", "gpt-4o", "local-contributor", "gpt-4o-contributor", "Vendor/Hosted-1.5"]),
    catalogId: "hosting",
    contextLimit: 128_000,
  }]);
  const hosted = modelInfo("openai", "vendor/Hosted-1.5", "hosted", 0.3, 1.2, "2026-08-01", { reasoning: true, reasoningEfforts: ["low", "high"], outputLimit: 64_000 });
  const catalogRequests: (readonly string[])[] = [];
  const modelsClient = {
    async refresh() {},
    getProviderCatalog(providerIds: readonly string[]) {
      catalogRequests.push(providerIds);
      return [{
        providerId: "hosting",
        providerName: "Hosting",
        wireModelId: "vendor/Hosted-1.5",
        metadata: hosted,
        provenance: "live" as const,
        canonical: { providerId: "hosting", modelId: "vendor/hosted-1.5" },
        transport: null,
      }];
    },
    getTokenizerIdentity() { return undefined; },
  };
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(async () => {
    fetchCalls += 1;
    throw new Error("custom provider listing must remain static");
  }, { preconnect: original.preconnect });
  try {
    const client = createModelListingClient({
      classifySlot,
      authDir: AUTH_DIR,
      providers: testProviderSelection(),
      captureSubscriptions: () => new Map(),
      modelsClient,
    });
    const candidate = { kind: "singleton", providerId: "local_llama", spendMode: "direct_api" } as const;
    const catalogs = await client.getModelCatalogs({
      ...AUTH_NONE,
      providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { local_llama: "local-key" } }),
    });

    expect(catalogs.providers.get("local_llama")).toEqual(new Set(["llama-3.3-70b", "gpt-4o", "local", "vendor/hosted-1.5"]));
    expect(catalogs.candidates.get(accessProviderAccountKey(candidate))).toEqual({
      candidate,
      models: new Map([
        ["llama-3.3-70b", [{ wireModelId: "llama-3.3-70b", metadata: null, dataUse: "standard", transport: "openai-completions" }]],
        ["gpt-4o", [
          { wireModelId: "gpt-4o", metadata: null, dataUse: "standard", transport: "openai-completions" },
          { wireModelId: "gpt-4o-contributor", metadata: null, dataUse: "contributor", transport: "openai-completions" },
        ]],
        ["local", [
          { wireModelId: "local-contributor", metadata: null, dataUse: "contributor", transport: "openai-completions" },
        ]],
        ["vendor/hosted-1.5", [
          { wireModelId: "Vendor/Hosted-1.5", metadata: null, dataUse: "standard", transport: "openai-completions", resolvedMetadata: hosted },
        ]],
      ]),
    });
    expect(catalogRequests).toEqual([["hosting"]]);
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a declared dated snapshot takes its own catalog row, and an unlisted spelling the preferred row of its model", () => {
  const may = modelInfo("openai", "gpt-4o-2024-05-13", "gpt", 5, 15, "2024-05-13", { outputLimit: 4_096 });
  const august = modelInfo("openai", "gpt-4o-2024-08-06", "gpt", 2.5, 10, "2024-08-06", { outputLimit: 16_384 });
  const rows = [{ wireModelId: "gpt-4o-2024-05-13", metadata: may }, { wireModelId: "gpt-4o-2024-08-06", metadata: august }];
  const described = (declared: string, catalog: typeof rows) => staticOfferingMap([declared], "openai-completions", catalog).get("gpt-4o")?.[0]?.resolvedMetadata;

  for (const catalog of [rows, rows.toReversed()]) {
    expect(described("GPT-4o-2024-05-13", catalog)).toBe(may);
    expect(described("gpt-4o-2024-08-06", catalog)).toBe(august);
    expect(described("gpt-4o", catalog)).toBe(august);
  }
});
