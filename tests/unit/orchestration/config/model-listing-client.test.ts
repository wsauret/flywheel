import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Redacted } from "effect";
import { accessProviderAccountKey, accessProviderCandidateKey, createAccessProviderSelection, type AccessProviderCandidate, type AccessProviderCatalogFetchInput, type AccessProviderCatalogFetchResult, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient, type ModelDiscoveryMode } from "../../../../src/infra/llm/model-listing.js";
import { AUTH_ALL, AUTH_DIR, AUTH_NONE } from "./_model-listing-fixtures.js";
import { testCapabilityModules, testProviderSelection } from "../../../helpers/provider-authority.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { fakeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { fakeFetch } from "../../../helpers/fake-fetch.js";
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import type { ModelsClient } from "../../../../src/infra/llm/models.js";
import { offeringTransportFamily } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const classifySlot = credentialSlotClassifier(testCapabilityModules());

async function listedFamilyModels(client: ReturnType<typeof createModelListingClient>, auth: AuthContext, family: ModelFamily, mode: ModelDiscoveryMode = "fresh"): Promise<ReadonlySet<string>> {
  const listed = await client.getModelCatalogs(auth, { mode });
  return new Set([...listed.candidates.values()].flatMap((candidate) =>
    [...(candidate.models ?? [])].flatMap(([model, offerings]) =>
      offerings.some((offering) => offering.transport !== undefined && offeringTransportFamily(offering.transport) === family) ? [model] : [])));
}

// ---------------------------------------------------------------------------
// Listing client — mocked fetch responses per provider
// ---------------------------------------------------------------------------

it("canonical candidate keys keep delimiter-containing model-listing entries distinct", () => {
  const left: AccessProviderCandidate = { kind: "subscription", providerId: "provider:a", instanceId: "account", spendMode: "included" };
  const right: AccessProviderCandidate = { kind: "subscription", providerId: "provider", instanceId: "a:account", spendMode: "included" };
  const candidates = new Map([
    [accessProviderCandidateKey(left), new Set(["model-left"])],
    [accessProviderCandidateKey(right), new Set(["model-right"])],
  ]);

  expect(candidates).toHaveLength(2);
  expect(candidates.get(accessProviderCandidateKey(left))).toEqual(new Set(["model-left"]));
  expect(candidates.get(accessProviderCandidateKey(right))).toEqual(new Set(["model-right"]));
});


type ChatGptFetcher = (instance: NonNullable<AccessProviderCatalogFetchInput["instance"]>, signal: AbortSignal) => Promise<readonly string[] | null>

/** The shipped selection with ChatGPT's listing replaced by the test's own
 *  fetcher: an array is the account's slugs, null a transport failure. */
function withChatGptFetch(fetcher: ChatGptFetcher) {
  const definitions = testProviderSelection().definitions.map((definition): AccessProviderDefinition => {
    if (definition.id !== "chatgpt" || definition.dynamicCatalog === undefined) return definition
    const fetch = async ({ credential, instance, signal }: AccessProviderCatalogFetchInput): Promise<AccessProviderCatalogFetchResult> => {
      if (instance === undefined) return { discovery: { kind: "not-attempted" }, credential }
      const models = await fetcher(instance, signal)
      return { discovery: models === null ? { kind: "failed", reason: "transport" } : { kind: "rows", rows: models.map((slug) => ({ slug })) }, credential }
    }
    return { ...definition, dynamicCatalog: { ...definition.dynamicCatalog, fetch } }
  })
  return createAccessProviderSelection(definitions)
}

function relationshipModelsClient(providerId: string, family: ModelFamily, wireModelIds: readonly string[]): ModelsClient {
  return {
    async refresh() {},
    getTokenizerIdentity() { return undefined; },
    getProviderCatalog(providerIds) {
      if (!providerIds.includes(providerId)) return [];
      return wireModelIds.map((wireModelId) => ({
        providerId,
        providerName: providerId,
        wireModelId,
        dataUse: "standard" as const,
        metadata: modelInfo(family, wireModelId, wireModelId, 1, 1, "2026-01-01"),
        provenance: "bundled" as const,
        canonical: { providerId, modelId: wireModelId },
        transport: { npm: family === "anthropic" ? "@ai-sdk/anthropic" : family === "google" ? "@ai-sdk/google" : "@ai-sdk/openai" },
      }));
    },
  };
}

