import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Redacted } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import type { AccessProviderCatalogFetchInput, AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { normalizeCatalogRows, normalizeDecodedCatalogRows, resolveModelCatalog, type CatalogSourceRow } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { testProviderSelection } from "../../../helpers/provider-authority.js";
import { OPENCODE_GO_API_BASE } from "../../../../src/orchestration/modules/provider-opencode-go/wire.js";
import { fetchOpenAiStandardPricing, openAiPricingFromMetadata, parseOpenAiStandardPricing, refreshOpenAiStandardPricing } from "../../../../src/infra/llm/openai-pricing.js";

const originalFetch = globalThis.fetch;
const temporaryDirectory = temporaryDirectories();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type DynamicCatalog = NonNullable<AccessProviderDefinition["dynamicCatalog"]>;
type ListedCatalog = DynamicCatalog & { readonly fetch: NonNullable<DynamicCatalog["fetch"]> };

function dynamicCatalog(providerId: string): DynamicCatalog {
  const definition: AccessProviderDefinition | undefined = testProviderSelection().definitions.find((candidate) => candidate.id === providerId);
  if (definition?.dynamicCatalog === undefined) throw new Error(`Missing dynamic catalog for ${providerId}`);
  return definition.dynamicCatalog;
}

/** The dynamic catalog of a provider that has a first-party listing. */
function catalog(providerId: string): ListedCatalog {
  const contribution = dynamicCatalog(providerId);
  const { fetch } = contribution;
  if (fetch === undefined) throw new Error(`${providerId} has no first-party listing`);
  return { ...contribution, fetch };
}

const apiKey = { type: "api_key", key: Redacted.make("secret") } as const;
const chatGptCredential = {
  type: "oauth",
  access: Redacted.make("access"),
  refresh: Redacted.make("refresh"),
  expires: Date.now() + 3_600_000,
  accountId: "account-wire-id",
} as const;
const xaiCredential = {
  type: "oauth",
  access: Redacted.make("xai-access"),
  refresh: Redacted.make("xai-refresh"),
  expires: Date.now() + 3_600_000,
} as const;
const input = (): AccessProviderCatalogFetchInput => ({
  credential: apiKey,
  authDir: "/unused",
  classifySlot: credentialSlotClassifier(composeFirstPartyModules()),
  oauthPersistence: "profile",
  signal: AbortSignal.timeout(1_000),
});
const chatGptInput = (signal: AbortSignal = AbortSignal.timeout(1_000), credential = chatGptCredential): AccessProviderCatalogFetchInput => ({
  ...input(),
  credential,
  instance: { instanceId: "profile-instance", identity: "person@example.com", credential },
  authDir: "/unused",
  oauthPersistence: "profile",
  signal,
});

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => handler(String(request), init), { preconnect: originalFetch.preconnect });
}

