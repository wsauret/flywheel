import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelsClient, customProviderModelInfo } from "../../../../src/infra/llm/models.js";
import { admitModelsDocument } from "../../../../src/infra/llm/models-document.js";
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";
import { combinedModelsDevDocument, modelsDevDocument, type MutableModelsDevProviders } from "../../../helpers/model-catalog-fixtures.js";

const originalFetch = globalThis.fetch;
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "flywheel-model-index-")); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  installCustomProviders([]);
  rmSync(directory, { recursive: true, force: true });
});

function legacyClient(sourceDocument: MutableModelsDevProviders) {
  const snapshot = join(directory, "models.json");
  writeFileSync(snapshot, JSON.stringify(sourceDocument));
  return createModelsClient(snapshot);
}

test("relaxed collisions retain catalog order and do not replace later exact matches", async () => {
  const document = modelsDevDocument();
  document.anthropic = { name: "Anthropic", models: {
    "claude-3.5-sonnet": { id: "claude-3.5-sonnet", cost: { input: 2, output: 10 } },
    "claude-3-5-sonnet": { id: "claude-3-5-sonnet", cost: { input: 9, output: 45 } },
  } };
  const client = legacyClient(document);

  const rows = client.getProviderCatalog(["anthropic"], 10);
  expect(rows.find(({ wireModelId }) => wireModelId === "claude-3.5-sonnet")?.metadata.cost.input).toBe(2);
  expect(rows.find(({ wireModelId }) => wireModelId === "claude-3-5-sonnet")?.metadata.cost.input).toBe(9);
});

test("custom provider metadata remains owned by its current definition", () => {
  const custom = { id: "proxy", displayName: "Proxy", baseUrl: "https://example.invalid/v1", modelIds: new Set(["vendor/shared", "local-only"]), catalogId: "provider-1", contextLimit: 64_000 };
  expect(customProviderModelInfo(custom, "local-only")).toMatchObject({ provider: "proxy", contextLimit: 64_000 });
  expect(customProviderModelInfo(custom, "local-only")).toMatchObject({ cost: { input: 0, output: 0 }, toolCall: true });
  expect(customProviderModelInfo({ ...custom, contextLimit: 128_000 }, "local-only")).toMatchObject({ provider: "proxy", contextLimit: 128_000 });
});

test("document admission retains consumed metadata and discards unrelated upstream fields", () => {
  const document = modelsDevDocument();
  document.anthropic = {
    name: "Anthropic", website: "https://example.invalid", models: {
      example: {
        id: "example", description: "Unconsumed provider prose", release_date: "2026-09-01", knowledge: "2026-01-31",
        cost: { input: 2, output: 4, unrelated: "unused", context_over_200k: { input: 3, output: 6 } },
        reasoning_options: [{ type: "effort", values: ["low", "high"], label: "Unconsumed label" }],
        interleaved: { field: "reasoning_content" },
      },
    },
  };
  expect(admitModelsDocument(JSON.stringify(document)).document.anthropic).toEqual({
    name: "Anthropic", models: {
      example: {
        id: "example", release_date: "2026-09-01", knowledge: "2026-01-31",
        cost: { input: 2, output: 4, context_over_200k: { input: 3, output: 6 } },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        interleaved: { field: "reasoning_content" },
      },
    },
  });
  expect(legacyClient(document).getProviderCatalog(["anthropic"], 10)[0]?.metadata).toMatchObject({
    knowledgeCutoff: "2026-01-31",
    interleavedReasoningField: "reasoning_content",
  });
});

