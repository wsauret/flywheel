import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthProfileStore, openExistingAuthProfileDirectory } from "../../../../src/infra/auth/auth-profile-store.js";
import { MODEL_REFUSAL_LIFETIME_MS, readSavedProviderModels, recordProviderModelRefusal, writeProviderModelCatalog } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { normalizeResolvedCatalogRows } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { createModelsClient } from "../../../../src/infra/llm/models.js";
import { githubCopilotModule } from "../../../../src/orchestration/modules/provider-github-copilot/module.js";
import { normalizeCopilotCatalogRow } from "../../../../src/orchestration/modules/provider-github-copilot/model-support.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { combinedModelsDevProviders, modelsDevDocument, TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";
import { catalogProfile } from "../../../helpers/catalog-profile.js";

const ACCOUNT = { kind: "singleton", providerId: "delayed" } as const;
const ACCOUNT_CANDIDATE = { ...ACCOUNT, spendMode: "direct_api" } as const;
const LINEAGE = "8b23cbaf-e586-426e-b2ae-416b04593514";
/** The fetch of a provider that only writes a fixture catalog: it never lists. */
const unusedFetch: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"] = async () => { throw new Error("a fixture write fetches nothing"); };

function seedCredential(authDir: string): void {
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({
    delayed: { lineageId: LINEAGE, credential: { type: "api_key", key: "test-key" } },
  }));
}

function provider(fetch: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"]): AccessProviderDefinition {
  return {
    id: "delayed",
    displayName: "Delayed",
    shortName: "Delayed",
    rank: 1,
    supportedFamilies: ["openai"],
    configHints: [],
    catalogId: undefined,
    dynamicCatalog: {
      limits: TEST_CATALOG_LIMITS,
      extractRows: (body) => Array.isArray(body) ? body : [],
      canonicalize: (row) => typeof row === "object" && row !== null && "id" in row && typeof row.id === "string"
        ? { modelId: row.id, wireModelId: row.id, metadata: null }
        : undefined,
      modelsDevCatalogIds: ["openai"],
      fetch,
    },
    auth: { kind: "api_key", statusRank: 1 },
    cli: { name: "delayed" },
    billing: "metered",
    spendMode: "direct_api",
  };
}

function baseline() {
  return [{
    providerId: "openai",
    providerName: "OpenAI",
    wireModelId: "route",
    dataUse: "standard" as const,
    metadata: modelInfo("openai", "route", "gpt", 1, 2, "2026-01-01"),
    provenance: "live" as const,
    canonical: { providerId: "openai", modelId: "canonical" },
    transport: { npm: "@ai-sdk/openai" },
  }];
}

function auth() {
  return {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: LINEAGE },
  };
}

function modelsClient() {
  return {
    refresh: async () => {},
    getTokenizerIdentity: () => undefined,
    getProviderCatalog: () => baseline(),
  };
}

function catalogBytes(authDir: string): Buffer {
  const access = openExistingAuthProfileDirectory(authDir);
  try {
    const bytes = access.readFile("provider-model-catalogs.json", TEST_CATALOG_LIMITS.durableBytes);
    if (bytes === undefined) throw new Error("provider model catalog bytes are absent");
    return bytes;
  } finally {
    access.close();
  }
}

