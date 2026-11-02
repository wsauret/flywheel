import { afterEach, expect, spyOn, test } from "bun:test";
import type { CredentialSlotClassifier } from "../../../../src/infra/auth/auth-store-types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { writeProviderModelCatalog } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../src/infra/llm/models.js";
import { testCapabilityModules, testProviderSelection } from "../../../helpers/provider-authority.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { AUTH_DIR, AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { canonicalTestRow, combinedModelsDevProviders, modelsDevDocument, TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { catalogProfile } from "../../../helpers/catalog-profile.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());
const LINEAGE = "c16045ec-29e2-43c7-bcde-ea7dc1e95280";
const LINEAGE_A = "296b5d6c-99ca-4212-a3cc-ed1275016c07";
const LINEAGE_B = "4ac74046-55eb-408e-a098-f473fa49879a";
const temporaryDirectory = temporaryDirectories();
/** The fetch of a provider that only writes a fixture catalog: it never lists. */
const unusedFetch: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"] = async () => { throw new Error("a fixture write fetches nothing"); };

function seedDelayedCredential(authDir: string, accounts?: readonly { readonly id: string; readonly lineageId: string }[]): void {
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({
    delayed: accounts === undefined
      ? { lineageId: LINEAGE, credential: { type: "api_key", key: "key" } }
      : accounts.map(({ id, lineageId }) => ({ id, identity: id, lineageId, credential: { type: "api_key", key: `key-${id}` } })),
  }));
}

/** A provider whose catalog fetch the test controls. A subscription provider holds several accounts. */
function delayedProvider(
  fetch: NonNullable<AccessProviderDefinition["dynamicCatalog"]>["fetch"],
  billing: AccessProviderDefinition["billing"] = "metered",
): AccessProviderDefinition {
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
      canonicalize: canonicalTestRow,
      modelsDevCatalogIds: ["openai"],
      fetch,
    },
    auth: { kind: "api_key", statusRank: 1 },
    cli: { name: "delayed" },
    ...(billing === "subscription" ? { billing } : { billing, spendMode: "direct_api" }),
  };
}

afterEach(() => {
  installCustomProviders([]);
});

test("OpenCode Go isolates account discovery and falls back from a 503 to models.dev", async () => {
  const original = globalThis.fetch;
  const authorizations: string[] = [];
  const fetchStub: typeof fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    authorizations.push(authorization);
    if (authorization === "Bearer selected-key") return new Response("live-only model listing unavailable", { status: 503 });
    const data = [{ id: "kimi-k3" }];
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  }, { preconnect: original.preconnect });
  globalThis.fetch = fetchStub;
  try {
    const client = createModelListingClient({
      classifySlot,
      authDir: AUTH_DIR,
      oauthPersistence: "access-only",
      providers: testProviderSelection(),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: () => [{
          providerId: "opencode-go",
          providerName: "OpenCode Go",
          wireModelId: "deepseek-v4.1-flash",
          metadata: modelInfo("openai", "deepseek-v4.1-flash", "deepseek", 0, 0, "2026-01-01"),
          provenance: "bundled" as const,
          canonical: { providerId: "deepseek", modelId: "deepseek-v4.1-flash" },
          transport: { npm: "@ai-sdk/openai-compatible" },
        }],
      },
      captureSubscriptions: () => new Map([[
        "opencode_go",
        [
          { instanceId: "a", credential: { type: "api_key", key: Redacted.make("selected-key") } },
          { instanceId: "b", credential: { type: "api_key", key: Redacted.make("sibling-key") } },
        ],
      ]]),
    });
    const catalogs = await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });
    expect(catalogs.providers.get("opencode_go")).toEqual(new Set(["deepseek-v4.1-flash", "kimi-k3"]));
    const live = catalogs.candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "opencode_go", instanceId: "b" }));
    expect(live?.visibleModels?.keys().toArray()).toEqual(["kimi-k3"]);
    expect(authorizations.toSorted()).toEqual(["Bearer selected-key", "Bearer sibling-key"].toSorted());
  } finally {
    globalThis.fetch = original;
  }
});