describe("first-party provider model catalog contracts", () => {
  test("OpenAI pricing Markdown admits only one strict Standard table", async () => {
    const standardRow = "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |";
    const markdown = [
      "### Standard pricing data",
      "",
      "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      standardRow,
      "",
      "### Batch pricing data",
      "| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |",
    ].join("\n");
    expect(parseOpenAiStandardPricing(markdown).get("gpt-6-sol")).toEqual({
      input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10,
      highContext: { threshold: 272_000, input: 4, cacheRead: 0.4, cacheWrite: 5, output: 15 },
    });
    const unlistedCells = markdown.replace(standardRow, [
      standardRow,
      "| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |",
      "| gpt-5.4-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |",
      "| gpt-5.4-mini | $0.75 | $0.075 | - | $4.50 | - | - | - | - |",
    ].join("\n"));
    const parsed = parseOpenAiStandardPricing(unlistedCells);
    expect(parsed.get("gpt-5.5")).toEqual({
      input: 5, cacheRead: 0.5, output: 30,
      highContext: { threshold: 272_000, input: 10, cacheRead: 1, output: 45 },
    });
    expect(parsed.get("gpt-5.4-pro")).toEqual({ input: 30, output: 180, highContext: { threshold: 272_000, input: 60, output: 270 } });
    expect(parsed.get("gpt-5.4-mini")).toEqual({ input: 0.75, cacheRead: 0.075, output: 4.5 });
    expect(parseOpenAiStandardPricing(markdown.replace("### Standard pricing data", "### Changed"))).toEqual(new Map());
    expect(parseOpenAiStandardPricing(markdown.replace(standardRow, `${standardRow}\n${standardRow}`))).toEqual(new Map());

    installFetch(() => Promise.reject(new Error("offline")));
    expect(await fetchOpenAiStandardPricing(AbortSignal.timeout(1_000))).toEqual(new Map());
    installFetch(() => new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/markdown" } }));
    expect(await fetchOpenAiStandardPricing(AbortSignal.timeout(1_000))).toEqual(new Map());
  });

  test("OpenAI pricing metadata rejects every invalid numeric rate", () => {
    const valid = {
      standardPricing: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        highContext: { threshold: 272_000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
      },
    };
    for (const [path, value] of [
      [["input"], -1],
      [["output"], Number.NaN],
      [["cacheRead"], Number.POSITIVE_INFINITY],
      [["cacheWrite"], -1],
      [["highContext", "threshold"], 0],
      [["highContext", "input"], -1],
      [["highContext", "output"], Number.NaN],
      [["highContext", "cacheRead"], Number.POSITIVE_INFINITY],
      [["highContext", "cacheWrite"], -1],
    ] as const) {
      const candidate = structuredClone(valid);
      const target = path.length === 1 ? candidate.standardPricing : candidate.standardPricing.highContext;
      Reflect.set(target, path.at(-1)!, value);
      expect(openAiPricingFromMetadata(candidate, "gpt-test")).toBeUndefined();
    }
  });

  test("staggered OpenAI account listings share one nonblocking pricing request", async () => {
    const now = spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    let pricingRequests = 0;
    let releasePricing!: () => void;
    const pricingHeld = new Promise<void>((resolve) => {
      releasePricing = resolve;
    });
    installFetch(async (url) => {
      if (url.includes("developers.openai.com")) {
        pricingRequests += 1;
        await pricingHeld;
        return new Response("", { status: 503 });
      }
      return Response.json({ data: [{ id: "gpt-account-model" }] });
    });
    const contribution = catalog("openai_api");

    try {
      const first = await contribution.fetch(input());
      expect(first.discovery.kind).toBe("rows");
      expect(pricingRequests).toBe(1);
      releasePricing();
      await refreshOpenAiStandardPricing();
      const second = await contribution.fetch(input());

      expect(second.discovery.kind).toBe("rows");
      expect(pricingRequests).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  test("Anthropic extracts data ids and follows has_more with after_id", async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      return Response.json(url.includes("after_id=cursor")
        ? { data: [{ id: "claude-second", display_name: "Second" }], has_more: false }
        : { data: [{ id: "claude-first", display_name: "First" }], has_more: true, last_id: "cursor" });
    });

    const contribution = catalog("anthropic_api");
    const result = await contribution.fetch(input());
    expect(result.discovery).toEqual({ kind: "rows", rows: [
      { id: "claude-first", display_name: "First" },
      { id: "claude-second", display_name: "Second" },
    ] });
    expect(urls[1]).toContain("after_id=cursor");
  });

  test("Gemini extracts models.name, follows pageToken, and keeps the source name", async () => {
    installFetch((url) => Response.json(url.includes("pageToken=next")
      ? { models: [{ name: "models/gemini-second", displayName: "Second" }] }
      : { models: [{ name: "models/gemini-first", displayName: "First" }], nextPageToken: "next" }));

    const contribution = catalog("google_api");
    const result = await contribution.fetch(input());
    expect(result.discovery.kind).toBe("rows");
    if (result.discovery.kind !== "rows") throw new Error("Expected rows");
    const normalized = normalizeCatalogRows(result.discovery.rows, contribution);
    expect(normalized).toMatchObject({ kind: "valid", rows: [
      { modelId: "gemini-first", offerings: [{ wireModelId: "gemini-first", metadata: { sourceWireModelId: "models/gemini-first", displayName: "First" }, dataUse: "standard", resolvedMetadata: { provider: "google", name: "First" } }] },
      { modelId: "gemini-second", offerings: [{ wireModelId: "gemini-second", metadata: { sourceWireModelId: "models/gemini-second", displayName: "Second" }, dataUse: "standard", resolvedMetadata: { provider: "google", name: "Second" } }] },
    ] });
  });

  test("OpenAI-style contracts retain useful source metadata", async () => {
    for (const [providerId, endpoint] of [["openai_api", "api.openai.com"], ["opencode_go", `${OPENCODE_GO_API_BASE}/v1/models`]] as const) {
      let requested = "";
      installFetch((url) => {
        if (url.includes("developers.openai.com")) return new Response(null, { status: 404 });
        requested = url;
        return Response.json({ data: [{ id: "wire-model", object: "model", owned_by: "account" }] });
      });
      const contribution = catalog(providerId);
      const result = await contribution.fetch(input());
      expect(requested).toContain(endpoint);
      expect(result.discovery.kind).toBe("rows");
      if (result.discovery.kind !== "rows") throw new Error("Expected rows");
      expect(contribution.canonicalize(result.discovery.rows[0])).toMatchObject({
        modelId: "wire-model",
        wireModelId: "wire-model",
        metadata: { object: "model", owned_by: "account" },
        resolvedMetadata: { id: "wire-model" },
      });
    }
  });

  test("SuperGrok extracts exact xAI wire ids and useful source metadata", async () => {
    installFetch(() => Response.json({ data: [{
      id: "Grok-Exact.Wire",
      object: "model",
      owned_by: "xai",
      name: "Grok Exact",
      context_window: 500_000,
      supports_reasoning_effort: true,
      reasoning_efforts: [{ value: "high" }, { value: "unknown" }, null],
    }] }));
    const contribution = catalog("supergrok");
    const result = await contribution.fetch({
      ...input(),
      credential: xaiCredential,
      instance: { instanceId: "xai-account", identity: "person", credential: xaiCredential },
    });
    expect(result.discovery.kind).toBe("rows");
    if (result.discovery.kind !== "rows") throw new Error("Expected rows");
    expect(contribution.canonicalize(result.discovery.rows[0])).toMatchObject({
      modelId: "Grok-Exact.Wire",
      wireModelId: "Grok-Exact.Wire",
      metadata: {
        object: "model",
        owned_by: "xai",
        context_window: 500_000,
      },
      resolvedMetadata: {
        family: "openai",
        id: "Grok-Exact.Wire",
        name: "Grok Exact",
        contextLimit: 500_000,
        reasoning: true,
        reasoningEfforts: ["high"],
        pricing: { status: "unavailable", reason: "missing-rate-card" },
      },
    });
  });

  test("Copilot and OpenRouter retain exact wire ids and provider-owned routing metadata", async () => {
    const responses = {
      github_copilot: {
        data: [{
          id: "GPT-Exact.Wire",
          object: "model",
          supported_endpoints: ["/responses", "/embeddings"],
          capabilities: { supports: { streaming: true }, limits: { max_context_window_tokens: 128_000 } },
          billing: { multiplier: 0.5 },
        }],
      },
      openrouter: {
        data: [{
          id: "vendor/Exact.Wire",
          pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000005", input_cache_write: "0.0000007" },
          top_provider: { max_completion_tokens: 32_768 },
          supported_parameters: ["tools"],
        }],
      },
    } as const;

    for (const providerId of ["github_copilot", "openrouter"] as const) {
      installFetch(() => Response.json(responses[providerId]));
      const contribution = catalog(providerId);
      const credential = providerId === "github_copilot" ? chatGptCredential : apiKey;
      const result = await contribution.fetch({ ...input(), credential, instance: providerId === "github_copilot" ? { instanceId: "copilot", identity: "person", credential } : undefined });
      expect(["rows", "decoded-rows"]).toContain(result.discovery.kind);
      if (result.discovery.kind !== "rows" && result.discovery.kind !== "decoded-rows") throw new Error("Expected rows");
      const catalogRows = result.discovery.kind === "decoded-rows"
        ? normalizeDecodedCatalogRows(result.discovery.rows, contribution.limits)
        : normalizeCatalogRows(result.discovery.rows, contribution);
      if (catalogRows.kind !== "valid") throw new Error("Expected valid rows");
      expect(catalogRows.rows[0]?.offerings[0]?.wireModelId).toBe(responses[providerId].data[0].id);
      expect(catalogRows.rows[0]?.offerings[0]?.metadata).toEqual(providerId === "github_copilot"
        ? {
            object: "model",
            supportedEndpoints: ["/responses"],
            capabilities: { supports: { streaming: true }, limits: { max_context_window_tokens: 128_000 } },
            billing: { multiplier: 0.5 },
          }
        : {
            pricing: { prompt: 0.000001, completion: 0.000002, input_cache_read: 0.0000005, input_cache_write: 0.0000007 },
            top_provider: { max_completion_tokens: 32_768 },
          });
    }
  });

  test("OpenRouter keeps independently valid evidence and does not invent invalid values", () => {
    const contribution = catalog("openrouter");
    expect(contribution.canonicalize({
      id: "vendor/pricing-only",
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "invalid" },
      top_provider: { max_completion_tokens: 1.5 },
      supported_parameters: ["tools"],
    })).toMatchObject({
      metadata: { pricing: { prompt: 0.000001, completion: 0.000002 } },
      resolvedMetadata: { cost: { input: 1, output: 2 }, pricing: { status: "available" }, outputLimit: 4_096 },
    });
    expect(contribution.canonicalize({
      id: "vendor/cap-only",
      pricing: { prompt: "invalid", completion: "0.000002" },
      top_provider: { max_completion_tokens: 16_384 },
    })).toMatchObject({
      metadata: { top_provider: { max_completion_tokens: 16_384 } },
      resolvedMetadata: { outputLimit: 16_384, pricing: { status: "unavailable" } },
    });
  });

  test("provider decoders preserve explicit false and leave absent capabilities for fallback", () => {
    const usableOpenRouter = { pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] };
    const cases = [
      ["anthropic_api", { id: "a" }, { id: "a", capabilities: { thinking: false, image_input: false, pdf_input: false } }],
      ["google_api", { name: "models/g" }, { name: "models/g", thinking: false }],
      ["github_copilot", { id: "c", supported_endpoints: ["/responses"] }, { id: "c", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning: false, vision: false } } }],
      ["openrouter", { id: "vendor/o", ...usableOpenRouter }, { id: "vendor/o", ...usableOpenRouter, reasoning: { supported_efforts: [] }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } }],
    ] as const;
    for (const [providerId, absent, explicit] of cases) {
      const contribution = catalog(providerId);
      const absentFields = contribution.canonicalize(absent)?.resolvedMetadata?.providerFields ?? [];
      const explicitFields = contribution.canonicalize(explicit)?.resolvedMetadata?.providerFields ?? [];
      expect(absentFields).not.toContain("reasoning");
      expect(absentFields).not.toContain("modalities");
      expect(explicitFields).toContain("reasoning");
      if (providerId !== "google_api") expect(explicitFields).toContain("modalities");
    }
  });

  test("Anthropic thinking alone leaves attachment and modalities open to models.dev fallback", () => {
    const decoded = catalog("anthropic_api").canonicalize({ id: "claude-test", capabilities: { thinking: true } });
    expect(decoded?.resolvedMetadata?.providerFields).toContain("reasoning");
    expect(decoded?.resolvedMetadata?.providerFields).not.toContain("attachment");
    expect(decoded?.resolvedMetadata?.providerFields).not.toContain("modalities");
  });

  test("ChatGPT lists exact slugs with bounded modalities for the exact account", async () => {
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;
    installFetch((url, init) => {
      if (url.includes("developers.openai.com")) return new Response(null, { status: 404 });
      requestedUrl = url;
      requestedHeaders = new Headers(init?.headers);
      return Response.json({
        models: [
          {
            slug: "GPT-Exact-Wire-ID",
            display_name: "GPT Exact",
            context_window: 272_000,
            max_context_window: 872_000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
            tool_mode: "code_mode_only",
          },
          { slug: "gpt-without-modalities" },
        ],
      });
    });

    const contribution = catalog("chatgpt");
    const result = await contribution.fetch(chatGptInput());
    expect(requestedUrl).toEndWith("/models?client_version=1.0.0");
    expect(requestedHeaders?.get("ChatGPT-Account-Id")).toBe("account-wire-id");
    expect(requestedHeaders?.get("authorization")).toBe("Bearer access");
    expect(result.discovery).toEqual({ kind: "rows", rows: [
      {
        slug: "GPT-Exact-Wire-ID",
        display_name: "GPT Exact",
        context_window: 272_000,
        max_context_window: 872_000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
        tool_mode: "code_mode_only",
      },
      { slug: "gpt-without-modalities" },
    ] });
    expect(contribution.canonicalize(result.discovery.kind === "rows" ? result.discovery.rows[0] : undefined)).toMatchObject({
      modelId: "GPT-Exact-Wire-ID",
      wireModelId: "GPT-Exact-Wire-ID",
      metadata: {
        display_name: "GPT Exact",
        context_window: 272_000,
        max_context_window: 872_000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: ["low", "ultra"],
        tool_mode: "code_mode_only",
      },
      resolvedMetadata: {
        provider: "openai",
        family: "openai",
        id: "GPT-Exact-Wire-ID",
        name: "GPT Exact",
        openWeights: false,
        reasoning: true,
        reasoningEfforts: ["low", "ultra"],
        toolCall: true,
        attachment: true,
        temperature: true,
        contextLimit: 872_000,
        outputLimit: 4_096,
        cost: { input: 0, output: 0 },
        pricing: { status: "unavailable", reason: "missing-rate-card" },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    });
    expect(contribution.canonicalize(result.discovery.kind === "rows" ? result.discovery.rows[1] : undefined)?.resolvedMetadata?.providerFields).not.toContain("modalities");
    expect(contribution.canonicalize(result.discovery.kind === "rows" ? result.discovery.rows[1] : undefined)?.resolvedMetadata?.providerFields).not.toContain("reasoning");
  });

  test("ChatGPT preserves listing failure classifications", async () => {
    for (const status of [401, 403]) {
      installFetch(() => new Response(null, { status }));
      expect((await catalog("chatgpt").fetch(chatGptInput())).discovery).toEqual({ kind: "auth-invalid", status });
    }
    installFetch(() => new Response("{", { status: 200 }));
    expect((await catalog("chatgpt").fetch(chatGptInput())).discovery).toEqual({ kind: "failed", reason: "malformed" });
    installFetch(() => Response.json({ models: [] }));
    expect((await catalog("chatgpt").fetch(chatGptInput())).discovery).toEqual({ kind: "rows", rows: [] });
    installFetch(() => new Response(null, { status: 503 }));
    expect((await catalog("chatgpt").fetch(chatGptInput())).discovery).toEqual({ kind: "failed", reason: "http", status: 503 });
    installFetch(() => Promise.reject(new Error("offline")));
    expect((await catalog("chatgpt").fetch(chatGptInput())).discovery).toEqual({ kind: "failed", reason: "transport" });
  });

  test("ChatGPT classifies rejected token refresh as authentication invalid", async () => {
    installFetch(() => new Response(null, { status: 401 }));
    const expired = { ...chatGptCredential, expires: 0 };

    expect((await catalog("chatgpt").fetch(chatGptInput(undefined, expired))).discovery).toEqual({ kind: "auth-invalid" });
  });

  test("expired access-only OAuth catalogs reject without refresh or store I/O", async () => {
    let requests = 0;
    installFetch(() => {
      requests += 1;
      return new Response(null, { status: 500 });
    });
    for (const [providerId, credential] of [
      ["chatgpt", { ...chatGptCredential, expires: 0 }],
      ["github_copilot", { ...chatGptCredential, expires: 0 }],
      ["supergrok", { ...xaiCredential, expires: 0 }],
    ] as const) {
      const result = await catalog(providerId).fetch({
        ...input(),
        credential,
        oauthPersistence: "access-only",
        instance: { instanceId: `${providerId}-account`, identity: "person", credential },
      });
      expect(result.discovery).toEqual({ kind: "auth-invalid" });
    }
    expect(requests).toBe(0);
  });

  test("Copilot transient and malformed refresh failures remain discovery failures", async () => {
    const expired = { ...chatGptCredential, expires: 0 };
    for (const [response, expected] of [
      [new Response(null, { status: 429 }), { kind: "failed", reason: "transport" }],
      [new Response(null, { status: 503 }), { kind: "failed", reason: "transport" }],
      [Response.json({ token: 4, expires_at: "bad" }), { kind: "failed", reason: "transport" }],
      [new Response(null, { status: 401 }), { kind: "auth-invalid" }],
    ] as const) {
      installFetch(() => response);
      const result = await catalog("github_copilot").fetch({
        ...input(),
        credential: expired,
        instance: { instanceId: "copilot-account", identity: "person", credential: expired },
      });
      expect(result.discovery).toEqual(expected);
    }
  });

  test("Copilot refresh preserves a metered key and both subscription lineages", async () => {
    const authDir = join(temporaryDirectory("catalog-rotation-"), "profile");
    mkdirSync(authDir);
    const lineageId = "00000000-0000-4000-8000-000000000010";
    const otherLineageId = "00000000-0000-4000-8000-000000000011";
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      openai_api: { type: "api_key", key: "metered-key", lineageId },
      github_copilot: [
        { id: "selected", identity: "selected", lineageId, credential: { type: "oauth", access: "old", refresh: "github-token", expires: 1 } },
        { id: "other", identity: "other", lineageId: otherLineageId, credential: { type: "oauth", access: "other", refresh: "other-github", expires: 1 } },
      ],
    }));
    installFetch((url) => url.includes("copilot_internal")
      ? Response.json({ token: "new-copilot", expires_at: Math.floor(Date.now() / 1000) + 3600 })
      : Response.json({ data: [{ id: "gpt-model", supported_endpoints: ["/responses"] }] }));
    const credential = { type: "oauth" as const, access: Redacted.make("old"), refresh: Redacted.make("github-token"), expires: 1 };
    const result = await catalog("github_copilot").fetch({
      ...input(), authDir, credential, instance: { instanceId: "selected", identity: "selected", lineageId, credential },
    });
    expect(result.discovery.kind).toBe("rows");
    const persisted = await Bun.file(join(authDir, "auth.json")).json();
    expect(persisted.openai_api).toEqual({ type: "api_key", key: "metered-key", lineageId });
    expect(persisted.github_copilot.map((entry: { id: string; lineageId: string; credential: { access: string } }) =>
      [entry.id, entry.lineageId, entry.credential.access])).toEqual([
      ["other", otherLineageId, "other"], ["selected", lineageId, "new-copilot"],
    ]);
  });

  test("SuperGrok invalid grant is auth-invalid while transient and malformed refreshes are discovery failures", async () => {
    for (const [index, [response, expected]] of ([
      [Response.json({ error: "invalid_grant" }, { status: 400 }), { kind: "auth-invalid" }],
      [new Response(null, { status: 429 }), { kind: "failed", reason: "transport" }],
      [new Response(null, { status: 503 }), { kind: "failed", reason: "transport" }],
      [Response.json({ access_token: 4 }), { kind: "failed", reason: "transport" }],
    ] as const).entries()) {
      const credential = { ...xaiCredential, refresh: Redacted.make(`xai-refresh-${index}`), expires: 0 };
      installFetch(() => response);
      const result = await catalog("supergrok").fetch({
        ...input(),
        credential,
        instance: { instanceId: "supergrok-account", identity: "person", credential },
      });
      expect(result.discovery).toEqual(expected);
    }
  });

  test("ChatGPT listing cancellation reaches fetch and settles", async () => {
    const controller = new AbortController();
    let listingSignal: AbortSignal | undefined;
    installFetch((_url, init) => {
      listingSignal = init?.signal ?? undefined;
      controller.abort(new Error("cancelled"));
      return Promise.reject(controller.signal.reason);
    });
    await expect(catalog("chatgpt").fetch(chatGptInput(controller.signal))).rejects.toThrow("cancelled");
    expect(listingSignal?.aborted).toBe(true);
  });

  test("ChatGPT refresh cancellation reaches refresh and settles", async () => {
    const controller = new AbortController();
    let refreshUrl = "";
    installFetch((url) => {
      refreshUrl = url;
      controller.abort(new Error("refresh cancelled"));
      return Promise.reject(controller.signal.reason);
    });
    const expired = { ...chatGptCredential, expires: 0 };
    await expect(catalog("chatgpt").fetch(chatGptInput(controller.signal, expired))).rejects.toThrow("refresh cancelled");
    expect(refreshUrl).toContain("auth.openai.com/oauth/token");
  });

  test("malformed collections and identifiers are unusable", async () => {
    for (const providerId of ["anthropic_api", "openai_api", "opencode_go"] as const) {
      installFetch(() => Response.json({ data: "not-an-array" }));
      expect((await catalog(providerId).fetch(input())).discovery).toEqual({ kind: "failed", reason: "malformed" });
    }
    installFetch(() => Response.json({ models: [{ name: "" }] }));
    expect((await catalog("google_api").fetch(input())).discovery).toEqual({ kind: "failed", reason: "malformed" });
  });

  test("OpenCode Go falls back after a 503 and Vertex performs no first-party fetch", async () => {
    let fetches = 0;
    installFetch(() => {
      fetches += 1;
      return new Response("unavailable", { status: 503 });
    });
    const goCatalog = await catalog("opencode_go").fetch(input());
    expect(goCatalog.discovery).toEqual({ kind: "failed", reason: "http", status: 503 });
    expect(fetches).toBe(1);

    expect(dynamicCatalog("google_vertex").fetch).toBeUndefined();
    expect(fetches).toBe(1);
  });

  test("all API-backed providers resolve a 503 directly through the shared fallback", async () => {
    installFetch(() => new Response("unavailable", { status: 503 }));
    const fallback = [{
      modelId: "fallback-model",
      wireModelId: "fallback-model",
      metadata: { transport: { npm: "@ai-sdk/openai" } },
    }] satisfies readonly CatalogSourceRow[];
    for (const providerId of ["anthropic_api", "chatgpt", "github_copilot", "google_api", "openai_api", "opencode_go", "openrouter", "supergrok"] as const) {
      const contribution = catalog(providerId);
      const credential = providerId === "chatgpt" || providerId === "github_copilot"
        ? chatGptCredential
        : providerId === "supergrok"
          ? xaiCredential
          : apiKey;
      const result = await contribution.fetch({
        ...input(),
        credential,
        ...((providerId === "chatgpt" || providerId === "github_copilot" || providerId === "supergrok")
          ? { instance: { instanceId: `${providerId}-account`, identity: "person", credential } }
          : {}),
      });
      expect(result.discovery).toEqual({ kind: "failed", reason: "http", status: 503 });
      const canonicalFallback = normalizeCatalogRows(fallback, {
        ...contribution,
        canonicalize: (row) => typeof row === "object" && row !== null && "wireModelId" in row && typeof row.wireModelId === "string"
          ? { modelId: row.wireModelId, wireModelId: row.wireModelId, metadata: null }
          : undefined,
      });
      const resolved = resolveModelCatalog({
        authenticated: true,
        live: result.discovery,
        canonicalFallback: canonicalFallback.kind === "valid" ? canonicalFallback.rows : undefined,
        fallbackProvenance: "live",
        contribution,
      });
      if (resolved.kind !== "catalog") throw new Error(`${providerId} did not resolve shared fallback: ${JSON.stringify(resolved)}`);
      expect(resolved).toMatchObject({
        kind: "catalog",
        provenance: "models-dev-live",
        liveOutcome: "discovery-failed",
        rows: [{ modelId: "fallback-model" }],
      });
    }
  });
});