test.each(["fresh", "cached-first"] as const)("Copilot context authority reconciles %s rows without changing route metadata", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-copilot-context-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  const original = globalThis.fetch;
  const copilotCatalog = githubCopilotModule.contributions[0].value.definition.dynamicCatalog;
  try {
    seedCredential(authDir);
    const rows = ["gpt-6.1-sol", "claude-opus-4.8", "claude-opus-4.8-fast", "capacity-absent"].map((id) => ({
      id,
      supported_endpoints: ["/responses"],
      capabilities: { limits: { max_context_window_tokens: 328_000, max_output_tokens: 1_024 }, supports: { reasoning: true } },
      billing: { token_prices: { batch_size: 1_000_000, default: { input_price: 3, cache_price: 1, output_price: 12 } } },
    }));
    const sourceRows = rows.map((row) => {
      const source = normalizeCopilotCatalogRow(row);
      if (source === undefined) throw new Error("invalid Copilot fixture");
      return source;
    });
    const saved = normalizeResolvedCatalogRows(sourceRows, copilotCatalog.limits);
    if (saved.kind !== "valid") throw new Error("invalid saved Copilot fixture");
    await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, saved.rows, copilotCatalog.limits);
    const document = modelsDevDocument();
    document["github-copilot"] = {
      id: "github-copilot", name: "Copilot", npm: "@ai-sdk/openai",
      models: {
        "gpt-6.1-sol": { id: "gpt-6.1-sol", limit: { input: 922_000, context: 1_050_000, output: 128_000 } },
        "claude-opus-4.8": { id: "claude-opus-4.8", limit: { context: 1_000_000, output: 128_000 } },
        "capacity-absent": { id: "capacity-absent" },
      },
    };
    globalThis.fetch = Object.assign(async () => Response.json(combinedModelsDevProviders(document)), { preconnect: original.preconnect });
    const metadataClient = createModelsClient(join(root, "models.json"));
    await metadataClient.refresh(new AbortController().signal);
    globalThis.fetch = Object.assign(async () => { throw new Error("listing must not fetch metadata"); }, { preconnect: original.preconnect });
    for (const catalogOwned of [true, false]) {
      const fetchCatalog: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"] = async ({ credential }) => {
        if (mode === "cached-first") throw new Error("saved listing must not discover");
        return { discovery: { kind: "rows", rows }, credential };
      };
      const client = createModelListingClient({
        classifySlot: () => "metered", authDir, modelsClient: metadataClient,
        providers: createAccessProviderSelection([{
          ...provider(fetchCatalog),
          dynamicCatalog: {
            ...copilotCatalog,
            modelsDevMetadataFields: catalogOwned ? copilotCatalog.modelsDevMetadataFields : undefined,
            fetch: fetchCatalog,
          },
        }]),
      });
      const candidate = (await client.getModelCatalogs(auth(), { mode })).candidates.get(accessProviderAccountKey(ACCOUNT));
      expect(candidate?.models?.size).toBe(4);
      for (const source of sourceRows) {
        const offering = candidate?.models?.get(source.modelId)?.[0];
        const expectedContext = !catalogOwned ? 328_000
          : source.modelId === "gpt-6.1-sol" ? 922_000
          : source.modelId === "claude-opus-4.8" ? 1_000_000 : 328_000;
        expect(offering?.resolvedMetadata?.contextLimit).toBe(expectedContext);
        expect(offering?.resolvedMetadata?.totalContextLimit).toBe(
          !catalogOwned ? undefined
            : source.modelId === "gpt-6.1-sol" ? 1_050_000
            : source.modelId === "claude-opus-4.8" ? 1_000_000 : undefined,
        );
        expect(offering?.wireModelId).toBe(source.wireModelId);
        expect(offering?.transport).toBe(source.transport);
        expect(offering?.resolvedMetadata?.outputLimit).toBe(1_024);
        expect(offering?.resolvedMetadata?.family).toBe(source.resolvedMetadata?.family);
        expect(offering?.resolvedMetadata?.toolCall).toBe(source.resolvedMetadata?.toolCall);
        expect(offering?.resolvedMetadata?.pricing).toEqual(source.resolvedMetadata?.pricing);
        expect(offering?.resolvedMetadata?.reasoning).toBe(true);
        expect(offering?.resolvedMetadata?.providerFields?.includes("contextLimit")).toBe(expectedContext === 328_000);
        if (expectedContext !== 328_000) expect(offering?.resolvedMetadata?.catalogFields).toContain("contextLimit");
      }
      if (mode === "fresh" && catalogOwned) {
        const retained = readSavedProviderModels(access, ACCOUNT, LINEAGE, copilotCatalog.limits)?.rows;
        expect(retained?.find((row) => row.modelId === "gpt-6.1-sol")?.offerings[0]?.resolvedMetadata?.contextLimit).toBe(328_000);
        for (const row of Object.values(document["github-copilot"].models)) delete row.limit;
        globalThis.fetch = Object.assign(async () => Response.json(combinedModelsDevProviders(document)), { preconnect: original.preconnect });
        await metadataClient.refresh(new AbortController().signal);
        globalThis.fetch = Object.assign(async () => { throw new Error("cached listing must not fetch metadata"); }, { preconnect: original.preconnect });
        const cached = (await client.getModelCatalogs(auth(), { mode: "cached-first" })).candidates.get(accessProviderAccountKey(ACCOUNT));
        expect(cached?.models?.get("gpt-6.1-sol")?.[0]?.resolvedMetadata?.contextLimit).toBe(328_000);
        expect(cached?.models?.get("claude-opus-4.8")?.[0]?.resolvedMetadata?.contextLimit).toBe(328_000);
      }
    }
  } finally {
    access.close();
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached-first sanitization leaves saved catalog bytes unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-catalog-byte-preservation-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, [
    { modelId: "stale", offerings: [{ wireModelId: "route", metadata: { saved: true }, dataUse: "standard" }] },
    { modelId: "unresolved", offerings: [{ wireModelId: "unknown", metadata: { saved: true }, dataUse: "standard" }] },
  ], TEST_CATALOG_LIMITS);
  const before = access.readFile("provider-model-catalogs.json", TEST_CATALOG_LIMITS.durableBytes);
  access.close();
  if (before === undefined) throw new Error("seed catalog bytes are absent");

  try {
    const client = createModelListingClient({
      classifySlot: () => "metered",
      authDir,
      providers: createAccessProviderSelection([provider(async () => { throw new Error("cached-first must not fetch"); })]),
      modelsClient: modelsClient(),
    });
    const candidate = (await client.getModelCatalogs(auth(), { mode: "cached-first" })).candidates.get(accessProviderAccountKey(ACCOUNT));

    expect(candidate?.models?.keys().toArray()).toEqual(["canonical", "unresolved"]);
    expect(candidate?.visibleModels?.keys().toArray()).toEqual(["canonical", "unresolved"]);
    expect(catalogBytes(authDir)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful empty refresh retains the saved canonical catalog and bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-empty-refresh-catalog-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, [
    { modelId: "stale", offerings: [{ wireModelId: "route", metadata: { saved: true }, dataUse: "standard" }] },
  ], TEST_CATALOG_LIMITS);
  const before = access.readFile("provider-model-catalogs.json", TEST_CATALOG_LIMITS.durableBytes);
  access.close();
  if (before === undefined) throw new Error("seed catalog bytes are absent");

  try {
    const client = createModelListingClient({
      classifySlot: () => "metered",
      authDir,
      providers: createAccessProviderSelection([provider(async ({ credential }) => ({ discovery: { kind: "rows", rows: [] }, credential }))]),
      modelsClient: modelsClient(),
    });
    const catalogs = await client.getModelCatalogs(auth(), { mode: "refresh" });
    const candidate = catalogs.candidates.get(accessProviderAccountKey(ACCOUNT));

    expect(catalogs.providers.get("delayed")).toEqual(new Set(["canonical"]));
    expect(candidate?.models?.get("canonical")?.[0]?.wireModelId).toBe("route");
    expect(candidate?.visibleModels?.keys().toArray()).toEqual(["canonical"]);
    expect(catalogBytes(authDir)).toEqual(before);
    const persisted = openExistingAuthProfileDirectory(authDir);
    try {
      expect(readSavedProviderModels(persisted, ACCOUNT, LINEAGE, TEST_CATALOG_LIMITS)?.rows?.[0]?.offerings[0]?.wireModelId).toBe("route");
    } finally {
      persisted.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed refresh serves the same credential's saved catalog rather than losing it to a models.dev fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-failed-refresh-catalog-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, [
    { modelId: "saved-only", offerings: [{ wireModelId: "saved-only", metadata: null, dataUse: "standard" }] },
  ], TEST_CATALOG_LIMITS);
  const before = access.readFile("provider-model-catalogs.json", TEST_CATALOG_LIMITS.durableBytes);
  access.close();
  if (before === undefined) throw new Error("seed catalog bytes are absent");
  try {
    const client = createModelListingClient({
      classifySlot: () => "metered",
      authDir,
      providers: createAccessProviderSelection([provider(async ({ credential }) => ({ discovery: { kind: "failed", reason: "http", status: 503 }, credential }))]),
      modelsClient: modelsClient(),
    });
    const candidate = (await client.getModelCatalogs(auth(), { mode: "refresh" })).candidates.get(accessProviderAccountKey(ACCOUNT));
    expect(candidate?.outcome).toMatchObject({ kind: "catalog", provenance: "first-party-cached", liveOutcome: "discovery-failed" });
    expect(candidate?.visibleModels?.has("saved-only")).toBe(true);
    expect(catalogBytes(authDir)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function refusalFixture() {
  const ids = ["refused", "narrowed", "whole"];
  const metadata = (id: string) => modelInfo("openai", id, "gpt", 1, 2, "2026-01-01", { contextLimit: 1_000_000, totalContextLimit: 1_000_000 });
  const rows = ids.map((id) => ({ modelId: id, offerings: [{ wireModelId: id, metadata: null, dataUse: "standard" as const, resolvedMetadata: metadata(id) }] }));
  const client = (authDir: string, now: number) => createModelListingClient({
    classifySlot: () => "metered",
    authDir,
    now: () => now,
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({ discovery: { kind: "rows", rows: ids.map((id) => ({ id })) }, credential }))]),
    modelsClient: {
      ...modelsClient(),
      getProviderCatalog: () => ids.map((id) => ({ ...baseline()[0]!, wireModelId: id, metadata: metadata(id), canonical: { providerId: "openai", modelId: id } })),
    },
  });
  return { rows, client };
}