test("cached-first waits for first-party discovery before admitting a models.dev fallback", async () => {
  let firstPartyFetches = 0;
  const client = createModelListingClient({
    classifySlot,
    authDir: AUTH_DIR,
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([delayedProvider(async ({ credential }) => {
      firstPartyFetches++;
      return { discovery: { kind: "failed", reason: "http" }, credential };
    })]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [{
        providerId: "openai",
        providerName: "OpenAI",
        wireModelId: "fallback-model",
        metadata: modelInfo("openai", "fallback-model", "openai", 0, 0, "2026-01-01"),
        provenance: "bundled" as const,
        canonical: { providerId: "openai", modelId: "fallback-model" },
        transport: { npm: "@ai-sdk/openai" },
      }],
    },
  });
  const configuredAuth: AuthContext = {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: "lineage" },
  };

  const candidate = (await client.getModelCatalogs(configuredAuth, { mode: "cached-first" })).candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "delayed" }));

  expect(candidate?.models).toBeNull();
  expect(candidate?.visibleModels?.keys().toArray()).toEqual(["fallback-model"]);
  expect(candidate?.outcome).toEqual({ kind: "unavailable", reason: "discovery-pending" });
  expect(firstPartyFetches).toBe(0);
  const settled = (await client.getModelCatalogs(configuredAuth, { mode: "refresh" })).candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "delayed" }));
  expect(firstPartyFetches).toBe(1);
  expect(settled?.models?.keys().toArray()).toEqual(["fallback-model"]);
  expect(settled?.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled", liveOutcome: "discovery-failed" });
});

test("discovery reads the held models.dev catalog and never starts a metadata refresh when first-party discovery fails", async () => {
  let refreshes = 0;
  const client = createModelListingClient({
    classifySlot,
    authDir: AUTH_DIR,
    oauthPersistence: "access-only",
    providers: createAccessProviderSelection([delayedProvider(async ({ credential }) => ({
      discovery: { kind: "failed", reason: "http" },
      credential,
    }))]),
    modelsClient: {
      refresh: () => {
        refreshes += 1;
        return new Promise<void>(() => {});
      },
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => [{
        providerId: "openai",
        providerName: "OpenAI",
        wireModelId: "fallback-model",
        metadata: modelInfo("openai", "fallback-model", "openai", 0, 0, "2026-01-01"),
        provenance: "bundled" as const,
        canonical: { providerId: "openai", modelId: "fallback-model" },
        transport: { npm: "@ai-sdk/openai" },
      }],
    },
  });
  const configuredAuth: AuthContext = {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: "lineage" },
  };

  for (const mode of ["refresh", "fresh"] as const) {
    const candidate = (await client.getModelCatalogs(configuredAuth, { mode }))
      .candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "delayed" }));
    expect(candidate?.models?.keys().toArray()).toEqual(["fallback-model"]);
    expect(candidate?.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled" });
  }
  expect(refreshes).toBe(0);
});