test("provider catalog preserves wire identity and resolves transport and canonical relationships", async () => {
  const document = modelsDevDocument();
  document.xai = {
    id: "xai",
    name: "xAI",
    npm: "@ai-sdk/xai",
    models: {
      "grok-4": { id: "grok-4", cost: { input: 2, output: 8 } },
      shared: { id: "shared", cost: { input: 1, output: 2 } },
    },
  };
  document.openrouter = {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    models: {
      "x-ai/grok-4": {
        id: "x-ai/grok-4",
        provider: { npm: "@ai-sdk/openai-compatible" },
        cost: { input: 3, output: 9 },
      },
      "unknown/shared": { id: "unknown/shared", cost: { input: 4, output: 10 } },
      "~x-ai/grok-latest": { id: "~x-ai/grok-latest", cost: { input: 5, output: 11 } },
    },
  };
  document["provider-1"] = {
    id: "provider-1",
    name: "Unrelated",
    npm: "@ai-sdk/openai-compatible",
    models: { shared: { id: "shared", cost: { input: 5, output: 12 } } },
  };
  const client = legacyClient(document);
  const rows = client.getProviderCatalog(["openrouter"], 10);
  client.getProviderCatalog(["openrouter"], 10);

  expect(rows).toEqual([
    {
      providerId: "openrouter",
      providerName: "OpenRouter",
      wireModelId: "x-ai/grok-4",
      dataUse: "standard",
      metadata: expect.objectContaining({ id: "x-ai/grok-4", provider: "openrouter" }),
      provenance: "last-known-good",
      canonical: { providerId: "xai", modelId: "grok-4" },
      transport: { npm: "@ai-sdk/openai-compatible" },
    },
    {
      providerId: "openrouter",
      providerName: "OpenRouter",
      wireModelId: "unknown/shared",
      dataUse: "standard",
      metadata: expect.objectContaining({ id: "unknown/shared", provider: "openrouter" }),
      provenance: "last-known-good",
      canonical: null,
      transport: { npm: "@openrouter/ai-sdk-provider" },
    },
    {
      providerId: "openrouter",
      providerName: "OpenRouter",
      wireModelId: "~x-ai/grok-latest",
      dataUse: "standard",
      metadata: expect.objectContaining({ id: "~x-ai/grok-latest", provider: "openrouter" }),
      provenance: "last-known-good",
      canonical: null,
      transport: { npm: "@openrouter/ai-sdk-provider" },
    },
  ]);
});

test("current combined catalogs resolve only exact model-map identities", async () => {
  const combined = combinedModelsDevDocument();
  combined.models["owner/shared"] = { id: "owner/shared", cost: { input: 1, output: 2 } };
  combined.models["owner/muse-1"] = { id: "owner/muse-1", cost: { input: 1, output: 2 } };
  combined.models["owner/snapshot-4-5-20260101"] = { id: "owner/snapshot-4-5-20260101", cost: { input: 1, output: 2 } };
  combined.models["owner/snapshot-4-5-20260201"] = { id: "owner/snapshot-4-5-20260201", cost: { input: 1, output: 2 } };
  combined.providers.routeA = {
    id: "route-a",
    name: "Route A",
    models: {
      shared: { id: "owner/shared", cost: { input: 3, output: 4 } },
      snapshot: { id: "owner/snapshot-4-5-20260101", cost: { input: 3, output: 4 } },
      contributor: { id: "owner/muse-1-contributor", cost: { input: 3, output: 4 } },
      moving: { id: "~owner/shared-latest" },
      absent: { id: "owner/absent" },
    },
  };
  combined.providers.routeB = {
    id: "route-b",
    name: "Route B",
    models: {
      shared: { id: "owner/shared", cost: { input: 5, output: 6 } },
      snapshot: { id: "owner/snapshot-4-5-20260201", cost: { input: 5, output: 6 } },
    },
  };
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify(combined)), { preconnect: originalFetch.preconnect });

  const client = createModelsClient(join(directory, "models.json"));
  await client.refresh(new AbortController().signal);
  const rows = client.getProviderCatalog(["routeA", "routeB"], 10);

  expect(rows.map(({ providerId, wireModelId, dataUse, canonical }) => ({ providerId, wireModelId, dataUse, canonical }))).toEqual([
    { providerId: "route-a", wireModelId: "owner/shared", dataUse: "standard", canonical: { providerId: "owner", modelId: "shared" } },
    { providerId: "route-a", wireModelId: "owner/snapshot-4-5-20260101", dataUse: "standard", canonical: { providerId: "owner", modelId: "snapshot-4.5" } },
    { providerId: "route-a", wireModelId: "owner/muse-1-contributor", dataUse: "contributor", canonical: { providerId: "owner", modelId: "muse-1" } },
    { providerId: "route-a", wireModelId: "~owner/shared-latest", dataUse: "standard", canonical: null },
    { providerId: "route-a", wireModelId: "owner/absent", dataUse: "standard", canonical: null },
    { providerId: "route-b", wireModelId: "owner/shared", dataUse: "standard", canonical: { providerId: "owner", modelId: "shared" } },
    { providerId: "route-b", wireModelId: "owner/snapshot-4-5-20260201", dataUse: "standard", canonical: { providerId: "owner", modelId: "snapshot-4.5" } },
  ]);
});

