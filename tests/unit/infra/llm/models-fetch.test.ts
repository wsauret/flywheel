import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModelsClient } from "../../../../src/infra/llm/models.js";
import { admitCurrentModelsDocument } from "../../../../src/infra/llm/models-document.js";
import { normalizeDecodedCatalogRows } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { combinedModelsDevJson, combinedModelsDevProviders, modelsDevDocument, modelsDevJson } from "../../../helpers/model-catalog-fixtures.js";

const ANTHROPIC_JSON = combinedModelsDevJson({ cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, reasoning: 15 } });
const CATALOG_ROW_LIMIT = 100;

describe("createModelsClient fetch path", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: number;
  let tmpDir: string;
  let snapshotFile: string;

  beforeEach(() => {
    fetchCalls = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-models-test-"));
    snapshotFile = path.join(tmpDir, "models.json");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockFetch(respond: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): void {
    const mock = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      return respond(input, init);
    };
    globalThis.fetch = Object.assign(mock, { preconnect: originalFetch.preconnect });
  }

  function makeClient() {
    return createModelsClient(snapshotFile);
  }

  function heldAdmission() {
    const entered = Promise.withResolvers<AbortSignal>();
    const released = Promise.withResolvers<void>();
    let calls = 0;
    return {
      entered: entered.promise,
      release: () => released.resolve(),
      calls: () => calls,
      run: async (bytes: Uint8Array, signal: AbortSignal) => {
        calls += 1;
        entered.resolve(signal);
        await released.promise;
        return admitCurrentModelsDocument(bytes);
      },
    };
  }

  it("loads the archive without network and publishes an explicit refresh", async () => {
    const archive = modelsDevJson({ cost: { input: 1, output: 2 } });
    fs.writeFileSync(snapshotFile, archive);
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const admission = heldAdmission();
    const client = createModelsClient(snapshotFile, admission.run);

    const first = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0];
    expect(first).toEqual(expect.objectContaining({
      providerId: "anthropic",
      wireModelId: "claude-3-5-sonnet",
      provenance: "last-known-good",
      metadata: expect.objectContaining({ provider: "anthropic", id: "claude-3-5-sonnet", cost: expect.objectContaining({ input: 1 }) }),
    }));
    expect(fetchCalls).toBe(0);

    const refreshing = client.refresh(new AbortController().signal);
    expect(await Promise.race([admission.entered.then(() => true), refreshing.then(() => false)])).toBe(true);
    expect(client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0]).toEqual(first);
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(archive);
    admission.release();
    await refreshing;
    const second = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0];

    expect(second?.metadata.cost.input).toBe(3);
    expect(fetchCalls).toBe(1);
    expect(admission.calls()).toBe(1);
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(ANTHROPIC_JSON);
    expect(second?.metadata.pricing).toEqual({
      status: "available",
      rateCard: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, reasoning: 15 },
      provenance: { source: "models.dev", catalog: "live", provider: "anthropic", model: "claude-3-5-sonnet" },
    });
    expect(Object.isFrozen(second?.metadata.pricing)).toBe(true);
    expect(Object.isFrozen(second?.metadata.pricing.status === "available" ? second.metadata.pricing.rateCard : undefined)).toBe(true);
  });

  it("rejects persisted models.dev prices with invalid optional rates", async () => {
    for (const cost of [
      { input: 1, output: 2, cache_read: -1 },
      { input: 1, output: 2, cache_write: Number.POSITIVE_INFINITY },
      { input: 1, output: 2, reasoning: Number.NaN },
      { input: 1, output: 2, context_over_200k: { input: -1 } },
    ]) {
      fs.writeFileSync(snapshotFile, combinedModelsDevJson({ cost }));
      const rows = createModelsClient(snapshotFile).getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
      expect(rows[0]?.provenance).toBe("bundled");
    }
  });

  it("converts a legacy archive in memory without rewriting it, then refreshes to the combined shape", async () => {
    const legacy = modelsDevJson({ cost: { input: 1, output: 2 } });
    const current = combinedModelsDevJson({ cost: { input: 3, output: 4 } });
    fs.writeFileSync(snapshotFile, legacy);
    mockFetch(() => new Response(current, { status: 200 }));
    const client = makeClient();

    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.canonical)
      .toEqual({ providerId: "anthropic", modelId: "claude-3.5-sonnet" });
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(legacy);

    await client.refresh(new AbortController().signal);

    expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8"))).toHaveProperty("providers");
    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.cost.input).toBe(3);
    const refreshedBytes = fs.readFileSync(snapshotFile);
    const reloaded = createModelsClient(snapshotFile);
    const archived = (reloaded.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0];
    expect(archived).toEqual(expect.objectContaining({
      provenance: "last-known-good",
      canonical: { providerId: "anthropic", modelId: "claude-3.5-sonnet" },
    }));
    expect(fs.readFileSync(snapshotFile)).toEqual(refreshedBytes);
  });

  it("serves the bundled snapshot without a request when no archive exists, then archives an explicit refresh", async () => {
    mockFetch((input, init) => {
      expect(String(input)).toBe("https://models.dev/catalog.json");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
      return new Response(ANTHROPIC_JSON, { status: 200 });
    });
    const client = makeClient();

    expect(client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0]?.provenance).toBe("bundled");
    expect(fetchCalls).toBe(0);
    expect(fs.existsSync(snapshotFile)).toBe(false);

    await client.refresh(new AbortController().signal);

    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(ANTHROPIC_JSON);
    const live = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0];
    expect(live?.provenance).toBe("live");
    expect(live?.metadata.cost.input).toBe(3);
    expect(fetchCalls).toBe(1);
  });

  it("rejects an extended combined envelope without replacing the archive", async () => {
    fs.writeFileSync(snapshotFile, ANTHROPIC_JSON);
    const extended = JSON.stringify({ ...JSON.parse(ANTHROPIC_JSON), revision: 2 });
    mockFetch(() => new Response(extended, { status: 200 }));
    const client = makeClient();

    await client.refresh(new AbortController().signal);

    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(ANTHROPIC_JSON);
    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.cost.input).toBe(3);
  });

  it("keeps serving the bundled snapshot after a failed refresh", async () => {
    mockFetch(() => new Response("unavailable", { status: 503 }));
    const client = makeClient();

    await client.refresh(new AbortController().signal);

    const row = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT).find((candidate) => candidate.wireModelId === "claude-sonnet-4-5");
    expect(row?.metadata.provider).toBe("anthropic");
    expect(row?.provenance).toBe("bundled");
    expect(fetchCalls).toBe(1);
  });

  it("settles an aborted refresh and retains the current document after failure", async () => {
    fs.writeFileSync(snapshotFile, modelsDevJson({ cost: { input: 1, output: 2 } }));
    let fetchSettled = false;
    mockFetch(async (_input, init) => {
      try {
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        fetchSettled = true;
      }
      return new Response();
    });
    const client = makeClient();
    const controller = new AbortController();
    const refreshing = client.refresh(controller.signal);
    controller.abort(new DOMException("runtime disposed", "AbortError"));

    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSettled).toBe(true);
    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.cost.input).toBe(1);

    mockFetch(() => new Response("unavailable", { status: 503 }));
    await client.refresh(new AbortController().signal);
    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.cost.input).toBe(1);

    const archive = fs.readFileSync(snapshotFile, "utf8");
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const admission = heldAdmission();
    const admittingClient = createModelsClient(snapshotFile, admission.run);
    const admissionController = new AbortController();
    let settled = false;
    const admitting = admittingClient.refresh(admissionController.signal).finally(() => { settled = true; });
    expect(await Promise.race([admission.entered.then(() => true), admitting.then(() => false)])).toBe(true);
    const rejected = admitting.catch((error: unknown) => error);
    const ownerSignal = await admission.entered;
    const withdrawn = new Promise<void>((resolve) => ownerSignal.addEventListener("abort", () => resolve(), { once: true }));
    admissionController.abort(new DOMException("runtime disposed during admission", "AbortError"));
    await withdrawn;
    expect(settled).toBe(false);
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(archive);
    admission.release();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(archive);
    expect(admittingClient.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0]?.metadata.cost.input).toBe(1);
  });

  it("coalesces admission and lets one waiter abort without withdrawing another", async () => {
    fs.writeFileSync(snapshotFile, modelsDevJson({ cost: { input: 1, output: 2 } }));
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const admission = heldAdmission();
    const client = createModelsClient(snapshotFile, admission.run);
    const controller = new AbortController();
    const first = client.refresh(controller.signal);
    const second = client.refresh(new AbortController().signal);
    expect(await Promise.race([admission.entered.then(() => true), second.then(() => false)])).toBe(true);
    const rejected = first.catch((error: unknown) => error);
    const ownerSignal = await admission.entered;
    controller.abort(new DOMException("view closed", "AbortError"));
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(ownerSignal.aborted).toBe(false);
    expect(fetchCalls).toBe(1);
    expect(admission.calls()).toBe(1);
    expect(client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0]?.metadata.cost.input).toBe(1);
    admission.release();
    await second;
    expect(client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)[0]?.metadata.cost.input).toBe(3);
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(ANTHROPIC_JSON);
  });

  it("batches exact provider pricing without substituting another provider", async () => {
    const document = modelsDevDocument({ cost: { input: 0, output: 0 } });
    document["provider-1"] = {
      name: "provider-1",
      models: {
        "claude-3-5-sonnet": {
          id: "claude-3-5-sonnet",
          cost: { input: 9, output: 18 },
        },
      },
    };
    mockFetch(() => new Response(JSON.stringify(combinedModelsDevProviders(document)), { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);
    const rows = client.getProviderCatalog(["anthropic", "provider-1"], CATALOG_ROW_LIMIT);
    const result = new Map(rows.map((row) => [`${row.providerId}/${row.wireModelId}`, row]));

    expect(result.get("anthropic/claude-3-5-sonnet")?.metadata).toEqual(expect.objectContaining({
      provider: "anthropic",
      id: "claude-3-5-sonnet",
      cost: expect.objectContaining({ input: 0 }),
    }));
    expect(result.get("provider-1/claude-3-5-sonnet")?.metadata).toEqual(expect.objectContaining({
      provider: "provider-1",
      id: "claude-3-5-sonnet",
      cost: expect.objectContaining({ input: 9 }),
    }));
    expect(fetchCalls).toBe(1);
  });

  it("normalizes only through the row-limit decision boundary", async () => {
    const document = modelsDevDocument({ cost: { input: 0, output: 0 } });
    document["anthropic"] = {
      name: "Anthropic",
      models: Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
        const id = `claude-limit-${index}`;
        return [id, { id, cost: { input: index, output: index } }];
      })),
    };
    mockFetch(() => new Response(JSON.stringify(combinedModelsDevProviders(document)), { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);

    const rows = client.getProviderCatalog(["anthropic"], 3);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.wireModelId)).toEqual(["claude-limit-0", "claude-limit-1", "claude-limit-2", "claude-limit-3"]);
    expect(normalizeDecodedCatalogRows(rows.map((row) => ({
      modelId: row.wireModelId,
      wireModelId: row.wireModelId,
      metadata: null,
    })), { responseBytes: 1_000, canonicalRows: 3, modelIdLength: 100, durableBytes: 1_000 })).toEqual({
      kind: "rejected",
      reason: "too-many-rows",
    });
  });

  it("resolves only demanded exact relationships in a large namespace", async () => {
    const document = modelsDevDocument({ cost: { input: 0, output: 0 } });
    document["canonical"] = {
      name: "Canonical",
      models: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
        const id = `exact-${index}`;
        return [id, { id, cost: { input: index, output: index } }];
      })),
    };
    document["gateway"] = {
      name: "Gateway",
      models: {
        first: { id: "canonical/exact-0", cost: { input: 1, output: 1 } },
        second: { id: "canonical/exact-1", cost: { input: 2, output: 2 } },
        unrelated: { id: "canonical/exact-999", cost: { input: 3, output: 3 } },
      },
    };
    mockFetch(() => new Response(JSON.stringify(combinedModelsDevProviders(document)), { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);

    const rows = client.getProviderCatalog(["gateway"], 1);

    expect(rows).toHaveLength(2);
    expect(rows.map(({ canonical }) => canonical)).toEqual([
      { providerId: "canonical", modelId: "exact-0" },
      { providerId: "canonical", modelId: "exact-1" },
    ]);
    expect(rows.some(({ wireModelId }) => wireModelId === "canonical/exact-999")).toBe(false);
  });

  it("falls back to the bundled snapshot on a misshapen document instead of publishing it", async () => {
    // Valid JSON, invalid shape: a provider entry whose `models` is not a
    // record of model structs. decodeRawApi rejects it (external boundary).
    mockFetch(() => new Response(JSON.stringify({ anthropic: { name: "Anthropic", models: "not-a-record" } }), { status: 200 }));

    const client = makeClient();
    await client.refresh(new AbortController().signal);

    const rows = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    expect(rows.some((row) => row.wireModelId === "claude-definitely-missing-9.9")).toBe(false);
    expect(rows.find((row) => row.wireModelId === "claude-sonnet-4-5")?.metadata.provider).toBe("anthropic");
  });

  it("serves the bundled snapshot when the fetch fails with no archive, and memoizes it", async () => {
    mockFetch(() => new Response("unavailable", { status: 503 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);

    const bundled = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)).find((row) => row.wireModelId === "claude-sonnet-4-5");
    expect(bundled?.metadata.provider).toBe("anthropic");
    expect(bundled?.metadata.cost.input).toBeGreaterThan(0);
    expect(bundled?.metadata.pricing.status === "available"
      && bundled.metadata.pricing.provenance.source === "models.dev"
      && bundled.metadata.pricing.provenance.catalog).toBe("bundled");

    // The bundled document is memoized for the client lifetime: no refetch.
    client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    expect(fetchCalls).toBe(1);
  });

  it("normalizes reasoning_options into reasoningEfforts at the boundary", async () => {
    const doc = modelsDevDocument({
      cost: { input: 10, output: 50 },
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["none", "minimal", null, "low", "medium", "high", "xhigh", "max"] },
      ],
    });
    mockFetch(() => new Response(JSON.stringify(combinedModelsDevProviders(doc)), { status: 200 }));
    const client = createModelsClient(snapshotFile);
    await client.refresh(new AbortController().signal);

    const model = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata;

    expect(model?.reasoningEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("deep-freezes cached model metadata", async () => {
    mockFetch(() => new Response(combinedModelsDevJson({
      cost: { input: 1, output: 2, context_over_200k: { input: 3, output: 4 } },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    }), { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);
    const first = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]!.metadata;
    if (first.cost.highContext === undefined || first.reasoningEfforts === undefined) throw new Error("fixture metadata is incomplete");

    expect(Reflect.set(first.cost, "input", 99)).toBe(false);
    expect(Reflect.set(first.cost.highContext, "input", 99)).toBe(false);
    expect(Reflect.set(first.modalities.input, first.modalities.input.length, "audio")).toBe(false);
    expect(Reflect.set(first.reasoningEfforts, first.reasoningEfforts.length, "max")).toBe(false);

    const later = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]!.metadata;
    expect(later).toBe(first);
    expect(later.cost.input).toBe(1);
    expect(later.cost.highContext?.input).toBe(3);
    expect(later.modalities.input).toEqual(["text", "image"]);
    expect(later.reasoningEfforts).toEqual(["low", "high"]);
  });

  it("archives admitted response bytes without re-encoding non-ASCII JSON", async () => {
    const bytes = new TextEncoder().encode(combinedModelsDevJson({ name: "Claude é漢字" }));
    mockFetch(() => new Response(bytes, { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);
    expect(fs.readFileSync(snapshotFile)).toEqual(Buffer.from(bytes));
  });

  it("keeps prompt and total context limits as separate catalog facts", async () => {
    const limits = [
      { limit: { input: 105_245, context: 1_048_576, output: 943_718 }, contextLimit: 105_245, totalContextLimit: 1_048_576 },
      { limit: { context: 1_048_576, output: 943_718 }, contextLimit: 1_048_576, totalContextLimit: 1_048_576 },
      { limit: { input: 105_245, output: 943_718 }, contextLimit: 105_245, totalContextLimit: undefined },
    ] as const;

    for (const expected of limits) {
      fs.rmSync(snapshotFile, { force: true });
      mockFetch(() => new Response(combinedModelsDevJson({ cost: { input: 1, output: 1 }, limit: expected.limit }), { status: 200 }));
      const client = makeClient();
      await client.refresh(new AbortController().signal);
      const model = (client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata;
      expect(model?.contextLimit).toBe(expected.contextLimit);
      expect(model?.totalContextLimit).toBe(expected.totalContextLimit);
    }
  });

  it("caps admitted output limits at the largest supported provider maximum", async () => {
    mockFetch(() => new Response(combinedModelsDevJson({ limit: { output: Number.MAX_SAFE_INTEGER } }), { status: 200 }));
    const oversized = makeClient();
    await oversized.refresh(new AbortController().signal);
    expect((oversized.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.outputLimit).toBe(2_000_000);

    fs.rmSync(snapshotFile, { force: true });
    mockFetch(() => new Response(combinedModelsDevJson({ limit: { output: 128_000 } }), { status: 200 }));
    const bounded = makeClient();
    await bounded.refresh(new AbortController().signal);
    expect((bounded.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.outputLimit).toBe(128_000);
  });

  it("builds provider catalog rows lazily while reusing the admitted document", async () => {
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const client = makeClient();
    await client.refresh(new AbortController().signal);

    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT)).map((row) => row.providerId)).toEqual(["anthropic"]);
    expect(client.getProviderCatalog(["provider-1"], CATALOG_ROW_LIMIT)).toHaveLength(1);
    expect(fetchCalls).toBe(1);
  });

  it("rebuilds memoized provider catalog rows after refresh", async () => {
    fs.writeFileSync(snapshotFile, modelsDevJson({ cost: { input: 1, output: 2 } }));
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const client = makeClient();

    const archived = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    const archivedAgain = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    expect(archivedAgain[0]).toBe(archived[0]);

    await client.refresh(new AbortController().signal);
    const fresh = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    expect(fresh[0]).not.toBe(archived[0]);
    expect(fresh[0]?.metadata.cost.input).toBe(3);
  });

  it("archives a good fetch and serves the archive only when a later fetch fails", async () => {
    mockFetch(() => new Response(ANTHROPIC_JSON, { status: 200 }));
    const onlineClient = makeClient();
    await onlineClient.refresh(new AbortController().signal);
    expect(fs.existsSync(snapshotFile)).toBe(true);

    mockFetch(() => new Response("unavailable", { status: 503 }));
    const offlineClient = makeClient();
    const offline = (offlineClient.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0];
    expect(offline?.metadata.cost.input).toBe(3);
    expect(offline?.metadata.pricing.status === "available"
      && offline.metadata.pricing.provenance.source === "models.dev"
      && offline.metadata.pricing.provenance.catalog).toBe("last-known-good");

    // The archived document is memoized for the client lifetime: no refetch.
    const callsAfterFallback = fetchCalls;
    const again = (offlineClient.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0];
    expect(again?.metadata.cost.input).toBe(3);
    expect(fetchCalls).toBe(callsAfterFallback);
  });

  it("preserves archive bytes when refresh documents fail admission", async () => {
    fs.writeFileSync(snapshotFile, ANTHROPIC_JSON);
    const failures = [
      "",
      "{not json",
      modelsDevJson({ cost: { input: 9, output: 9 } }),
      JSON.stringify({ anthropic: { name: "Anthropic", models: {} } }),
      JSON.stringify({ anthropic: { name: "Anthropic", models: "invalid" } }),
      JSON.stringify({ models: {}, providers: modelsDevDocument() }),
      JSON.stringify({ models: "invalid", providers: modelsDevDocument() }),
      JSON.stringify({ models: { "openai/example": { id: "openai/other" } }, providers: modelsDevDocument() }),
      JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }),
    ];

    for (const body of failures) {
      mockFetch(() => new Response(body, { status: 200 }));
      await makeClient().refresh(new AbortController().signal);
      expect(fs.readFileSync(snapshotFile, "utf8")).toBe(ANTHROPIC_JSON);
    }
  });

  it("admits a realistic 4.8 MiB combined document", async () => {
    const json = combinedModelsDevJson({ description: "x".repeat(Math.floor((4.8 * 1024 * 1024) / 20)) });
    mockFetch(() => new Response(json, { status: 200 }));

    const client = makeClient();
    await client.refresh(new AbortController().signal);
    expect((client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT))[0]?.metadata.provider).toBe("anthropic");
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(json);
  });

  it("ignores a corrupt archive and serves the bundled snapshot", async () => {
    fs.writeFileSync(snapshotFile, "{not json");
    mockFetch(() => new Response("unavailable", { status: 503 }));
    const rows = makeClient().getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
    expect(rows.some((row) => row.wireModelId === "claude-definitely-missing-9.9")).toBe(false);
    expect(rows.find((row) => row.wireModelId === "claude-sonnet-4-5")?.metadata.provider).toBe("anthropic");
  });

  it("reports provider-catalog provenance through malformed and oversized fallback", async () => {
    const archived = modelsDevDocument();
    archived.anthropic = { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", models: {
      archived: { id: "archived" },
    } };
    fs.writeFileSync(snapshotFile, JSON.stringify(archived));
    for (const body of ["{malformed", JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) })]) {
      mockFetch(() => new Response(body, { status: 200 }));
      const client = makeClient();
      await client.refresh(new AbortController().signal);
      const rows = client.getProviderCatalog(["anthropic"], CATALOG_ROW_LIMIT);
      expect(rows[0]).toEqual(expect.objectContaining({ wireModelId: "archived", provenance: "last-known-good" }));
    }
  });
});