test("cached first-party rows are regrouped through current baseline relationships before eligibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-cached-catalog-reconcile-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  const account = { kind: "singleton", providerId: "delayed" } as const;
  seedDelayedCredential(authDir);
  const savedRows = [
    {
      modelId: "leaked",
      offerings: [{ wireModelId: "gpt-6.1-sol", metadata: { source: "saved" }, dataUse: "standard" as const, transport: "openai-responses" as const }],
    },
    {
      modelId: "second-leaked",
      offerings: [{ wireModelId: "gpt-6-1-sol", metadata: { source: "saved-alias" }, dataUse: "standard" as const, transport: "openai-responses" as const }],
    },
    {
      modelId: "unknown/stable",
      offerings: [{ wireModelId: "unknown/stable", metadata: null, dataUse: "standard" as const, transport: "openai-responses" as const }],
    },
  ];
  await writeProviderModelCatalog(catalogProfile(access, [delayedProvider(unusedFetch)], classifySlot), account, LINEAGE, savedRows, TEST_CATALOG_LIMITS);
  access.close();
  const original = globalThis.fetch;
  const document = modelsDevDocument();
  document.openai = { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", models: {
    "gpt-6.1-sol": { id: "gpt-6.1-sol" },
    "gpt-6-1-sol": { id: "gpt-6-1-sol" },
  } };
  globalThis.fetch = Object.assign(async () => Response.json(combinedModelsDevProviders(document)), { preconnect: original.preconnect });
  try {
    const auth: AuthContext = {
      ...AUTH_NONE,
      providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
      credentialLineages: { delayed: LINEAGE },
    };
    const modelsClient = createModelsClient(join(root, "models.json"));
    await modelsClient.refresh(new AbortController().signal);
    const client = createModelListingClient({
      classifySlot,
      authDir,
      providers: createAccessProviderSelection([delayedProvider(async () => {
        throw new Error("cached-first must not fetch");
      })]),
      modelsClient,
    });

    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    try {
      const candidate = (await client.getModelCatalogs(auth, { mode: "cached-first" })).candidates.get(accessProviderAccountKey(account));
      await client.getModelCatalogs(auth, { mode: "cached-first" });
      expect(candidate?.models?.get("gpt-6.1-sol")).toMatchObject([
        { wireModelId: "gpt-6-1-sol", metadata: { id: "gpt-6-1-sol" }, dataUse: "standard", transport: "openai-responses" },
      ]);
      expect(candidate?.visibleModels?.keys().toArray()).toEqual(["gpt-6.1-sol", "unknown/stable"]);
      expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.canonical_collision")).toEqual([]);
    } finally {
      record.mockRestore();
    }
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("two cached accounts share one current baseline and reconcile independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-cached-catalog-shared-baseline-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  const accounts = [
    { kind: "subscription", providerId: "delayed", instanceId: "a" },
    { kind: "subscription", providerId: "delayed", instanceId: "b" },
  ] as const;
  // The accounts of a subscription provider live in a subscription credential slot.
  const subscriptionSlots: CredentialSlotClassifier = (id) => id === "delayed" ? "subscription" : classifySlot(id);
  seedDelayedCredential(authDir, [{ id: "a", lineageId: LINEAGE_A }, { id: "b", lineageId: LINEAGE_B }]);
  await writeProviderModelCatalog(catalogProfile(access, [delayedProvider(unusedFetch, "subscription")], subscriptionSlots), accounts[0], LINEAGE_A, [{
    modelId: "stale-a",
    offerings: [{ wireModelId: "route-a", metadata: { account: "a" }, dataUse: "standard" }],
  }], TEST_CATALOG_LIMITS);
  await writeProviderModelCatalog(catalogProfile(access, [delayedProvider(unusedFetch, "subscription")], subscriptionSlots), accounts[1], LINEAGE_B, [{
    modelId: "stale-b",
    offerings: [{ wireModelId: "route-b", metadata: { account: "b" }, dataUse: "standard" }],
  }], TEST_CATALOG_LIMITS);
  access.close();
  let baselineMaterializations = 0;
  const baseline = Array.from({ length: 10_000 }, (_, index) => {
    const wireModelId = index === 0 ? "route-a" : index === 1 ? "route-b" : `distinct-${index}`;
    const modelId = index === 0 ? "canonical-a" : index === 1 ? "canonical-b" : wireModelId;
    return {
      providerId: "openai",
      providerName: "OpenAI",
      wireModelId,
      metadata: modelInfo("openai", wireModelId, "gpt", 1, 2, "2026-01-01"),
      provenance: "live" as const,
      canonical: { providerId: "openai", modelId },
      transport: { npm: "@ai-sdk/openai" },
    };
  });
  const client = createModelListingClient({
    classifySlot: subscriptionSlots,
    authDir,
    providers: createAccessProviderSelection([delayedProvider(async () => {
      throw new Error("cached-first must not fetch");
    }, "subscription")]),
    modelsClient: {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: () => {
        baselineMaterializations += 1;
        return baseline;
      },
    },
    captureSubscriptions: () => new Map([["delayed", [
      { instanceId: "a", lineageId: LINEAGE_A, credential: { type: "api_key", key: Redacted.make("key-a") } },
      { instanceId: "b", lineageId: LINEAGE_B, credential: { type: "api_key", key: Redacted.make("key-b") } },
    ]]]),
  });

  try {
    const catalogs = await client.getModelCatalogs(AUTH_NONE, { mode: "cached-first" });
    expect(baselineMaterializations).toBe(1);
    expect(catalogs.candidates.get(accessProviderAccountKey(accounts[0]))?.models?.keys().toArray()).toEqual(["canonical-a"]);
    expect(catalogs.candidates.get(accessProviderAccountKey(accounts[1]))?.models?.keys().toArray()).toEqual(["canonical-b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh failure retains stable saved rows without models.dev relationships", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-refresh-catalog-reconcile-"));
  const access = await new AuthProfileStore(root).create("default");
  const authDir = access.authDirectory;
  const account = { kind: "singleton", providerId: "delayed" } as const;
  seedDelayedCredential(authDir);
  await writeProviderModelCatalog(catalogProfile(access, [delayedProvider(unusedFetch)], classifySlot), account, LINEAGE, [
    { modelId: "removed", offerings: [{ wireModelId: "removed/stable", metadata: null, dataUse: "standard" }] },
    { modelId: "latest", offerings: [{ wireModelId: "~removed/latest", metadata: null, dataUse: "standard" }] },
  ], TEST_CATALOG_LIMITS);
  access.close();
  try {
    const auth: AuthContext = {
      ...AUTH_NONE,
      providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
      credentialLineages: { delayed: LINEAGE },
    };
    const client = createModelListingClient({
      classifySlot,
      authDir,
      providers: createAccessProviderSelection([delayedProvider(async ({ credential }) => ({
        discovery: { kind: "failed", reason: "http" },
        credential,
      }))]),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: () => [{
          providerId: "openai",
          providerName: "OpenAI",
          wireModelId: "gpt-6.1-sol",
          metadata: modelInfo("openai", "gpt-6.1-sol", "gpt", 1, 2, "2026-01-01"),
          provenance: "live" as const,
          canonical: { providerId: "openai", modelId: "gpt-6.1-sol" },
          transport: { npm: "@ai-sdk/openai" },
        }],
      },
    });

    const first = await client.getModelCatalogs(auth, { mode: "refresh" });
    const second = await client.getModelCatalogs(auth, { mode: "cached-first" });
    expect(first.providers.get("delayed")).toEqual(new Set(["removed"]));
    expect(second.providers.get("delayed")).toEqual(new Set(["removed"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Anthropic and Google follow every model-list page", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const fetchStub: typeof fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("api.anthropic.com")) {
      const after = new URL(url).searchParams.get("after_id");
      return Response.json(after
        ? { data: [{ id: "claude-page-two" }], has_more: false }
        : { data: [{ id: "claude-page-one" }], has_more: true, last_id: "cursor-a" });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const token = new URL(url).searchParams.get("pageToken");
      return Response.json(token
        ? { models: [{ name: "models/gemini-page-two" }] }
        : { models: [{ name: "models/gemini-page-one" }], nextPageToken: "cursor-g" });
    }
    return Response.json({ data: [] });
  }, { preconnect: original.preconnect });
  globalThis.fetch = fetchStub;
  try {
    const auth: AuthContext = { ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { anthropic_api: "anthropic", google_api: "google" } }), credentialLineages: { anthropic_api: "a", google_api: "g" } };
    const client = createModelListingClient({
      classifySlot,
      authDir: AUTH_DIR,
      oauthPersistence: "access-only",
      providers: testProviderSelection(),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: () => [
          ...["claude-page-one", "claude-page-two"].map((wireModelId) => ({
            providerId: "anthropic",
            providerName: "Anthropic",
            wireModelId,
            metadata: modelInfo("anthropic", wireModelId, "claude", 1, 2, "2026-01-01"),
            provenance: "live" as const,
            canonical: { providerId: "anthropic", modelId: wireModelId },
            transport: { npm: "@ai-sdk/anthropic" },
          })),
          ...["gemini-page-one", "gemini-page-two"].map((wireModelId) => ({
            providerId: "google",
            providerName: "Google",
            wireModelId,
            metadata: modelInfo("google", wireModelId, "gemini", 1, 2, "2026-01-01"),
            provenance: "live" as const,
            canonical: { providerId: "google", modelId: wireModelId },
            transport: { npm: "@ai-sdk/google" },
          })),
        ],
      },
    });

    const models = (await client.getModelCatalogs(auth, { mode: "fresh" })).providers;

    expect(models.get("anthropic_api")).toEqual(new Set(["claude-page-one", "claude-page-two"]));
    expect(models.get("google_api")).toEqual(new Set(["gemini-page-one", "gemini-page-two"]));
    expect(urls.some((url) => url.includes("after_id=cursor-a"))).toBe(true);
    expect(urls.some((url) => url.includes("pageToken=cursor-g"))).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

async function vertexListingClient(refreshes: { count: number }, probes: string[]) {
  const root = temporaryDirectory("flywheel-vertex-held-listing-");
  const access = await new AuthProfileStore(root).create("default");
  access.writeFile("auth.json", JSON.stringify({ google_vertex: { type: "api_key", key: "vertex", lineageId: LINEAGE } }));
  const authDir = access.authDirectory;
  access.close();
  return createModelListingClient({
    classifySlot,
    authDir,
    providers: createAccessProviderSelection(testProviderSelection().definitions.map((definition) =>
      definition.id !== "google_vertex" || definition.dynamicCatalog === undefined ? definition : {
        ...definition,
        dynamicCatalog: {
          ...definition.dynamicCatalog,
          probeAccess: async ({ wireModelId }) => { probes.push(wireModelId); return "completed"; },
        },
      })),
    modelsClient: {
      refresh: async () => { refreshes.count += 1; },
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: (providers) => providers.includes("google-vertex")
        ? ["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001", "claude-sonnet-4@20250514"].map((wireModelId) => ({
            providerId: "google-vertex",
            providerName: "Vertex",
            wireModelId,
            metadata: modelInfo("google", wireModelId, "gemini", 0, 0, "2026-01-01"),
            provenance: "bundled" as const,
            canonical: { providerId: "google", modelId: wireModelId },
            transport: { npm: "@ai-sdk/google-vertex" },
          }))
        : [],
    },
  });
}

const VERTEX_AUTH: AuthContext = { ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { google_vertex: "vertex" } }), credentialLineages: { google_vertex: LINEAGE } };

