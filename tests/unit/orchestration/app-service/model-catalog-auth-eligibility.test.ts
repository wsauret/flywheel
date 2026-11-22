import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Redacted } from "effect";
import { join } from "node:path";
import { apiKey, captureSubscriptionCredentials, resolveAuthContext } from "../../../../src/infra/auth/auth-context.js";
import { normalizeAuthProfile } from "../../../../src/infra/auth/auth-profile-normalization.js";
import { createKeyResolver } from "../../../../src/infra/auth/resolve-key.js";
import { Log } from "../../../../src/infra/log.js";
import { authDir as profileAuthDirectory } from "../../../../src/infra/paths.js";
import { createAuthConditionOwner } from "../../../../src/orchestration/auth/auth-condition-owner.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { appendCredentialInstanceWithReceipt, replaceCredentialInstance, replaceCredentialInstanceWithReceipt } from "../../../../src/infra/auth/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import { isCredentialCollection } from "../../../../src/infra/auth/auth-store-types.js";
import { accessProviderAccountKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { canonicalCatalogModelId } from "../../../../src/infra/llm/model-id.js";
import type { ModelsClient } from "../../../../src/infra/llm/models.js";
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { captureAccountConnection } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js";
import { providerModelEligibilityDecision } from "../../../../src/orchestration/config/provider-model-eligibility.js";
import { authProfileEligibilityInputRevision, createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { installedAccessProviderDefinitions, installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js";

import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { unusedProviderModelWrites } from "../../../helpers/provider-model-writes.js";
import { diskAuthObservation } from "../../../helpers/profile-auth-observation.js";
const temporaryDirectory = temporaryDirectories();

type CatalogResult = "failed" | "auth-invalid" | readonly string[];

function chatgptCatalogSelection(definitions: readonly AccessProviderDefinition[], result: (access: string) => Promise<CatalogResult>) {
  return createAccessProviderSelection(definitions.map((definition) => definition.id === "chatgpt" && definition.dynamicCatalog !== undefined
    ? {
        ...definition,
        dynamicCatalog: {
          ...definition.dynamicCatalog,
          fetch: async ({ credential }) => {
            const access = credential.type === "oauth" ? Redacted.value(credential.access) : "";
            const listed = await result(access);
            return {
              discovery: listed === "failed"
                ? { kind: "failed" as const, reason: "transport" as const }
                : listed === "auth-invalid"
                  ? { kind: "auth-invalid" as const }
                  : { kind: "rows" as const, rows: listed.map((slug) => ({ slug })) },
              credential,
            };
          },
        },
      }
    : definition));
}

async function cachedCatalogFixture(label: string) {
  const userDataRoot = temporaryDirectory(`flywheel-cached-catalog-${label}-`);
  const profileId = "work";
  const directory = join(userDataRoot, "auth", "profiles", profileId);
  const access = await new AuthProfileStore(userDataRoot).create(profileId);
  access.close();
  const credential = { type: "oauth" as const, access: "access-v1", refresh: "refresh-v1", expires: Date.now() + 60_000, accountId: "account" };
  const modules = composeFirstPartyModules();
  const slots = credentialSlotClassifier(modules);
  await appendCredentialInstanceWithReceipt("chatgpt", { id: "account", identity: "person", credential }, directory, slots);
  const resolve = () => resolveAuthContext({ authDir: directory, resolveKey: async () => undefined, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: slots });
  return { userDataRoot, profileId, directory, credential, modules, slots, resolve };
}

function captureFixtureSubscriptions(
  fixture: Awaited<ReturnType<typeof cachedCatalogFixture>>,
  definitions: readonly AccessProviderDefinition[],
) {
  return () => captureSubscriptionCredentials(definitions, {
    kind: "persisted",
    authDir: fixture.directory,
    classifySlot: fixture.slots,
  });
}

const eligibilityModelsClient: ModelsClient = {
  refresh: async () => {},
  getTokenizerIdentity: () => undefined,
  getProviderCatalog: () => [
    "gpt-6.1-sol",
    "gpt-5.5-pro",
    "gpt-cached-contributor",
    "gpt-old-account",
    "gpt-old",
    "gpt-new",
    "gpt-generation-one",
    "gpt-generation-two",
    "gpt-stale",
  ].map((wireModelId) => {
    const { modelId, dataUse } = canonicalCatalogModelId(wireModelId);
    return {
    providerId: "openai",
    providerName: "OpenAI",
    wireModelId,
    dataUse,
    metadata: {
      provider: "openai",
      family: "openai",
      id: modelId,
      name: modelId,
      releaseDate: modelId === "gpt-6.1-sol" ? "2026-03-01" : "2026-02-01",
      openWeights: false,
      reasoning: true,
      toolCall: true,
      attachment: true,
      temperature: true,
      contextLimit: 128_000,
      outputLimit: 16_384,
      cost: { input: 5, output: 10 },
      pricing: { status: "available" as const, rateCard: { input: 5, output: 10 }, provenance: { source: "models.dev" as const, catalog: "bundled" as const, provider: "openai", model: modelId } },
      modalities: { input: ["text"], output: ["text"] },
    },
    provenance: "bundled" as const,
    canonical: { providerId: "openai", modelId },
    transport: { npm: "@ai-sdk/openai" },
  };
  }),
};

describe("catalog auth eligibility", () => {
  test.each([
    { name: "unknown valid", sibling: { future_provider: { type: "api_key", key: "future" } } },
    { name: "unknown malformed", sibling: { future_provider: 42 } },
    { name: "excess fields", sibling: { openai_api: { type: "api_key", key: "other", extra: true } } },
    { name: "malformed provider", sibling: { openai_api: 42 } },
  ])("captures healthy credentials without rewriting $name bytes or rediscovering on rotation", async ({ name, sibling }) => {
    const userDataRoot = temporaryDirectory("auth-read-only-")
    const profile = { id: "work", directory: profileAuthDirectory(userDataRoot, "work") }
    const access = await new AuthProfileStore(userDataRoot).create(profile.id)
    access.close()
    const file = join(profile.directory, "auth.json")
    const bytes = JSON.stringify({ anthropic_api: { type: "api_key", key: "!helper", lineageId: "11111111-1111-4111-8111-111111111111" }, ...sibling })
    writeFileSync(file, bytes)
    const modules = composeFirstPartyModules()
    const classifier = credentialSlotClassifier(modules)
    const conditions = createAuthConditionOwner()
    let helpers = 0
    const resolveKey = createKeyResolver(async () => { helpers++; return { tag: "captured", value: Redacted.make("healthy") } })
    const warnings = spyOn(Log.create({ service: "auth-store" }), "warn").mockImplementation(() => {})
    const refusals = spyOn(Log.create({ service: "auth-conditions" }), "warn").mockImplementation(() => {})
    const service = createProviderModelPreferenceService({ ...unusedProviderModelWrites(), displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const modes: string[] = []
    const capturedKeys: string[] = []
    let metadataRefreshes = 0
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot, resolveKey, moduleSelection: () => modules,
      prepare: service.prepare, publish: service.publish, current: service.state,
      inputRevision: authProfileEligibilityInputRevision,
      observeAuth: () => {
        const load = loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), classifier, false)
        conditions.observeLoad(profile.directory, load)
        return load
      },
      normalizeProfile: async () => {
        if (await normalizeAuthProfile(profile.directory, classifier, installedCredentialProviderIds(), installedAccessProviderDefinitions()) === "read-only") conditions.observeNormalizationRefusal(profile.directory)
      },
      resolveCatalog: async ({ auth, discoveryMode }) => {
        capturedKeys.push(Redacted.value(apiKey(auth, "anthropic_api")!))
        modes.push(discoveryMode ?? "missing")
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
      refreshMetadata: async () => { metadataRefreshes++ },
    })
    try {
      const first = await prepare.capture(profile, (_state, auth) => auth)
      const warningCount = warnings.mock.calls.length
      const refusalCount = refusals.mock.calls.length
      if (name.startsWith("unknown")) expect(warningCount).toBe(1)
      if (name !== "malformed provider") expect(refusalCount).toBe(1)
      for (let i = 0; i < 3; i++) await prepare.capture(profile, (_state, auth) => auth)
      expect(warnings).toHaveBeenCalledTimes(warningCount)
      expect(refusals).toHaveBeenCalledTimes(refusalCount)
      expect(readFileSync(file, "utf8")).toBe(bytes)
      expect(helpers).toBe(1)
      expect(modes).toEqual(["cached-first", "refresh"])
      expect(metadataRefreshes).toBe(1)
      writeFileSync(file, JSON.stringify({ anthropic_api: { type: "api_key", key: "rotated", lineageId: "11111111-1111-4111-8111-111111111111" } }))
      const repaired = await prepare.capture(profile, (_state, auth) => auth)
      expect(Redacted.value(apiKey(first, "anthropic_api")!)).toBe("healthy")
      expect(Redacted.value(apiKey(repaired, "anthropic_api")!)).toBe("rotated")
      expect(repaired.conditions).toBeUndefined()
      expect(modes).toEqual(["cached-first", "refresh", "cached-first"])
      expect(metadataRefreshes).toBe(1)
      expect(capturedKeys).toEqual(["healthy", "healthy", "rotated"])
    } finally {
      await prepare.dispose()
      await service.dispose()
      warnings.mockRestore()
      refusals.mockRestore()
    }
  })

  test("a real fresh listing primes a cross-run cached-first catalog and stable token rotation reuses it", async () => {
    const fixture = await cachedCatalogFixture("prime");
    const definitions = accessProviderRegistry(fixture.modules).selection.definitions;
    const fresh = createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => ["gpt-cached-contributor"]),
      modelsClient: eligibilityModelsClient,
    });
    await fresh.getModelCatalogs(await fixture.resolve(), { mode: "fresh" });

    let fetchCalls = 0;
    const cached = createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => { fetchCalls += 1; return "failed"; }),
      modelsClient: eligibilityModelsClient,
    });
    const first = await cached.getModelCatalogs(await fixture.resolve(), { mode: "cached-first" });
    expect(first.providers.get("chatgpt")).toEqual(new Set(["gpt-cached"]));
    expect(fetchCalls).toBe(0);
    const cachedCandidate = [...first.candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt");
    expect(cachedCandidate?.models?.get("gpt-cached")).toEqual([expect.objectContaining({
      wireModelId: "gpt-cached-contributor",
      dataUse: "contributor",
    })]);

    const rotated = { ...fixture.credential, access: "access-v2", refresh: "refresh-v2" };
    expect(await replaceCredentialInstance("chatgpt", "account", fixture.credential, rotated, fixture.directory, fixture.slots)).toBe(true);
    const afterRotation = await createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => { fetchCalls += 1; return "failed"; }),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await fixture.resolve(), { mode: "cached-first" });
    expect(afterRotation.providers.get("chatgpt")).toEqual(new Set(["gpt-cached"]));
    expect(fetchCalls).toBe(0);
  });

  test("cached catalogs are fenced by explicit reconnect and by profile", async () => {
    const fixture = await cachedCatalogFixture("fences");
    const definitions = accessProviderRegistry(fixture.modules).selection.definitions;
    await createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => ["gpt-old-account"]),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await fixture.resolve(), { mode: "fresh" });

    const reconnect = { ...fixture.credential, access: "access-reconnected" };
    expect(await replaceCredentialInstanceWithReceipt("chatgpt", "account", fixture.credential, reconnect, fixture.directory, fixture.slots)).toBeDefined();
    const reconnected = await createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => "failed"),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await fixture.resolve(), { mode: "cached-first" });
    expect([...reconnected.candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt")?.outcome)
      .toEqual({ kind: "unavailable", reason: "discovery-pending" });

    const other = await cachedCatalogFixture("other-profile");
    const otherResult = await createModelListingClient({
      authDir: other.directory,
      classifySlot: other.slots,
      captureSubscriptions: captureFixtureSubscriptions(other, definitions),
      providers: chatgptCatalogSelection(definitions, async () => "failed"),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await other.resolve(), { mode: "cached-first" });
    expect([...otherResult.candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt")?.outcome)
      .toEqual({ kind: "unavailable", reason: "discovery-pending" });
  });

  test("fresh replacement, transport retention, auth invalidation, and stale in-flight writes obey cache generation", async () => {
    const fixture = await cachedCatalogFixture("lifecycle");
    const definitions = accessProviderRegistry(fixture.modules).selection.definitions;
    const list = async (models: CatalogResult, mode: "fresh" | "cached-first" = "fresh") => createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => models),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await fixture.resolve(), { mode });

    await list(["gpt-old"]);
    await list(["gpt-new"]);
    expect((await list("failed", "cached-first")).providers.get("chatgpt")).toEqual(new Set(["gpt-new"]));
    await list("failed");
    expect((await list("failed", "cached-first")).providers.get("chatgpt")).toEqual(new Set(["gpt-new"]));
    const invalid = await list("auth-invalid");
    expect([...invalid.candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt")?.outcome)
      .toEqual({ kind: "unavailable", reason: "authentication-invalid" });
    expect([...(await list("failed", "cached-first")).candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt")?.outcome)
      .toEqual({ kind: "unavailable", reason: "discovery-pending" });

    await list(["gpt-generation-one"]);
    let releaseOld: ((value: CatalogResult) => void) | undefined;
    const oldResponse = new Promise<CatalogResult>((resolve) => { releaseOld = resolve; });
    const oldAuth = await fixture.resolve();
    const oldRequest = createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => oldResponse),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(oldAuth, { mode: "fresh" });
    const current = loadAuthStoreWithDiagnostics(fixture.directory).store.chatgpt;
    if (!isCredentialCollection(current) || current[0] === undefined) throw new Error("Expected stored ChatGPT account");
    const reconnect = { ...current[0].credential, access: "access-generation-two" };
    expect(await replaceCredentialInstanceWithReceipt("chatgpt", "account", current[0].credential, reconnect, fixture.directory, fixture.slots)).toBeDefined();
    await list(["gpt-generation-two"]);
    releaseOld?.(["gpt-stale"]);
    await oldRequest;
    expect((await list("failed", "cached-first")).providers.get("chatgpt")).toEqual(new Set(["gpt-generation-two"]));
  });

  test("real eligibility publishes cached admission before one background fresh refresh settles", async () => {
    const fixture = await cachedCatalogFixture("eligibility");
    const registry = accessProviderRegistry(fixture.modules);
    const definitions = registry.selection.definitions;
    await createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => ["gpt-6.1-sol"]),
      modelsClient: eligibilityModelsClient,
    }).getModelCatalogs(await fixture.resolve(), { mode: "fresh" });
    let finishFresh: ((value: CatalogResult) => void) | undefined;
    const freshResult = new Promise<CatalogResult>((resolve) => { finishFresh = resolve; });
    const listing = createModelListingClient({
      authDir: fixture.directory,
      classifySlot: fixture.slots,
      captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
      providers: chatgptCatalogSelection(definitions, async () => freshResult),
      modelsClient: eligibilityModelsClient,
    });
    const service = createProviderModelPreferenceService({ ...unusedProviderModelWrites(), displayName: registry.selection.displayName, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" });
    let revision = 0;
    const account = { kind: "subscription", providerId: "chatgpt", instanceId: "account" } as const;
    const refreshedPublished = Promise.withResolvers<void>();
    let background: Promise<unknown> | undefined;
    const backgroundStarted = Promise.withResolvers<void>();
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: fixture.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => fixture.modules, observeAuth: diskAuthObservation(() => fixture.modules),
      prepare: service.prepare,
      publish: (state) => {
        service.publish(state);
        if (state.accountCatalogs.get(accessProviderAccountKey(account))?.catalog.has("gpt-5.5-pro")) refreshedPublished.resolve();
      },
      current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: fixture.resolve,
      resolveCatalog: ({ auth, discoveryMode, signal }) => {
        const operation = resolveProviderModelCatalog({ userDataRoot: fixture.userDataRoot, authDirectory: () => fixture.directory, moduleSelection: () => fixture.modules, auth, discoveryMode, signal, listingClient: listing });
        if (discoveryMode === "refresh") {
          background = operation;
          backgroundStarted.resolve();
        }
        return operation;
      },
    });
    const cached = await prepare({ id: fixture.profileId, directory: fixture.directory });
    revision = cached.revision;
    expect(cached.picker?.has("gpt-6.1-sol")).toBe(true);
    await backgroundStarted.promise;
    expect(background).toBeDefined();
    finishFresh?.(["gpt-5.5-pro"]);
    await background;
    await Promise.race([refreshedPublished.promise, Bun.sleep(20).then(() => { throw new Error("background catalog was not published"); })]);
    const refreshed = service.state(fixture.profileId);
    expect(refreshed?.revision).toBeGreaterThan(revision);
    expect(refreshed?.picker?.has("gpt-6.1-sol")).toBe(false);
    expect(refreshed?.accountCatalogs.get(accessProviderAccountKey(account))?.catalog).toEqual(new Set(["gpt-5.5-pro"]));
    expect(refreshed?.inventoryCandidates.get(accessProviderAccountKey(account))?.inventoryOfferings?.has("gpt-5.5-pro")).toBe(true);
    await service.dispose();
  });

  test("a provider with first-party-only membership admits no model while its listing is empty", async () => {
    const admission = async (membership: "first-party" | undefined) => {
      const fixture = await cachedCatalogFixture(`first-party-membership-${membership ?? "control"}`);
      const registry = accessProviderRegistry(fixture.modules);
      const definitions = registry.selection.definitions;
      const account = accessProviderAccountKey({ kind: "subscription", providerId: "chatgpt", instanceId: "account" });
      const listing = createModelListingClient({
        authDir: fixture.directory,
        classifySlot: fixture.slots,
        captureSubscriptions: captureFixtureSubscriptions(fixture, definitions),
        providers: chatgptCatalogSelection(definitions.map((definition) => definition.id === "chatgpt" && definition.dynamicCatalog !== undefined && definition.dynamicCatalog.probeAccess === undefined && membership !== undefined
          ? { ...definition, dynamicCatalog: { ...definition.dynamicCatalog, membership } }
          : definition), async () => []),
        modelsClient: eligibilityModelsClient,
      });
      const service = createProviderModelPreferenceService({ ...unusedProviderModelWrites(), displayName: registry.selection.displayName, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" });
      let refreshSettled = false;
      let refresh: Promise<unknown> | undefined;
      const refreshStarted = Promise.withResolvers<void>();
      const refreshedPublished = Promise.withResolvers<void>();
      const prepare = createEligibilityPreparation({
        allowTrainingRoutes: () => false,
        userDataRoot: fixture.userDataRoot,
        resolveKey: async () => undefined,
        moduleSelection: () => fixture.modules, observeAuth: diskAuthObservation(() => fixture.modules),
        prepare: service.prepare,
        publish: (state) => {
          service.publish(state);
          if (refreshSettled) refreshedPublished.resolve();
        },
        current: service.state,
        inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
        resolveAuth: fixture.resolve,
        resolveCatalog: ({ auth, discoveryMode, signal }) => {
          const operation = resolveProviderModelCatalog({ userDataRoot: fixture.userDataRoot, authDirectory: () => fixture.directory, moduleSelection: () => fixture.modules, auth, discoveryMode, signal, listingClient: listing });
          if (discoveryMode !== "refresh") return operation;
          const settled = operation.then((resolved) => { refreshSettled = true; return resolved; });
          refresh = settled;
          refreshStarted.resolve();
          return settled;
        },
      });
      try {
        await prepare({ id: fixture.profileId, directory: fixture.directory });
        await refreshStarted.promise;
        await refresh;
        await Promise.race([refreshedPublished.promise, Bun.sleep(20).then(() => { throw new Error("the refreshed catalog was not published"); })]);
        const state = service.state(fixture.profileId);
        if (state === undefined) throw new Error("eligibility was not published");
        const decision = providerModelEligibilityDecision({ profileId: fixture.profileId, revision: state.revision, catalogs: state.catalogs, enabledCandidates: state.enabledCandidates });
        const plan = registry.selection.plan("gpt-6.1-sol", captureAccountConnection(await fixture.resolve(), fixture.directory, registry, fixture.profileId), decision.worker);
        return { state, plan, account };
      } finally {
        await prepare.dispose();
        await service.dispose();
      }
    };

    const control = await admission(undefined);
    expect(control.plan.kind).toBe("admitted");
    const firstParty = await admission("first-party");
    expect(firstParty.state.accountCatalogs.get(firstParty.account)?.catalog.size ?? 0).toBe(0);
    expect(firstParty.state.inventoryCandidates.get(firstParty.account)?.inventoryOfferings?.size ?? 0).toBe(0);
    expect(firstParty.state.picker?.has("gpt-6.1-sol") ?? false).toBe(false);
    expect(firstParty.plan.kind).not.toBe("admitted");
  });
});
