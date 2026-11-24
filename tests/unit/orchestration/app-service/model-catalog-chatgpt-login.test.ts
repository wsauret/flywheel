import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { join } from "node:path";
import { captureSubscriptionCredentials, resolveAuthContext } from "../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import { isCredentialCollection } from "../../../../src/infra/auth/auth-store-types.js";
import { accessProviderCandidateKey, createAccessProviderSelection, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import type { ModelInfo, ModelsClient } from "../../../../src/infra/llm/models.js";
import { admitModelsDocument } from "../../../../src/infra/llm/models-document.js";
import bundledModelsText from "../../../../src/infra/llm/models-bundled.txt";
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { captureAccountConnection } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { providerLoginFlow } from "../../../../src/orchestration/auth/auth-actions.js";
import { chatgptModule } from "../../../../src/orchestration/modules/provider-chatgpt/module.js";
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/models/model-assignment-providers.js";
import { providerModelEligibilityDecision } from "../../../../src/orchestration/config/models/provider-model-eligibility.js";
import type { ProviderModelInventoryCandidate } from "../../../../src/orchestration/app-service/provider-model-preference-service.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js";
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
import { unusedProviderModelWrites } from "../../../helpers/provider-model-writes.js";
import { accessProviderAccountKey } from "../../../../src/infra/auth/provider-account.js";

const SECRET = "phase-7-access-token";
const temporaryDirectory = temporaryDirectories();

type OAuthDefinition = AccessProviderDefinition & { readonly auth: { readonly kind: "oauth" } };

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

describe("catalog auth eligibility", () => {
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
    const published = createProviderModelPreferenceService({ ...unusedProviderModelWrites(), displayName: registry.selection.displayName, allowTrainingRoutes: () => false, persist: async () => "preference-revision-next", persistAllDeselected: async () => "preference-revision-next" });

    const definition = chatgptDefinition();
    const start = async () => ({
      identity: "phase-7-account",
      credential: {
        type: "oauth",
        access: Redacted.make(SECRET),
        refresh: Redacted.make("phase-7-refresh-token"),
        expires: Date.now() + 60_000,
        accountId: "phase-7-account",
      },
    } as const);
    const flow = providerLoginFlow("chatgpt", [{ definition: { ...definition, auth: { ...definition.auth, start } }, usageReader: async () => ({ kind: "fetch-failure" }) }]);
    if (flow === undefined) throw new Error("expected the ChatGPT login flow");

    const auth = await flow.login({
      authDir,
      profileId: "work",
      resolveKey,
      openBrowser: async () => true,
      launcher: refusingLauncher,
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
          inputRevision: { auth: "auth-revision", preferences: "preference-revision" },
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
      const offering = decision.worker.candidateOfferings(entry, fallbackModel, false)[0];
      if (offering === undefined) throw new Error(`Missing wire model for ${accessProviderCandidateKey(entry)}`);
      return { ...offering, candidate: entry, eligibilityProfileId: profileId, eligibilityRevision: state.revision };
    });
    expect(plan.candidateAttributions).toEqual(expectedAttributions);
    expect(plan.candidates[0] && accessProviderCandidateKey(plan.candidates[0])).toBe(accessProviderCandidateKey(candidate));
    expect(JSON.stringify(plan.candidateAttributions)).not.toContain(SECRET);
  });
});
