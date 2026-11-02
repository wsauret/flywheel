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
import { appendCredentialInstanceWithReceipt, replaceCredentialInstance, replaceCredentialInstanceWithReceipt, rollbackAuthStoreMutation } from "../../../../src/infra/auth/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import { isCredentialCollection } from "../../../../src/infra/auth/auth-store-types.js";
import { accessProviderAccountKey, accessProviderCandidateKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { canonicalCatalogModelId } from "../../../../src/infra/llm/model-id.js";
import type { ModelInfo, ModelsClient } from "../../../../src/infra/llm/models.js";
import { admitModelsDocument } from "../../../../src/infra/llm/models-document.js";
import bundledModelsText from "../../../../src/infra/llm/models-bundled.txt";
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { captureAccountConnection } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { loginWithOAuth } from "../../../../src/orchestration/auth/auth-actions.js";
import { chatgptModule } from "../../../../src/orchestration/modules/provider-chatgpt/module.js";
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js";
import { providerModelEligibilityDecision } from "../../../../src/orchestration/config/provider-model-eligibility.js";
import { authProfileEligibilityInputRevision, createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js";
import type { ProviderModelInventoryCandidate } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { installedAccessProviderDefinitions, installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js";

import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
const SECRET = "phase-7-access-token";
const temporaryDirectory = temporaryDirectories();

type OAuthDefinition = Parameters<typeof loginWithOAuth>[0];

/** Model IDs from the models.dev document bundled with Flywheel. */
function bundledProviderModelIds(providerIds: readonly string[]): readonly string[] {
  const { document } = admitModelsDocument(bundledModelsText);
  return [...new Set(providerIds.flatMap((providerId) => Object.values(document[providerId]?.models ?? {}).map((model) => model.id)))];
}

function declaresOAuth(definition: AccessProviderDefinition): definition is OAuthDefinition {
  return definition.auth.kind === "oauth";
}

/** The shipped ChatGPT definition, whose browser flow this test replaces with an injected start. */
function chatgptDefinition(): OAuthDefinition {
  const definition = chatgptModule.contributions.find((contribution) => contribution.domain === "providers")?.value.definition;
  if (definition === undefined || !declaresOAuth(definition)) throw new Error("ChatGPT declares no OAuth provider");
  return definition;
}

/** The same definitions with the ChatGPT listing failing at the transport, so
 *  settlement falls back to bundled evidence without a network request. */
function discoveryFailingSelection(definitions: readonly AccessProviderDefinition[]) {
  return createAccessProviderSelection(definitions.map((definition) => definition.id === "chatgpt" && definition.dynamicCatalog !== undefined
    ? { ...definition, dynamicCatalog: { ...definition.dynamicCatalog, fetch: async ({ credential }) => ({ discovery: { kind: "failed" as const, reason: "transport" as const }, credential }) } }
    : definition));
}

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
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
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
    const service = createProviderModelPreferenceService({ displayName: registry.selection.displayName, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" });
    let revision = 0;
    const account = { kind: "subscription", providerId: "chatgpt", instanceId: "account" } as const;
    const refreshedPublished = Promise.withResolvers<void>();
    let background: Promise<unknown> | undefined;
    const backgroundStarted = Promise.withResolvers<void>();
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: fixture.userDataRoot,
      resolveKey: async () => undefined,
      moduleSelection: () => fixture.modules,
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

  test("ChatGPT login publishes bundled exact-candidate eligibility after discovery failure", async () => {
    const userDataRoot = temporaryDirectory("flywheel-phase-7-");
    const profileId = "phase-7";
    const authDir = join(userDataRoot, "auth", "profiles", profileId);
    const profileAccess = await new AuthProfileStore(userDataRoot).create(profileId);
    expect(profileAccess.readFile("provider-model-catalogs.json", 1024)).toBeUndefined();
    profileAccess.close();

    const modules = composeFirstPartyModules();
    const registry = accessProviderRegistry(modules);
    const slots = credentialSlotClassifier(modules);
    const resolveKey = async () => undefined;
    const bundled = bundledProviderModelIds(["openai"]);
    const catalogModel = "gpt-6.1-sol";
    expect(bundled).toContain(catalogModel);
    expect(bundledProviderModelIds(["github-copilot"])).toContain(catalogModel);
    const modelInfo = (model: string): ModelInfo => ({
      provider: "openai",
      family: "openai",
      id: model,
      name: model,
      releaseDate: "2026-03-01",
      openWeights: false,
      reasoning: true,
      toolCall: true,
      attachment: true,
      temperature: true,
      contextLimit: 128_000,
      outputLimit: 16_384,
      cost: { input: 5, output: 10 },
      pricing: {
        status: "available",
        rateCard: { input: 5, output: 10 },
        provenance: { source: "models.dev", catalog: "bundled", provider: "openai", model },
      },
      modalities: { input: ["text"], output: ["text"] },
    });
    const modelsClient: ModelsClient = {
      refresh: async () => {},
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: (providerIds) => providerIds.includes("openai") ? bundled.map((model) => ({
        providerId: "openai",
        providerName: "OpenAI",
        wireModelId: model,
        metadata: modelInfo(model),
        provenance: "bundled",
        canonical: { providerId: "openai", modelId: model },
        transport: { npm: "@ai-sdk/openai" },
      })) : [],
    };
    const published = createProviderModelPreferenceService({ displayName: registry.selection.displayName, allowTrainingRoutes: () => false, persist: async () => "preference-revision-next", persistAllDeselected: async () => "preference-revision-next" });

    const auth = await loginWithOAuth(chatgptDefinition(), {
      authDir,
      profileId: "work",
      resolveKey,
      openBrowser: async () => true,
      launcher: refusingLauncher,
      settle: async () => {},
    }, {
      start: async () => ({
        identity: "phase-7-account",
        credential: {
          type: "oauth",
          access: Redacted.make(SECRET),
          refresh: Redacted.make("phase-7-refresh-token"),
          expires: Date.now() + 60_000,
          accountId: "phase-7-account",
        },
      }),
      persist: async (providerId, credential, destination, instance, signal) => {
        const receipt = await appendCredentialInstanceWithReceipt(providerId, { id: instance.id, identity: instance.identity ?? "phase-7-account", credential }, destination, slots, signal);
        return {
          instanceId: instance.id,
          persisted: true,
          rollback: () => rollbackAuthStoreMutation(receipt, destination, slots),
        };
      },
      resolve: resolveAuthContext,
      readUsage: async () => ({ kind: "fetch-failure" }),
      settle: async (_providerId, directory) => {
        const settledAuth = await resolveAuthContext({ authDir: directory, resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: slots });
        const liveListingClient = createModelListingClient({
          authDir: directory,
          classifySlot: slots,
          captureSubscriptions: () => captureSubscriptionCredentials(registry.selection.definitions, { kind: "persisted", authDir: directory, classifySlot: slots }),
          providers: discoveryFailingSelection(registry.selection.definitions),
          modelsClient,
        });
        const unavailableCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "unavailable-account", spendMode: "included" } as const;
        const listingClient = {
          ...liveListingClient,
          getModelCatalogs: async (...[authContext, request]: Parameters<typeof liveListingClient.getModelCatalogs>) => {
            const listed = await liveListingClient.getModelCatalogs(authContext, { ...request, mode: "fresh" });
            const fallback = [...listed.candidates.values()].find(({ candidate }) => candidate.providerId === "chatgpt");
            const visibleModels = fallback?.models ?? fallback?.visibleModels;
            return { ...listed, candidates: new Map([...listed.candidates, [accessProviderAccountKey(unavailableCandidate), { candidate: unavailableCandidate, models: null, visibleModels }]]) };
          },
        };
        const resolved = await resolveProviderModelCatalog({ userDataRoot, authDirectory: () => directory, moduleSelection: () => modules, auth: settledAuth, listingClient });
        expect(resolved.accounts.get(accessProviderAccountKey(unavailableCandidate))?.catalog.size).toBeGreaterThan(0);
        const catalogs = resolved.providers;
        const candidates = new Map<string, ProviderModelInventoryCandidate>([...resolved.inventoryCandidates].map(([key, candidate]): [string, ProviderModelInventoryCandidate] => {
          const outcome = candidate.outcome;
          const catalog = outcome?.kind === "catalog"
            ? outcome.liveOutcome === "authentication-absent"
              ? { kind: "unavailable" as const, reason: "authentication-absent" as const }
              : { kind: "available" as const, provenance: outcome.provenance, liveOutcome: outcome.liveOutcome }
            : { kind: "unavailable" as const, reason: outcome?.reason ?? "authentication-absent" };
          return [key, {
            candidate: candidate.candidate,
            configured: candidate.configured,
            currentConnection: candidate.currentConnection,
            enabledOfferings: candidate.enabledOfferings,
            inventoryOfferings: candidate.inventoryOfferings,
            catalog,
          }];
        }));
        const state = published.prepare({
          profileId,
          authRevision: "auth-revision",
          preferenceRevision: "preference-revision",
          catalogs,
          inventoryCandidates: candidates,
          accountCatalogs: resolved.accounts,
          releaseDates: new Map(),
        });
        published.publish(state);
      },
    });

    const stored = loadAuthStoreWithDiagnostics(authDir).store.chatgpt;
    expect(isCredentialCollection(stored)).toBe(true);
    if (!isCredentialCollection(stored) || stored[0] === undefined) throw new Error("ChatGPT credential was not persisted");
    const candidates = [
      { kind: "subscription", providerId: "chatgpt", instanceId: stored[0].id, spendMode: "included" },
      { kind: "subscription", providerId: "chatgpt", instanceId: stored[0].id, spendMode: "prepaid" },
      { kind: "subscription", providerId: "chatgpt", instanceId: stored[0].id, spendMode: "automatic" },
    ] as const;
    const candidate = candidates[0];
    const state = published.state(profileId);
    expect(state).toBeDefined();
    if (state === undefined) throw new Error("eligibility was not published");
    const picker = state.picker;
    if (picker === undefined) throw new Error("picker eligibility was not published");
    const fallbackModel = picker.keys().next().value;
    expect(fallbackModel).toBeDefined();
    if (fallbackModel === undefined) throw new Error("bundled fallback produced no selectable model");
    expect(picker.get(fallbackModel)).toMatchObject({
      explicitlyEnabled: false,
      catalog: { kind: "available", provenance: "models-dev-bundled", liveOutcome: "discovery-failed" },
    });

    const decision = providerModelEligibilityDecision({ profileId, revision: state.revision, catalogs: state.catalogs, enabledCandidates: state.enabledCandidates });
    const connection = captureAccountConnection(auth, authDir, registry, profileId);
    const plan = registry.selection.plan(fallbackModel, connection, decision.worker);
    expect(plan.kind).toBe("admitted");
    if (plan.kind !== "admitted") throw new Error(plan.reason);
    expect(plan.candidates).toEqual(candidates);
    const expectedAttributions = candidates.map((entry) => {
      const offering = decision.worker.candidateOffering?.(entry, fallbackModel, false);
      if (offering === undefined) throw new Error(`Missing wire model for ${accessProviderCandidateKey(entry)}`);
      return { ...offering, candidate: entry, eligibilityProfileId: profileId, eligibilityRevision: state.revision };
    });
    expect(plan.candidateAttributions).toEqual(expectedAttributions);
    expect(plan.candidates[0] && accessProviderCandidateKey(plan.candidates[0])).toBe(accessProviderCandidateKey(candidate));
    expect(JSON.stringify(plan.candidateAttributions)).not.toContain(SECRET);
  });
});
