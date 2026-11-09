import { describe, expect, spyOn, test } from "bun:test";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { groupedOfferingIndex, normalizeCatalogRows, normalizeDecodedCatalogRows, normalizeResolvedCatalogRows, recordUnresolvedModelRelationships, resolveModelCatalog, validateCanonicalRows, type CatalogDiscovery, type CatalogJsonValue, type CatalogSourceRow, type ModelCatalogContribution, type ResolvedModelCatalog } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { createModelListingClient, fetchCatalog } from "../../../../src/infra/llm/model-listing.js";
import { providerModelInfo } from "../../../../src/infra/llm/provider-model-info.js";
import { canonicalTestRow, TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { makeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js";

const contribution: ModelCatalogContribution = {
  limits: TEST_CATALOG_LIMITS,
  extractRows: (body) => Array.isArray(body) ? body : [],
  canonicalize: canonicalTestRow,
  modelsDevCatalogIds: ["test"],
};
const row = (id: string) => ({ id });
const bundled = [row("bundled"), row("blocked-model"), row("wrong-family-model")];

test("unresolved relationship diagnostics bound retained IDs", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const ids = [`a/${"x".repeat(510)}`, `b/${"x".repeat(510)}`, `c/${"x".repeat(510)}`, "~vendor/latest"];
  try {
    recordUnresolvedModelRelationships("aggregator", { total: ids.length, values: ids });
    expect(record).toHaveBeenCalledWith({
      type: "model.catalog.relationship_unresolved",
      payload: {
        providerId: "aggregator",
        total: 4,
        wireModelIds: [ids[0], ids[3]],
        omitted: 2,
      },
    });
  } finally {
    record.mockRestore();
  }
});

function resolve(live: CatalogDiscovery, fallback: readonly unknown[] | undefined = bundled): ResolvedModelCatalog {
  const normalized = fallback === undefined ? undefined : normalizeCatalogRows(fallback, contribution);
  return resolveModelCatalog({ authenticated: true, live, canonicalFallback: normalized?.kind === "valid" ? normalized.rows : undefined, contribution });
}

describe("model catalog resolution", () => {
  test("passes canonical-shaped raw rows through the exact provider decoder", () => {
    const decoderCalls: unknown[] = [];
    const normalized = normalizeCatalogRows([{
      modelId: "bypass",
      wireModelId: "bypass",
      metadata: null,
    }], {
      ...contribution,
      canonicalize: (candidate) => {
        decoderCalls.push(candidate);
        return undefined;
      },
    });
    expect(decoderCalls).toHaveLength(1);
    expect(normalized).toEqual({ kind: "valid", rows: [] });
  });

  test("uses enriched first-party rows before eligible models.dev fallback", () => {
    expect(resolve({ kind: "rows", rows: [row("live")] })).toEqual({ kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [{ modelId: "live", offerings: [{ wireModelId: "live", metadata: null, dataUse: "standard" }] }] });
    for (const reason of ["http", "timeout", "transport", "malformed", "oversized"] as const) {
      expect(resolve({ kind: "failed", reason })).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled", liveOutcome: "discovery-failed" });
    }
    expect(resolve({ kind: "rows", rows: [] })).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled", liveOutcome: "empty" });
    expect(resolve({ kind: "rows", rows: [row("")] })).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled", liveOutcome: "unusable" });
    expect(resolve({ kind: "failed", reason: "transport" })).toMatchObject({ rows: [
      { modelId: "bundled", offerings: [{ wireModelId: "bundled", metadata: null, dataUse: "standard" }] },
      { modelId: "blocked-model", offerings: [{ wireModelId: "blocked-model", metadata: null, dataUse: "standard" }] },
      { modelId: "wrong-family-model", offerings: [{ wireModelId: "wrong-family-model", metadata: null, dataUse: "standard" }] },
    ] });
  });

  test("valid live rows, fresh or saved, are the whole catalog: a models.dev row they omit never joins it", () => {
    const fallback = normalizeCatalogRows([row("bundled"), row("older")], contribution);
    if (fallback.kind !== "valid") throw new Error("fixture rows must be valid");
    const live = { modelId: "newest", offerings: [{ wireModelId: "newest", metadata: { endpoint: "cli" }, dataUse: "standard" as const }] };
    const overlap = { modelId: "bundled", offerings: [{ wireModelId: "bundled", metadata: { endpoint: "cli" }, dataUse: "standard" as const }] };

    expect(resolveModelCatalog({ authenticated: true, live: { kind: "rows", rows: [{ id: "newest", endpoint: "cli" }, { id: "bundled", endpoint: "cli" }] }, canonicalFallback: fallback.rows, contribution }))
      .toEqual({ kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [live, overlap] });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "not-attempted" }, cachedFirstParty: [live, overlap], firstPartyProvenance: "first-party-cached", canonicalFallback: fallback.rows, contribution }))
      .toEqual({ kind: "catalog", provenance: "first-party-cached", liveOutcome: "valid", rows: [live, overlap] });
  });

  test("keeps provider model metadata authoritative over models.dev metadata", () => {
    const provider = providerModelInfo({
      provider: "openai",
      id: "gpt-next",
      modelFamily: "provider",
      releaseDate: "2026-09-22",
      pricing: { status: "unavailable", reason: "missing-rate-card" },
    });
    const fallback = modelInfo("openai", "gpt-next", "fallback", 9, 99, "2026-09-01");
    const outcome = resolveModelCatalog({
      authenticated: true,
      live: { kind: "decoded-rows", rows: [{ modelId: "gpt-next", wireModelId: "gpt-next", metadata: { source: "provider" }, resolvedMetadata: provider }] },
      canonicalFallback: [{
        modelId: "gpt-next",
        offerings: [{ wireModelId: "gpt-next", metadata: { source: "models.dev" }, dataUse: "standard", resolvedMetadata: fallback }],
      }],
      contribution,
    });
    expect(outcome).toMatchObject({
      kind: "catalog",
      rows: [{ offerings: [{ metadata: { source: "provider" }, resolvedMetadata: { modelFamily: "provider", releaseDate: "2026-09-22" } }] }],
    });
  });

  test("keeps valid first-party rows when merged metadata exceeds contribution bounds", () => {
    const constrained = { ...contribution, limits: { ...TEST_CATALOG_LIMITS, metadataNodes: 4 } };
    const outcome = resolveModelCatalog({
      authenticated: true,
      live: { kind: "decoded-rows", rows: [{ modelId: "gpt-next", wireModelId: "gpt-next", metadata: { provider: true } }] },
      canonicalFallback: [{
        modelId: "gpt-next",
        offerings: [{ wireModelId: "gpt-next", metadata: { nested: { one: 1, two: 2 } }, dataUse: "standard" }],
      }],
      contribution: constrained,
    });
    expect(outcome).toEqual({
      kind: "catalog",
      provenance: "first-party",
      liveOutcome: "valid",
      rows: [{ modelId: "gpt-next", offerings: [{ wireModelId: "gpt-next", metadata: { provider: true }, dataUse: "standard" }] }],
    });
  });

  test("fills omitted provider capabilities but preserves explicit false", () => {
    const fallback = modelInfo("openai", "gpt-next", "fallback", 9, 99, "2026-09-01", {
      reasoning: true,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
    const resolveProvider = (provider: ReturnType<typeof providerModelInfo>) => resolveModelCatalog({
      authenticated: true,
      live: { kind: "decoded-rows", rows: [{ modelId: "gpt-next", wireModelId: "gpt-next", metadata: null, resolvedMetadata: provider }] },
      canonicalFallback: [{ modelId: "gpt-next", offerings: [{ wireModelId: "gpt-next", metadata: null, dataUse: "standard", resolvedMetadata: fallback }] }],
      contribution,
    });
    expect(resolveProvider(providerModelInfo({ provider: "openai", id: "gpt-next" }))).toMatchObject({
      kind: "catalog",
      rows: [{ offerings: [{ resolvedMetadata: { reasoning: true, attachment: true, modalities: { input: ["text", "image"] } } }] }],
    });
    expect(resolveProvider(providerModelInfo({
      provider: "openai", id: "gpt-next", reasoning: false, attachment: false, modalities: { input: ["text"], output: ["text"] },
    }))).toMatchObject({
      kind: "catalog",
      rows: [{ offerings: [{ resolvedMetadata: { reasoning: false, attachment: false, modalities: { input: ["text"] } } }] }],
    });
  });

  test("enriches validated cached canonical offerings without changing their data-use identity", () => {
    const cached = [{
      modelId: "paired",
      offerings: [
        { wireModelId: "paired", metadata: { source: "provider" }, dataUse: "standard" as const, transport: "openai-responses" as const },
        { wireModelId: "paired-contributor", metadata: { source: "provider" }, dataUse: "contributor" as const, transport: "openai-completions" as const },
      ],
    }];
    const outcome = resolveModelCatalog({
      authenticated: true,
      live: { kind: "not-attempted" },
      cachedFirstParty: cached,
      canonicalFallback: [],
      contribution,
      firstPartyProvenance: "first-party-cached",
    });

    expect(outcome).toMatchObject({
      kind: "catalog",
      provenance: "first-party-cached",
      rows: [{
        modelId: "paired",
        offerings: [
          { wireModelId: "paired", dataUse: "standard", transport: "openai-responses" },
          { wireModelId: "paired-contributor", dataUse: "contributor", transport: "openai-completions" },
        ],
      }],
    });
  });

  test("preserves paid and free routes for one canonical model", () => {
    expect(normalizeDecodedCatalogRows([
      { modelId: "model", wireModelId: "vendor/model", metadata: null },
      { modelId: "model", wireModelId: "vendor/model:free", metadata: null, routeKind: "free" },
    ], TEST_CATALOG_LIMITS)).toEqual({
      kind: "valid",
      rows: [{
        modelId: "model",
        offerings: [
          { wireModelId: "vendor/model", metadata: null, dataUse: "standard" },
          { wireModelId: "vendor/model:free", metadata: null, dataUse: "standard", routeKind: "free" },
        ],
      }],
    });
  });

  test("keeps authentication and discovery outcomes explicit", () => {
    expect(resolveModelCatalog({ authenticated: false, live: { kind: "not-attempted" }, canonicalFallback: [], contribution })).toEqual({ kind: "unavailable", reason: "authentication-absent" });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "auth-invalid" }, canonicalFallback: undefined, contribution })).toEqual({ kind: "unavailable", reason: "authentication-invalid" });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "auth-invalid" }, canonicalFallback: [], contribution })).toEqual({ kind: "unavailable", reason: "authentication-invalid" });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "rows", rows: [] }, canonicalFallback: undefined, contribution })).toEqual({ kind: "unavailable", reason: "empty" });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "rows", rows: [row("blocked-model")] }, canonicalFallback: undefined, contribution })).toMatchObject({
      kind: "catalog",
      provenance: "first-party",
      rows: [{ modelId: "blocked-model" }],
    });
    expect(resolveModelCatalog({ authenticated: true, live: { kind: "failed", reason: "timeout" }, canonicalFallback: undefined, contribution })).toEqual({ kind: "unavailable", reason: "discovery-failed", discoveryReason: "timeout" });
  });

  test("filters malformed rows before cardinality and rejects valid overflow whole", () => {
    expect(normalizeCatalogRows([row("one"), {}, {}, row("two"), row("three")], contribution)).toEqual({ kind: "valid", rows: [
      { modelId: "one", offerings: [{ wireModelId: "one", metadata: null, dataUse: "standard" }] },
      { modelId: "two", offerings: [{ wireModelId: "two", metadata: null, dataUse: "standard" }] },
      { modelId: "three", offerings: [{ wireModelId: "three", metadata: null, dataUse: "standard" }] },
    ] });
    expect(normalizeCatalogRows([row("one"), row("two"), row("three"), row("four")], contribution)).toEqual({ kind: "rejected", reason: "too-many-rows" });
  });

  test("consolidates punctuation aliases without owning discovery diagnostics", () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    try {
      expect(normalizeCatalogRows([row("gpt-6.1-sol"), row("gpt-6-1-sol")], contribution)).toEqual({ kind: "valid", rows: [
        { modelId: "gpt-6.1-sol", offerings: [{ wireModelId: "gpt-6-1-sol", metadata: null, dataUse: "standard" }] },
      ] });
      expect(record).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
    expect(normalizeCatalogRows([row("x".repeat(33))], contribution)).toEqual({ kind: "rejected", reason: "model-id-too-long" });
    expect(normalizeCatalogRows([
      { id: "gpt-6.1-sol", endpoint: "one" },
      { id: "gpt-6.1-sol", endpoint: "two" },
    ], contribution)).toEqual({ kind: "rejected", reason: "duplicate-model" });
    expect(normalizeCatalogRows([row("gpt-6-1-sol-contributor"), row("gpt-6.1-sol-contributor"), row("gpt-6-1-sol")], contribution)).toEqual({
      kind: "valid",
      rows: [{
        modelId: "gpt-6.1-sol",
        offerings: [
          { wireModelId: "gpt-6-1-sol", metadata: null, dataUse: "standard" },
          { wireModelId: "gpt-6-1-sol-contributor", metadata: null, dataUse: "contributor" },
        ],
      }],
    });
    expect(resolve({ kind: "failed", reason: "oversized" })).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled" });
    expect(validateCanonicalRows([{ modelId: "gpt-5\u001b[2J", offerings: [{ wireModelId: "gpt-5", metadata: null, dataUse: "standard" }] }], TEST_CATALOG_LIMITS)).toEqual({ kind: "rejected", reason: "invalid-canonical-row" });
  });

  test("keeps canonical normalization diagnostic-free for source owners", () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    try {
      const longRows: CatalogSourceRow[] = Array.from({ length: 10_000 }, (_, index) => ({
        modelId: "shared",
        wireModelId: `${index.toString().padStart(5, "0")}-${"x".repeat(506)}`,
        metadata: null,
      }));
      const limits = { ...TEST_CATALOG_LIMITS, canonicalRows: 10_000, modelIdLength: 512 };
      expect(normalizeDecodedCatalogRows(longRows, limits).kind).toBe("valid");
      expect(record).not.toHaveBeenCalled();
      expect(normalizeResolvedCatalogRows(longRows, limits).kind).toBe("valid");
      expect(record).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
  });

  test("keeps exact wire metadata paired across punctuation collisions and source order", () => {
    const dotted = modelInfo("openai", "gpt-6.1-sol", "dotted", 1, 2, "2026-01-01");
    const dashed = modelInfo("openai", "gpt-6-1-sol", "dashed", 3, 4, "2026-01-02");
    const rows: readonly CatalogSourceRow[] = [
      { modelId: "gpt-6.1-sol", wireModelId: "gpt-6.1-sol", metadata: null, resolvedMetadata: dotted },
      { modelId: "gpt-6-1-sol", wireModelId: "gpt-6-1-sol", metadata: null, resolvedMetadata: dashed },
    ];
    for (const ordered of [rows, rows.toReversed()]) {
      const normalized = normalizeDecodedCatalogRows(ordered, contribution.limits);
      expect(normalized).toMatchObject({
        kind: "valid",
        rows: [{ offerings: [{ wireModelId: "gpt-6-1-sol", resolvedMetadata: { provider: "openai", id: "gpt-6-1-sol" } }] }],
      });
    }
  });

  test("coalesces dated snapshots under the undated identity with route precedence", () => {
    const older = modelInfo("anthropic", "claude-opus-4-6-20260101", "older", 1, 2, "2026-01-01");
    const newer = modelInfo("anthropic", "claude-opus-4-6-2026-02-01", "newer", 3, 4, "2026-02-01");
    const stable = modelInfo("anthropic", "claude-opus-4-6", "stable", 5, 6, "2026-02-02");
    const datedRows: readonly CatalogSourceRow[] = [
      { modelId: older.id, wireModelId: older.id, metadata: null, resolvedMetadata: older },
      { modelId: newer.id, wireModelId: newer.id, metadata: null, resolvedMetadata: newer },
    ];
    expect(normalizeDecodedCatalogRows(datedRows, contribution.limits)).toMatchObject({
      kind: "valid",
      rows: [{ modelId: "claude-opus-4.6", offerings: [{ wireModelId: newer.id, resolvedMetadata: { modelFamily: "newer" } }] }],
    });
    expect(normalizeDecodedCatalogRows([...datedRows, {
      modelId: stable.id,
      wireModelId: stable.id,
      metadata: null,
      resolvedMetadata: stable,
    }], contribution.limits)).toMatchObject({
      kind: "valid",
      rows: [{ modelId: "claude-opus-4.6", offerings: [{ wireModelId: stable.id, resolvedMetadata: { modelFamily: "stable" } }] }],
    });
    expect(normalizeDecodedCatalogRows([
      ...datedRows,
      { modelId: "gpt-6-1-sol-20260101", wireModelId: "gpt-6-1-sol-20260101", metadata: null, resolvedMetadata: older },
      { modelId: "gpt-6-1-sol-20260201-contributor", wireModelId: "gpt-6-1-sol-20260201-contributor", metadata: null, dataUse: "contributor", resolvedMetadata: newer },
    ], contribution.limits)).toMatchObject({
      kind: "valid",
      rows: [{
        modelId: "claude-opus-4.6",
        offerings: [
          { wireModelId: newer.id, dataUse: "standard" },
        ],
      }, {
        modelId: "gpt-6.1-sol",
        offerings: [
          { wireModelId: "gpt-6-1-sol-20260101", dataUse: "standard" },
          { wireModelId: "gpt-6-1-sol-20260201-contributor", dataUse: "contributor" },
        ],
      }],
    });
  });

  test("indexes canonical rows by canonical, contributor, namespaced, and free-route offering ids", () => {
    const model = { modelId: "gpt-6.1-sol", freeRoute: false };
    expect(groupedOfferingIndex([{
      modelId: "gpt-6.1-sol",
      offerings: [
        { wireModelId: "openai/gpt-6-1-sol", metadata: null, dataUse: "standard" },
        { wireModelId: "gpt-6-1-sol-contributor", metadata: null, dataUse: "contributor" },
        { wireModelId: "gpt-6-1-sol-free", metadata: null, dataUse: "standard", routeKind: "free" },
      ],
    }])).toEqual(new Map([
      ["gpt-6.1-sol", model],
      ["openai/gpt-6.1-sol", model],
      ["gpt-6.1-sol-contributor", model],
      ["gpt-6.1-sol-free", { modelId: "gpt-6.1-sol", freeRoute: true }],
    ]));
  });

  test("iteratively rejects metadata beyond its depth and node bounds", () => {
    const bounded = (metadata: CatalogJsonValue): ModelCatalogContribution => ({
      ...contribution,
      limits: { ...TEST_CATALOG_LIMITS, metadataDepth: 4, metadataNodes: 6 },
      canonicalize: (): CatalogSourceRow => ({ modelId: "bounded", wireModelId: "bounded", metadata }),
    });
    let deep: CatalogJsonValue = {};
    for (let index = 0; index < 10_000; index += 1) deep = { child: deep };

    expect(normalizeCatalogRows([{}], bounded(deep))).toEqual({ kind: "rejected", reason: "invalid-canonical-row" });
    expect(normalizeCatalogRows([{}], bounded([1, 2, 3, 4, 5, 6]))).toEqual({ kind: "rejected", reason: "invalid-canonical-row" });
    expect(normalizeCatalogRows([{}], bounded({ billing: { multiplier: 1 } }))).toMatchObject({ kind: "valid" });
  });

  test("does not memoize fresh discovery inside a listing client", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(async () => {
      requests += 1;
      return Response.json([{ id: "gpt-5.4", endpoint: "responses" }]);
    }, { preconnect: originalFetch.preconnect });
    try {
      const definition: AccessProviderDefinition = {
        id: "openai_api",
        displayName: "OpenAI",
        shortName: "OpenAI",
        rank: 1,
        supportedFamilies: ["openai"],
        configHints: [],
        catalogId: undefined,
        dynamicCatalog: {
          ...contribution,
          fetch: async ({ credential, signal }) => ({ discovery: await fetchCatalog("https://api.openai.com/v1/models", {}, contribution, signal), credential }),
        },
        auth: { kind: "api_key", statusRank: 1 },
        cli: { name: "test" },
        staticModelUnavailableReason: () => undefined,
        billing: "metered",
        spendMode: "direct_api",
      };
      const auth: AuthContext = {
        providers: authProviders({ apiKeys: { openai_api: "key" } }),
        credentialLineages: { openai_api: "lineage" },
        droppedCredentials: [],
      };
      const modelsClient = makeModelsClient({});
      let modelResolutions = 0;
      const client = createModelListingClient({
        classifySlot: () => "metered",
        authDir: "/does-not-exist",
        oauthPersistence: "access-only",
        providers: createAccessProviderSelection([definition]),
        captureSubscriptions: () => new Map(),
        modelsClient: {
          ...modelsClient,
          getProviderCatalog() {
            modelResolutions += 1;
            return [{
              providerId: "test",
              providerName: "Test",
              wireModelId: "gpt-5.4",
              metadata: modelInfo("openai", "gpt-5.4", "gpt", 2.5, 15, "2026-03-01"),
              provenance: "live",
              canonical: { providerId: "test", modelId: "gpt-5.4" },
              transport: null,
            }];
          },
        },
      });
      const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const;
      const cold = (await client.getModelCatalogs(auth, { mode: "fresh" })).candidates.get(accessProviderAccountKey(candidate));
      const warm = (await client.getModelCatalogs(auth, { mode: "fresh" })).candidates.get(accessProviderAccountKey(candidate));

      expect(requests).toBe(2);
      expect(modelResolutions).toBe(2);
      expect(cold?.outcome).not.toBe(warm?.outcome);
      expect(warm?.outcome).toMatchObject({ kind: "catalog", provenance: "first-party", rows: [{ offerings: [{ metadata: { endpoint: "responses" } }] }] });
      expect(warm?.models?.get("gpt-5.4")?.[0]?.resolvedMetadata).toMatchObject({
        id: "gpt-5.4",
        cost: { input: expect.any(Number), output: expect.any(Number) },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