test("Google Vertex derives every Gemini chat model from models.dev", async () => {
  const probes: string[] = [];
  const client = await vertexListingClient({ count: 0 }, probes);
  const catalogs = await client.getModelCatalogs(VERTEX_AUTH, { mode: "fresh" });
  const candidate = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }));

  expect(new Set(candidate?.visibleModels?.keys())).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(catalogs.providers.get("google_vertex")).toBeUndefined();
  expect(probes).toEqual([]);
  const checked = await client.getModelCatalogs(VERTEX_AUTH, { mode: "audit" });
  expect(new Set(probes)).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(checked.providers.get("google_vertex")).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
});

test("cached-first discovery shows pending Google Vertex candidates and admits checked models without a metadata refresh", async () => {
  const refreshes = { count: 0 };
  const probes: string[] = [];
  const client = await vertexListingClient(refreshes, probes);
  const catalogs = await client.getModelCatalogs(VERTEX_AUTH, { mode: "cached-first" });
  const candidate = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }));

  expect(new Set(candidate?.visibleModels?.keys())).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(catalogs.providers.get("google_vertex")).toBeUndefined();
  expect(candidate?.models).toBeNull();
  expect(candidate?.outcome).toEqual({ kind: "unavailable", reason: "discovery-pending" });
  expect(probes).toEqual([]);
  expect(refreshes.count).toBe(0);
  await client.getModelCatalogs(VERTEX_AUTH, { mode: "refresh" });
  await client.getModelCatalogs(VERTEX_AUTH, { mode: "audit" });
  const checked = await client.getModelCatalogs(VERTEX_AUTH, { mode: "cached-first" });
  expect(probes).toHaveLength(3);
  expect(checked.providers.get("google_vertex")).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(checked.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }))?.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled" });
  expect(refreshes.count).toBe(0);
});

