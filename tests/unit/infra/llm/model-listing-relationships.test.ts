import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { writeProviderModelCatalog } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderCandidate, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../src/infra/llm/models.js";
import { providerModelEligibilityDecision } from "../../../../src/orchestration/config/provider-model-eligibility.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { combinedModelsDevDocument, TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";
import { catalogProfile } from "../../../helpers/catalog-profile.js";

const LINEAGE = "1e84c788-1c18-4a4f-bc46-a2b745eb4d26";
/** The fetch of a provider that only writes a fixture catalog: it never lists. */
const unusedFetch: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"] = async () => { throw new Error("a fixture write fetches nothing"); };

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

function baselineRow(wireModelId: string, canonicalModelId: string | null) {
  const dataUse = canonicalModelId?.endsWith("-contributor") === true ? "contributor" as const : "standard" as const;
  return {
    providerId: "openai",
    providerName: "OpenAI",
    wireModelId,
    dataUse,
    metadata: modelInfo("openai", wireModelId, "gpt", 1, 2, "2026-01-01"),
    provenance: "live" as const,
    canonical: canonicalModelId === null ? null : { providerId: "openai", modelId: canonicalModelId },
    transport: { npm: "@ai-sdk/openai" },
  };
}

function auth() {
  return {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: LINEAGE },
  };
}

function admittedWire(candidate: AccessProviderCandidate, models: ReadonlyMap<string, readonly import("../../../../src/infra/llm/model-catalog-resolution.js").CatalogModelOffering[]>, allowTrainingRoutes: boolean) {
  const canonicalModels = new Set(models.keys());
  const decision = providerModelEligibilityDecision({
    profileId: "default",
    revision: 1,
    catalogs: new Map([[candidate.providerId, {
      catalog: canonicalModels,
      curatedDefault: canonicalModels,
      enabled: canonicalModels,
      disabled: new Set<string>(),
      effective: canonicalModels,
    }]]),
    enabledCandidates: new Map([[accessProviderAccountKey(candidate), {
      candidate,
      configured: true,
      currentConnection: true,
      enabledOfferings: models,
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
    }]]),
  });
  return decision.worker.candidateOffering?.(candidate, "gpt", allowTrainingRoutes)?.wireModelId;
}

test("combined model-map relationships enrich known routes without hiding stable provider rows", async () => {
  const originalFetch = globalThis.fetch;
  const modelsDirectory = mkdtempSync(join(tmpdir(), "flywheel-current-map-"));
  const combined = combinedModelsDevDocument();
  combined.models["owner/shared"] = { id: "owner/shared" };
  combined.providers.aggregator = {
    id: "aggregator",
    name: "Aggregator",
    npm: "@ai-sdk/openai-compatible",
    models: {
      known: { id: "owner/shared" },
      absent: { id: "owner/absent" },
    },
  };
  // Restored in the finally below, which covers every step after the swap: a
  // refresh that fails must not leave the fake fetch or the directory behind
  // for the next test in this process.
  globalThis.fetch = Object.assign(async () => Response.json(combined), { preconnect: originalFetch.preconnect });
  try {
    const definition = provider(async ({ credential }) => ({
      discovery: { kind: "rows", rows: [{ id: "owner/shared" }, { id: "owner/absent" }] },
      credential,
    }));
    const dynamicCatalog = definition.dynamicCatalog;
    if (dynamicCatalog === undefined) throw new Error("Expected dynamic catalog");
    const currentDefinition = {
      ...definition,
      dynamicCatalog: { ...dynamicCatalog, modelsDevCatalogIds: ["aggregator"] },
    };
    const modelsClient = createModelsClient(join(modelsDirectory, "models.json"));
    await modelsClient.refresh(AbortSignal.timeout(10_000));
    const client = createModelListingClient({
      classifySlot: () => "metered",
      authDir: "/unused",
      oauthPersistence: "access-only",
      providers: createAccessProviderSelection([currentDefinition]),
      modelsClient,
    });
    const result = await client.getModelCatalogs(auth(), { mode: "fresh" });
    const candidate = [...result.candidates.values()][0];
    expect(result.providers.get("delayed")).toEqual(new Set(["shared", "owner/absent"]));
    expect(candidate?.models?.get("shared")?.[0]?.wireModelId).toBe("owner/shared");
    expect(candidate?.models?.get("owner/absent")?.[0]?.wireModelId).toBe("owner/absent");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(modelsDirectory, { recursive: true, force: true });
  }
});