test("current combined catalogs treat bare provider rows as provider-owned canonical identities", async () => {
  const combined = combinedModelsDevDocument();
  combined.providers.direct = {
    id: "owner",
    name: "Direct",
    models: {
      known: { id: "known" },
      absent: { id: "absent" },
      moving: { id: "~moving" },
    },
  };
  combined.models["owner/known"] = { id: "owner/known" };
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify(combined)), { preconnect: originalFetch.preconnect });

  const client = createModelsClient(join(directory, "models.json"));
  await client.refresh(new AbortController().signal);
  const rows = client.getProviderCatalog(["direct"], 10);

  expect(rows.map(({ wireModelId, canonical }) => [wireModelId, canonical])).toEqual([
    ["known", { providerId: "owner", modelId: "known" }],
    ["absent", { providerId: "owner", modelId: "absent" }],
    ["~moving", null],
  ]);
});

test("provider relationships follow the admitted document and never alias a bare slug across namespaces", async () => {
  const document = modelsDevDocument();
  document.alpha = { id: "alpha", name: "Alpha", npm: "@alpha/sdk", models: { shared: { id: "shared" }, renamed: { id: "renamed" } } };
  document.beta = { id: "beta", name: "Beta", npm: "@beta/sdk", models: { shared: { id: "shared" } } };
  document.aggregator = {
    id: "aggregator",
    name: "Aggregator",
    npm: "@aggregator/sdk",
    models: {
      shared: { id: "shared" },
      "alpha/renamed": { id: "alpha/renamed" },
      "alpha/ReNamed": { id: "alpha/ReNamed" },
    },
  };
  const rows = legacyClient(document).getProviderCatalog(["aggregator"], 10);

  expect(rows.map((row) => [row.wireModelId, row.canonical])).toEqual([
    ["shared", { providerId: "aggregator", modelId: "shared" }],
    ["alpha/renamed", { providerId: "alpha", modelId: "renamed" }],
    ["alpha/ReNamed", { providerId: "alpha", modelId: "renamed" }],
  ]);
});

test("indexes many provider namespaces while preserving the first source-order owner", async () => {
  const document = modelsDevDocument();
  const providers = Array.from({ length: 200 }, (_, index) => {
    const id = `provider-${index}`;
    document[id] = { id, name: id, models: { shared: { id: "shared" } } };
    return id;
  });
  document.aggregator = {
    id: "aggregator",
    name: "Aggregator",
    models: Object.fromEntries(providers.map((provider) => [`${provider}/shared`, { id: `${provider}/shared` }])),
  };
  const rows = legacyClient(document).getProviderCatalog(["aggregator"], providers.length);

  expect(rows).toHaveLength(providers.length);
  expect(rows.map((row) => row.canonical?.providerId)).toEqual(providers);
});

test("provider relationships require an exact model identity inside the named namespace", async () => {
  const document = modelsDevDocument();
  document.openai = {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    models: {
      "gpt-5.3-chat-latest": { id: "gpt-5.3-chat-latest" },
      "gpt-5": { id: "gpt-5" },
      "o1-pro": { id: "o1-pro" },
      o1: { id: "o1" },
    },
  };
  document.google = {
    id: "google",
    name: "Google",
    npm: "@ai-sdk/google",
    models: {
      "gemini-2.5-flash-lite": { id: "gemini-2.5-flash-lite" },
      "gemini-2.5-flash": { id: "gemini-2.5-flash" },
    },
  };
  document.aggregator = {
    id: "aggregator",
    name: "Aggregator",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "openai/gpt-5": { id: "openai/gpt-5" },
      "openai/o1": { id: "openai/o1" },
      "google/gemini-2.5-flash": { id: "google/gemini-2.5-flash" },
    },
  };
  const rows = legacyClient(document).getProviderCatalog(["aggregator"], 10);

  expect(rows.map(({ wireModelId, canonical }) => [wireModelId, canonical])).toEqual([
    ["openai/gpt-5", { providerId: "openai", modelId: "gpt-5" }],
    ["openai/o1", { providerId: "openai", modelId: "o1" }],
    ["google/gemini-2.5-flash", { providerId: "google", modelId: "gemini-2.5-flash" }],
  ]);
});