describe("ModelListingClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mkdirSync(AUTH_DIR, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  interface ResponseFixtures { [url: string]: { ok: boolean; json: () => object } }
  function mockFetch(responses: ResponseFixtures) {
    globalThis.fetch = fakeFetch(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      for (const [pattern, response] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          return Response.json(response.json(), { status: response.ok ? 200 : 500 });
        }
      }
      return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
    });
  }

  describe("provider response parsing", () => {
    it("extracts Google model IDs without placing the API key in the URL", async () => {
      const requests: Array<{ url: string; key: string | null; userAgent: string | null; redirect: RequestRedirect | undefined }> = [];
      globalThis.fetch = fakeFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        requests.push({ url, key: headers.get("x-goog-api-key"), userAgent: headers.get("user-agent"), redirect: init?.redirect });
        return Response.json({
          models: [
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
            { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
          ],
        });
      });

      const client = createModelListingClient({ authDir: AUTH_DIR, classifySlot, providers: testProviderSelection(), modelsClient: fakeModelsClient });
      const models = await listedFamilyModels(client, AUTH_ALL, "google");
      const requested = requests.find(({ url }) => url === "https://generativelanguage.googleapis.com/v1beta/models");

      expect(requested?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
      expect(requested?.key).toBe("google-test-key");
      expect(requested?.userAgent).toMatch(/^flywheel\/\d+\.\d+\.\d+ \(.+ .+; .+\)$/);
      expect(requested?.redirect).toBe("error");
      expect(models?.has("gemini-2.5-pro")).toBe(true);
      expect(models?.has("gemini-2.5-flash")).toBe(true);
    });

    it("falls back to the bundled baseline when a model response is oversized", async () => {
      globalThis.fetch = Object.assign(
        async () => new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } }),
        { preconnect: originalFetch.preconnect },
      );
      const client = createModelListingClient({ authDir: AUTH_DIR, classifySlot, providers: testProviderSelection(), modelsClient: fakeModelsClient });
      expect((await listedFamilyModels(client, AUTH_ALL, "anthropic")).size).toBeGreaterThan(0);
    });
  });

  describe("in-memory behavior", () => {
    it("fetches a provider listing once and memoizes it for the client lifetime", async () => {
      const root = mkdtempSync(join(tmpdir(), "flywheel-listing-memory-"));
      const access = await new AuthProfileStore(root).create("default");
      const lineage = "ed487c86-b65f-4d5b-9b71-1680f41a5a5b";
      access.writeFile("auth.json", JSON.stringify({
        anthropic_api: { lineageId: lineage, credential: { type: "api_key", key: "anthropic-test-key" } },
      }));
      const authDir = access.authDirectory;
      access.close();
      let fetchCalls = 0;
      mockFetch({
        "api.anthropic.com/v1/models": {
          ok: true,
          json: () => { fetchCalls += 1; return { data: [{ id: "claude-opus-4-6" }] }; },
        },
      });

      try {
        const client = createModelListingClient({ authDir, classifySlot, providers: testProviderSelection(), modelsClient: fakeModelsClient });
        const auth = { ...AUTH_ALL, credentialLineages: { ...AUTH_ALL.credentialLineages, anthropic_api: lineage } };
        const first = await listedFamilyModels(client, auth, "anthropic");
        const second = await listedFamilyModels(client, auth, "anthropic", "cached-first");

        expect(first.has("claude-opus-4.6")).toBe(true);
        expect(second.has("claude-opus-4.6")).toBe(true);
        expect(fetchCalls).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });


    it("retries the fetch on the next call after a network failure", async () => {
      let healthy = false;
      let requests = 0;
      mockFetch({
        "api.anthropic.com": {
          get ok() { requests += 1; return healthy; },
          json: () => ({ data: [{ id: "claude-recovered" }] }),
        },
      });

      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: testProviderSelection(),
        modelsClient: relationshipModelsClient("anthropic", "anthropic", ["claude-recovered"]),
      });
      expect((await listedFamilyModels(client, AUTH_ALL, "anthropic")).has("claude-recovered")).toBe(true);

      healthy = true;
      const models = await listedFamilyModels(client, AUTH_ALL, "anthropic");

      expect(models!.has("claude-recovered")).toBe(true);
      expect(requests).toBe(2);
    });

    it("scopes in-memory provider caches to the current auth context", async () => {
      let account = 0;
      globalThis.fetch = fakeFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("api.anthropic.com")) {
          account += 1;
          const id = account === 1 ? "claude-account-a" : "claude-account-b";
          return Response.json({ data: [{ id }] });
        }
        return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
      });

      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: testProviderSelection(),
        modelsClient: relationshipModelsClient("anthropic", "anthropic", ["claude-account-a", "claude-account-b"]),
      });
      const accountA = await listedFamilyModels(client, {
        ...AUTH_ALL,
        providers: authProviders({ base: AUTH_ALL.providers, apiKeys: { anthropic_api: "sk-ant-account-a" } }),
        credentialLineages: { ...AUTH_ALL.credentialLineages, anthropic_api: "00000000-0000-4000-8000-00000000000a" },
      }, "anthropic");
      const accountB = await listedFamilyModels(client, {
        ...AUTH_ALL,
        providers: authProviders({ base: AUTH_ALL.providers, apiKeys: { anthropic_api: "sk-ant-account-b" } }),
        credentialLineages: { ...AUTH_ALL.credentialLineages, anthropic_api: "00000000-0000-4000-8000-00000000000b" },
      }, "anthropic");

      expect(accountA!.has("claude-account-a")).toBe(true);
      expect(accountA!.has("claude-account-b")).toBe(false);
      expect(accountB!.has("claude-account-b")).toBe(true);
      expect(accountB!.has("claude-account-a")).toBe(false);
    });

    it("does not persist a delayed singleton catalog after credential removal", async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("api.anthropic.com")) {
          started.resolve();
          await release.promise;
          return Response.json({ data: [{ id: "claude-delayed" }] });
        }
        return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
      }, { preconnect: originalFetch.preconnect });
      let liveLineages: { readonly [providerId: string]: string } = AUTH_ALL.credentialLineages;
      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: testProviderSelection(),
        captureCredentialLineages: () => liveLineages,
      });

      const listing = client.getModelCatalogs(AUTH_ALL, { mode: "fresh" });
      await started.promise;
      liveLineages = {};
      release.resolve();
      await listing;

      const cache = Bun.file(join(AUTH_DIR, "provider-model-catalogs.json"));
      if (await cache.exists()) expect(await cache.text()).not.toContain("claude-delayed");
    });

  });
  describe("structured cancellation", () => {
    it("aborts a generic provider fetch before returning", async () => {
      let fetchSettled = false;
      globalThis.fetch = Object.assign((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          fetchSettled = true;
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener("abort", () => { fetchSettled = true; reject(init.signal?.reason); }, { once: true });
      }), { preconnect: originalFetch.preconnect });
      const controller = new AbortController();
      const client = createModelListingClient({ authDir: AUTH_DIR, classifySlot, providers: testProviderSelection() });
      const listing = client.getModelCatalogs(AUTH_ALL, { signal: controller.signal, mode: "fresh" });
      controller.abort();

      await listing;
      expect(fetchSettled).toBe(true);
    });

    it("deadline aborts active work and never starts queued tasks", async () => {
      let started = 0;
      let settled = 0;
      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        settlementTimeoutMs: 5,
        maxFetchConcurrency: 1,
        providers: withChatGptFetch(async (_instance, signal) => {
          started += 1;
          return new Promise((resolve) => signal.addEventListener("abort", () => { settled += 1; resolve(null); }, { once: true }));
        }),
        captureSubscriptions: () => new Map([["chatgpt", [
          { instanceId: "one", credential: { type: "oauth", access: Redacted.make("one"), expires: Date.now() + 3_600_000 } },
          { instanceId: "two", credential: { type: "oauth", access: Redacted.make("two"), expires: Date.now() + 3_600_000 } },
        ]]]),
      });

      await client.getModelCatalogs({ ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, oauth: ["chatgpt"] }),}, { mode: "fresh" });
      expect(started).toBe(1);
      expect(settled).toBe(1);
    });
  });

  describe("chatgpt fetcher injection", () => {
    it("keeps exact ChatGPT account catalogs beside the provider union", async () => {
      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: withChatGptFetch(async (instance) => [instance.instanceId === "account-a" ? "gpt-account-a" : "gpt-account-b"]),
        modelsClient: relationshipModelsClient("openai", "openai", ["gpt-account-a", "gpt-account-b"]),
        captureSubscriptions: () => new Map([["chatgpt", [
          { instanceId: "account-a", credential: { type: "oauth", access: Redacted.make("a"), expires: Date.now() + 3_600_000 } },
          { instanceId: "account-b", credential: { type: "oauth", access: Redacted.make("b"), expires: Date.now() + 3_600_000 } },
        ]]]),
      });

      const catalogs = await client.getModelCatalogs({ ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, oauth: ["chatgpt"] }),}, { mode: "fresh" });
      const accountAModels = catalogs.candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "included" }))?.models;
      const accountBModels = catalogs.candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "chatgpt", instanceId: "account-b", spendMode: "included" }))?.models;
      if (accountAModels === null || accountAModels === undefined || accountBModels === null || accountBModels === undefined) throw new Error("Expected exact account catalogs");

      expect([...catalogs.providers.get("chatgpt")!].sort()).toEqual(["gpt-account-a", "gpt-account-b"]);
      expect([...accountAModels.keys()]).toEqual(["gpt-account-a"]);
      expect([...accountBModels.keys()]).toEqual(["gpt-account-b"]);
      // The map key is opaque; readers must get the typed candidate from the value.
      expect(catalogs.candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "included" }))?.candidate)
        .toEqual({ kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "included" });
    });

    it("invalidates an instance catalog when its captured credential changes", async () => {
      let access = "account-a";
      let calls = 0;
      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: withChatGptFetch(async (instance) => { calls += 1; return [`gpt-${Redacted.value(instance.credential.type === "oauth" ? instance.credential.access : Redacted.make("invalid"))}`]; }),
        modelsClient: relationshipModelsClient("openai", "openai", ["gpt-account-a", "gpt-account-b"]),
        captureSubscriptions: () => new Map([["chatgpt", [{ instanceId: "same-instance", credential: { type: "oauth", access: Redacted.make(access), expires: Date.now() + 3_600_000 } }]]]),
      });

      expect((await client.getModelCatalogs({ ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, oauth: ["chatgpt"] }),}, { mode: "fresh" })).providers.get("chatgpt")).toEqual(new Set(["gpt-account-a"]));
      access = "account-b";
      expect((await client.getModelCatalogs({ ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, oauth: ["chatgpt"] }),}, { mode: "fresh" })).providers.get("chatgpt")).toEqual(new Set(["gpt-account-b"]));
      expect(calls).toBe(2);
    });

    it("uses the bundled ChatGPT baseline when the injected fetcher fails", async () => {
      mockFetch({});

      const client = createModelListingClient({
        classifySlot,
        authDir: AUTH_DIR,
        providers: withChatGptFetch(async () => null),
        modelsClient: fakeModelsClient,
        captureSubscriptions: () => new Map([["chatgpt", [{ instanceId: "chatgpt", credential: { type: "oauth", access: Redacted.make("access"), expires: Date.now() + 3_600_000 } }]]]),
      });
      const map = (await client.getModelCatalogs({ ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, oauth: ["chatgpt"] }),}, { mode: "fresh" })).providers;

      expect(map.get("chatgpt")?.size).toBeGreaterThan(0);
    });
  });

  describe("getModelCatalogs", () => {
    it("omits families where listing returned null", async () => {
      mockFetch({});

      const client = createModelListingClient({ authDir: AUTH_DIR, classifySlot, providers: testProviderSelection() });
      const map = await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" });

      expect(map.candidates.size).toBe(0);
    });
  });
});