test.each(["cached-first", "fresh", "refresh"] as const)("a %s listing hides a refused wire model and narrows a refused extended window until the refusal ends", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-model-refusals-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  const at = 10 * MODEL_REFUSAL_LIFETIME_MS;
  const { rows, client } = refusalFixture();
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, rows, TEST_CATALOG_LIMITS);
  await recordProviderModelRefusal(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, "refused", { kind: "model", at }, TEST_CATALOG_LIMITS);
  await recordProviderModelRefusal(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, "narrowed", { kind: "extended-context", contextLimit: 200_000, at }, TEST_CATALOG_LIMITS);
  access.close();
  try {
    const listed = async (now: number) => {
      const catalogs = await client(authDir, now).getModelCatalogs(auth(), { mode });
      const candidate = catalogs.candidates.get(accessProviderAccountKey(ACCOUNT));
      expect(candidate?.visibleModels?.keys().toArray().sort()).toEqual(candidate?.models?.keys().toArray().sort());
      expect(catalogs.providers.get("delayed")).toEqual(new Set(candidate?.models?.keys()));
      return { ids: candidate?.models?.keys().toArray().sort(), window: (id: string) => candidate?.models?.get(id)?.[0]?.resolvedMetadata?.contextLimit };
    };
    const refused = await listed(at + MODEL_REFUSAL_LIFETIME_MS - 1);
    expect(refused.ids).toEqual(["narrowed", "whole"]);
    expect([refused.window("narrowed"), refused.window("whole")]).toEqual([200_000, 1_000_000]);
    const ended = await listed(at + MODEL_REFUSAL_LIFETIME_MS);
    expect(ended.ids).toEqual(["narrowed", "refused", "whole"]);
    expect(ended.window("narrowed")).toBe(1_000_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refusal saved through the listing client reaches its next listing, and a refusal for an older credential saves nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-model-refusals-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  const { rows, client: makeClient } = refusalFixture();
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, rows, TEST_CATALOG_LIMITS);
  access.close();
  const now = 10 * MODEL_REFUSAL_LIFETIME_MS;
  const client = makeClient(authDir, now);
  try {
    const listed = async () => (await client.getModelCatalogs(auth(), { mode: "cached-first" })).candidates.get(accessProviderAccountKey(ACCOUNT))?.models?.keys().toArray().sort();
    expect(await listed()).toEqual(["narrowed", "refused", "whole"]);
    const stale = { ...auth(), credentialLineages: { delayed: "0b7c1f7e-2c1d-4e55-9d7e-3f0f3c9c1a11" } };
    expect(await client.recordModelRefusal({ auth: stale, subscriptions: new Map(), candidate: ACCOUNT_CANDIDATE, wireModelId: "refused", refusal: { kind: "model" } })).toBe(false);
    expect(await client.recordModelRefusal({ auth: auth(), subscriptions: new Map(), candidate: ACCOUNT_CANDIDATE, wireModelId: "refused", refusal: { kind: "model" } })).toBe(true);
    expect(await listed()).toEqual(["narrowed", "whole"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable saved catalog file leaves the listing with its models.dev catalog instead of failing it", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "flywheel-model-refusals-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  seedCredential(authDir);
  const { rows, client } = refusalFixture();
  await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), ACCOUNT, LINEAGE, rows, TEST_CATALOG_LIMITS);
  access.close();
  chmodSync(join(authDir, "provider-model-catalogs.json"), 0o000);
  try {
    const catalogs = await client(authDir, 0).getModelCatalogs(auth(), { mode: "cached-first" });
    expect(catalogs.candidates.get(accessProviderAccountKey(ACCOUNT))?.visibleModels?.keys().toArray().sort()).toEqual(["narrowed", "refused", "whole"]);
  } finally {
    chmodSync(join(authDir, "provider-model-catalogs.json"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});