test("configured custom providers publish static singleton candidate catalogs", async () => {
  installCustomProviders([{
    id: "local_llama",
    displayName: "Local Llama",
    baseUrl: "http://localhost:8080/v1",
    modelIds: new Set(["llama-3.3-70b", "gpt-4o", "local-contributor", "gpt-4o-contributor"]),
    catalogId: undefined,
    contextLimit: 128_000,
  }]);
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
    });
    const candidate = { kind: "singleton", providerId: "local_llama", spendMode: "direct_api" } as const;
    const catalogs = await client.getModelCatalogs({
      ...AUTH_NONE,
      providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { local_llama: "local-key" } }),
    });

    expect(catalogs.providers.get("local_llama")).toEqual(new Set(["llama-3.3-70b", "gpt-4o", "local"]));
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
      ]),
    });
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the settlement deadline cancels admitted work before publishing its fallback", async () => {
  let settled = false;
  const definition = delayedProvider(async ({ signal, credential }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      settled = true;
      resolve();
    }, { once: true }));
    return { discovery: { kind: "failed", reason: "timeout" }, credential };
  });
  const modelsClient = {
    async refresh() {},
    getProviderCatalog() {
      return [{
        providerId: "openai",
        providerName: "OpenAI",
        wireModelId: "gpt-5.4",
        metadata: modelInfo("openai", "gpt-5.4", "gpt", 2.5, 15, "2026-03-01"),
        provenance: "live" as const,
        canonical: { providerId: "openai", modelId: "gpt-5.4" },
        transport: { npm: "@ai-sdk/openai" },
      }];
    },
    getTokenizerIdentity() { return undefined; },
  };
  const client = createModelListingClient({
    classifySlot,
    authDir: AUTH_DIR,
    providers: createAccessProviderSelection([definition]),
    modelsClient,
    settlementTimeoutMs: 1,
    maxFetchConcurrency: 1,
  });
  const auth: AuthContext = {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: "revision" },
  };

  const catalogs = await client.getModelCatalogs(auth, { mode: "fresh" });

  expect(settled).toBe(true);
  expect(catalogs.providers.get("delayed")).toEqual(new Set(["gpt-5.4"]));
});

test("caller cancellation suppresses publication after admitted work settles", async () => {
  let settled = false;
  const definition = delayedProvider(async ({ credential, signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => queueMicrotask(resolve), { once: true }));
    settled = true;
    return { discovery: { kind: "failed", reason: "timeout" }, credential };
  });
  const client = createModelListingClient({
    classifySlot,
    authDir: AUTH_DIR,
    providers: createAccessProviderSelection([definition]),
    settlementTimeoutMs: 15,
  });
  const auth: AuthContext = {
    ...AUTH_NONE,
    providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { delayed: "key" } }),
    credentialLineages: { delayed: "revision" },
  };
  const controller = new AbortController();
  const pending = client.getModelCatalogs(auth, { signal: controller.signal, mode: "fresh" });
  controller.abort();

  const catalogs = await pending;

  expect(settled).toBe(true);
  expect(catalogs.providers.size).toBe(0);
  expect(catalogs.candidates.size).toBe(0);
});