test("aggregates unknown fresh wires across accounts and logs only changed observations", async () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  let round = 1;
  const definition = provider(async ({ credential, instance }) => ({
    discovery: { kind: "rows", rows: [
      { id: `route-${instance?.instanceId ?? "singleton"}` },
      { id: `unknown-${round}-${instance?.instanceId ?? "singleton"}` },
    ] },
    credential,
  }));
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([definition]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [
        baselineRow("route-a", "shared"),
        baselineRow("route-b", "shared"),
      ],
    },
    captureSubscriptions: () => new Map([["delayed", [
      { instanceId: "a", credential: { type: "api_key", key: Redacted.make("a") } },
      { instanceId: "b", credential: { type: "api_key", key: Redacted.make("b") } },
    ]]]),
  });

  const first = await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
  expect(first.providers.get("delayed")).toEqual(new Set(["shared", "unknown-1-a", "unknown-1-b"]));
  expect([...first.candidates.values()].map((candidate) => candidate.visibleModels?.keys().toArray())).toEqual([
    ["shared", "unknown-1-a"],
    ["shared", "unknown-1-b"],
  ]);
  await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
  expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.relationship_unresolved")).toHaveLength(1);
  expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.canonical_collision")).toHaveLength(0);

  round = 2;
  await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
  const diagnostics = record.mock.calls.filter(([entry]) => entry.type === "model.catalog.relationship_unresolved");
  expect(diagnostics).toHaveLength(2);
  expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.canonical_collision")).toHaveLength(0);
  expect(diagnostics[0]?.[0]).toMatchObject({ payload: { providerId: "delayed", total: 2 } });
  expect(diagnostics[1]?.[0]).toMatchObject({ payload: { providerId: "delayed", total: 2 } });
  record.mockRestore();
});

test("diagnostic identity covers complete observations and ignores source ordering", async () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  let unknown = Array.from({ length: 65 }, (_, index) => `unknown-${index.toString().padStart(2, "0")}`);
  let reverseBaseline = false;
  const knownRows = [baselineRow("route-a", "model-a"), baselineRow("route-b", "model-b")];
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({
      discovery: { kind: "rows", rows: [{ id: "route-a" }, ...unknown.map((id) => ({ id }))] },
      credential,
    }))]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => {
        reverseBaseline = !reverseBaseline;
        return reverseBaseline ? knownRows : knownRows.toReversed();
      },
    },
  });

  try {
    await client.getModelCatalogs(auth(), { mode: "fresh" });
    unknown = unknown.toReversed();
    await client.getModelCatalogs(auth(), { mode: "fresh" });
    unknown = [...unknown.filter((id) => id !== "unknown-64"), "unknown-replacement"];
    await client.getModelCatalogs(auth(), { mode: "fresh" });

    expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.relationship_unresolved")).toHaveLength(2);
  } finally {
    record.mockRestore();
  }
});

test("records a canonical collision after more than 64 singleton identities", async () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const baseline = [
    ...Array.from({ length: 65 }, (_, index) => baselineRow(`route-${index}`, `model-${index}`)),
    baselineRow("collision-a", "shared-last"),
    baselineRow("collision-b", "shared-last"),
  ];
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({
      discovery: { kind: "rows", rows: baseline.map(({ wireModelId }) => ({ id: wireModelId })) },
      credential,
    }))]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => baseline,
    },
  });

  try {
    await client.getModelCatalogs(auth(), { mode: "fresh" });
    expect(record.mock.calls.find(([entry]) => entry.type === "model.catalog.canonical_collision")?.[0]).toMatchObject({
      payload: {
        total: 1,
        collisions: [{ modelId: "shared-last", wireModelIds: ["collision-a", "collision-b"] }],
      },
    });
  } finally {
    record.mockRestore();
  }
});

test("admits a stable models.dev-known wire without a canonical relationship", async () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({
      discovery: { kind: "rows", rows: [{ id: "provider/moving-alias" }] },
      credential,
    }))]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [baselineRow("provider/moving-alias", null)],
    },
  });

  const catalog = await client.getModelCatalogs(auth(), { mode: "fresh" });

  expect(catalog.providers.get("delayed")).toEqual(new Set(["provider/moving-alias"]));
  expect([...catalog.candidates.values()][0]?.visibleModels?.keys().toArray()).toEqual(["provider/moving-alias"]);
  expect(record).not.toHaveBeenCalled();
  record.mockRestore();
});

test("preserves contributor-only relationships through fresh, fallback, and saved admission", async () => {
  const candidate = { kind: "singleton", providerId: "delayed", spendMode: "direct_api" } as const;
  const modelsClient = {
    refresh: async () => {},
    getTokenizerIdentity: () => undefined,
    getProviderCatalog: () => [baselineRow("provider/gpt-contributor", "gpt-contributor")],
  };
  const fresh = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({
      discovery: { kind: "rows", rows: [{ id: "provider/gpt-contributor" }] },
      credential,
    }))]),
    modelsClient,
  });
  const freshModels = (await fresh.getModelCatalogs(auth(), { mode: "fresh" })).candidates.get(accessProviderAccountKey(candidate))?.models;
  if (freshModels === null || freshModels === undefined) throw new Error("fresh contributor catalog is absent");
  expect(admittedWire(candidate, freshModels, false)).toBeUndefined();
  expect(admittedWire(candidate, freshModels, true)).toBe("provider/gpt-contributor");

  const fallback = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([provider(async ({ credential }) => ({ discovery: { kind: "failed", reason: "http" }, credential }))]),
    modelsClient,
  });
  const fallbackModels = (await fallback.getModelCatalogs(auth(), { mode: "fresh" })).candidates.get(accessProviderAccountKey(candidate))?.models;
  if (fallbackModels === null || fallbackModels === undefined) throw new Error("fallback contributor catalog is absent");
  expect(admittedWire(candidate, fallbackModels, false)).toBeUndefined();
  expect(admittedWire(candidate, fallbackModels, true)).toBe("provider/gpt-contributor");

  const root = mkdtempSync(join(tmpdir(), "flywheel-contributor-catalog-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  const account = { kind: "singleton", providerId: "delayed" } as const;
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ delayed: { lineageId: LINEAGE, credential: { type: "api_key", key: "key" } } }));
  expect(await writeProviderModelCatalog(catalogProfile(access, [provider(unusedFetch)]), account, LINEAGE, [{
    modelId: "stale",
    offerings: [{ wireModelId: "provider/gpt-contributor", metadata: null, dataUse: "standard" }],
  }], TEST_CATALOG_LIMITS)).toBe(true);
  access.close();
  try {
    const cached = createModelListingClient({
      classifySlot: () => "metered",
      authDir,
      providers: createAccessProviderSelection([provider(async () => { throw new Error("cached-first must not fetch"); })]),
      modelsClient,
    });
    const cachedCatalogs = await cached.getModelCatalogs(auth(), { mode: "cached-first" });
    const savedCandidate = cachedCatalogs.candidates.get(accessProviderAccountKey(account));
    const savedModels = savedCandidate?.models;
    if (savedModels === null || savedModels === undefined) throw new Error(`saved contributor catalog is absent: ${JSON.stringify(savedCandidate)}`);
    expect(admittedWire(candidate, savedModels, false)).toBeUndefined();
    expect(admittedWire(candidate, savedModels, true)).toBe("provider/gpt-contributor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shares semantically identical baselines across distinct provider contributions", async () => {
  const original = provider(async ({ credential }) => ({
    discovery: { kind: "failed", reason: "http" },
    credential,
  }));
  const definition = (
    id: string,
    modelsDevCatalogIds: readonly string[],
    canonicalRows = TEST_CATALOG_LIMITS.canonicalRows,
  ): AccessProviderDefinition => ({
    ...original,
    id,
    displayName: id,
    shortName: id,
    dynamicCatalog: {
      ...original.dynamicCatalog!,
      limits: { ...TEST_CATALOG_LIMITS, canonicalRows },
      modelsDevCatalogIds,
    },
  });
  const definitions = [
    definition("same-a", ["openai"]),
    definition("same-b", ["openai"]),
    definition("different-id", ["anthropic"]),
    definition("different-limit", ["openai"], TEST_CATALOG_LIMITS.canonicalRows - 1),
  ];
  const calls: string[] = [];
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection(definitions),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: (providerIds, rowLimit) => {
        calls.push(JSON.stringify([providerIds, rowLimit]));
        return [];
      },
    },
  });
  const configuredAuth = {
    ...AUTH_NONE,
    providers: authProviders({
      base: AUTH_NONE.providers,
      apiKeys: Object.fromEntries(definitions.map(({ id }) => [id, "key"])),
    }),
    credentialLineages: Object.fromEntries(definitions.map(({ id }) => [id, "lineage"])),
  };

  await client.getModelCatalogs(configuredAuth, { mode: "fresh" });

  expect(calls).toHaveLength(3);
  expect(calls.filter((call) => call.includes("\"openai\"") && call.endsWith(`${TEST_CATALOG_LIMITS.canonicalRows}]`))).toHaveLength(1);
});

test("does not diagnose standard and contributor offerings as collisions across accounts", async () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const definition = provider(async ({ credential }) => ({
    discovery: { kind: "rows", rows: [{ id: "route-standard" }, { id: "route-contributor" }] },
    credential,
  }));
  const client = createModelListingClient({
    classifySlot: () => "metered",
    authDir: "/unused",
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([definition]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [
        baselineRow("route-standard", "gpt"),
        { ...baselineRow("route-contributor", "gpt"), dataUse: "contributor" as const },
      ],
    },
    captureSubscriptions: () => new Map([["delayed", [
      { instanceId: "a", credential: { type: "api_key", key: Redacted.make("a") } },
      { instanceId: "b", credential: { type: "api_key", key: Redacted.make("b") } },
    ]]]),
  });

  try {
    await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
    await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
    expect(record.mock.calls.map(([entry]) => entry.type)).toEqual([]);
  } finally {
    record.mockRestore();
  }
});
