import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Redacted } from "effect";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { apiKey, captureProviderConnection } from "../../../../src/infra/auth/auth-context.js";
import { writeProviderModelCatalog } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS, type CatalogCanonicalRow } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { modelsSnapshotFile } from "../../../../src/infra/paths.js";
import { createHeadlessProfileRuntime } from "../../../../src/orchestration/headless/headless-profile-runtime.js";
import { getSharedModelsClient, resetSharedLlmClients } from "../../../../src/orchestration/config/llm-clients.js";
import { modelsDevDocument, modelsDevJson, type MutableModelsDevProviders } from "../../../helpers/model-catalog-fixtures.js";
import { testAuthContext } from "../../../helpers/auth-context.js";
import { catalogProfile } from "../../../helpers/catalog-profile.js";
import { testCapabilityModules } from "../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js";
import { prepareWorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js";
import type { ProfileRequestWorkflowPreparation } from "../../../../src/orchestration/auth/profile-request-service.js";
import { chmodSync } from "node:fs";
import { captureHeadlessSnapshotConnection, readHeadlessAuthSnapshot } from "../../../../src/orchestration/headless/benchmark-auth-file.js";
import { applyWindowsPrivateDirectoryAcl } from "../../../../src/infra/windows-private-directory-acl.js";
import { testAccountHome } from "../../../helpers/directories.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";

const originalFetch = globalThis.fetch;

/** A headless run's workflow preparation with no launch authority. Its fixed
 *  model listing keeps the production builder from reading or refreshing the
 *  profile catalog that these tests observe. */
function workflowPreparation(userDataRoot: string): ProfileRequestWorkflowPreparation {
  return {
    onNotification: () => {},
    userDataRoot,
    accountHome: testAccountHome(),
    definitions: repoDefinitions(),
    moduleSelection: testCapabilityModules,
    resolveKey: async () => undefined,
    overrides: { availableModels: new Map() },
  };
}

// The shared models client is a process singleton bound to the first root it
// sees; a file that ran earlier in this process may have left one behind.
beforeEach(() => {
  resetSharedLlmClients();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSharedLlmClients();
});

describe("headless cached catalog ownership", () => {
  test.each([false, true])("access-only preparation leaves the source profile cache untouched and uses only transferred credentials, carried results=%s", async (carried) => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-access-only-"));
    const store = new AuthProfileStore(userDataRoot);
    const access = await store.create("default");
    const profileDirectory = access.authDirectory;
    const openAiLineage = "00000000-0000-4000-8000-000000000011";
    const cachedModel = "gpt-source-profile-only";
    const cachedRows: readonly CatalogCanonicalRow[] = [{
      modelId: cachedModel,
      offerings: [{ wireModelId: cachedModel, metadata: null, dataUse: "standard", transport: "openai-responses" }],
    }];
    access.writeFile("auth.json", JSON.stringify({
      openai_api: { lineageId: openAiLineage, credential: { type: "api_key", key: "source-key" } },
    }));
    expect(await writeProviderModelCatalog(
      catalogProfile(access, accessProviderRegistry(composeFirstPartyModules()).selection.definitions),
      { kind: "singleton", providerId: "openai_api" },
      openAiLineage,
      cachedRows,
      DEFAULT_DYNAMIC_CATALOG_LIMITS,
    )).toBe(true);
    const preferenceBytes = `${JSON.stringify({ version: 2, accounts: [] }, null, 2)}\n`;
    access.writeFile("model-preferences.json", preferenceBytes);
    access.close();

    const transferredAuthDirectory = join(userDataRoot, "transferred-credentials");
    await mkdir(transferredAuthDirectory, { recursive: true });
    const stage = join(userDataRoot, "flywheel-auth-bundle-test");
    await mkdir(stage, { mode: 0o700 });
    if (process.platform === "win32") applyWindowsPrivateDirectoryAcl(stage);
    else chmodSync(stage, 0o700);
    const snapshotFile = modelsSnapshotFile(userDataRoot);
    await mkdir(dirname(snapshotFile), { recursive: true });
    const vertexModel = "gemini-snapshot-only";
    const document: MutableModelsDevProviders = {
      ...modelsDevDocument(),
      "google-vertex": {
        name: "Google Vertex",
        npm: "@ai-sdk/google-vertex",
        models: {
          [vertexModel]: {
            id: vertexModel,
            name: vertexModel,
            family: "gemini",
            reasoning: true,
            tool_call: true,
            attachment: true,
            temperature: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 8_192 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    };
    const vertexRows = document["google-vertex"]!.models;
    vertexRows["gemini-refused"] = { ...vertexRows[vertexModel], id: "gemini-refused" };
    await writeFile(snapshotFile, JSON.stringify({
      ...document,
      xai: { name: "xAI", models: Object.fromEntries(["grok-allowed", "grok-refused"].map((id) => [id, { ...vertexRows[vertexModel], id, family: "grok" }])) },
    }));
    expect((getSharedModelsClient(userDataRoot).getProviderCatalog(["google-vertex"], 10)).map(({ wireModelId }) => wireModelId))
      .toContain(vertexModel);
    const catalogBefore = await readFile(join(profileDirectory, "provider-model-catalogs.json"));
    const preferencesBefore = await readFile(join(profileDirectory, "model-preferences.json"));
    const authBefore = await readFile(join(profileDirectory, "auth.json"));

    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response("unavailable", { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const authFile = join(stage, "auth.json");
    await writeFile(authFile, JSON.stringify({
      profile: "default",
      credentials: {
        openai_api: { type: "api_key", key: "transferred-openai-key", lineageId: openAiLineage },
        google_vertex: { type: "api_key", key: "AQ.transferred-vertex-key", lineageId: "00000000-0000-4000-8000-000000000012" },
        supergrok: [{ id: "primary", identity: "person", lineageId: "00000000-0000-4000-8000-000000000013", credential: { type: "oauth", access: "grok-token", expires: 4_000_000_000_000 } }],
      },
      ...(carried ? { modelAccess: [
        { account: { kind: "singleton", providerId: "google_vertex" }, lineage: "00000000-0000-4000-8000-000000000012", outcomes: { [vertexModel]: "completed", "gemini-refused": "refused" } },
        { account: { kind: "subscription", providerId: "supergrok", instanceId: "primary" }, lineage: "00000000-0000-4000-8000-000000000013", outcomes: { "grok-allowed": "completed", "grok-refused": "refused" } },
      ] } : {}),
    }), { mode: 0o600 });
    const providers = accessProviderRegistry(testCapabilityModules()).selection.definitions;
    const { connection } = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(authFile, providers), transferredAuthDirectory, providers);
    const { auth } = connection;
    const transferredKey = apiKey(auth, "openai_api");
    expect(transferredKey === undefined ? undefined : Redacted.value(transferredKey)).toBe("transferred-openai-key");
    const vertexKey = apiKey(auth, "google_vertex");
    expect(vertexKey === undefined ? undefined : Redacted.value(vertexKey)).toBe("AQ.transferred-vertex-key");
    let cachedSourceOffering: unknown;
    let vertexSnapshotOffering: unknown;
    let accessPending: boolean | undefined;
    const runtime = await createHeadlessProfileRuntime({
      userDataRoot,
      modelsClient: getSharedModelsClient(userDataRoot),
      profile: { id: "default", directory: profileDirectory },
      moduleSelection: testCapabilityModules,
      allowTrainingRoutes: false,
      resolveKey: async () => undefined,
      connection,
      workflowPreparation: workflowPreparation(userDataRoot),
      captureRuntimeConfig: testRuntimeConfigCapture,
      captureSubscriptionAdmission: async () => { throw new Error("Subscription admission is outside this access-only catalog test"); },
      acquireUsageSettlementAuthority: async () => ({
        profileId: "default",
        authorityIncarnation: "test",
        append: () => ({ kind: "appended" }),
        release: async () => {},
      }),
      prepareWorkflowDeps: async (input) => {
        const eligibility = input.providerModelEligibility?.();
        cachedSourceOffering = eligibility?.candidateOffering?.({ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, cachedModel, false);
        vertexSnapshotOffering = eligibility?.candidateOffering?.({ kind: "singleton", providerId: "google_vertex", spendMode: "direct_api" }, vertexModel, false);
        accessPending = eligibility?.accessPending?.();
        expect(input.capturedAuth?.providers).toEqual(auth.providers);
        return prepareWorkflowDeps(input);
      },
    });

    try {
      await runtime.prepare();
      expect(cachedSourceOffering).toBeUndefined();
      if (carried) expect(vertexSnapshotOffering).toBeDefined();
      else expect(vertexSnapshotOffering).toBeUndefined();
      expect(accessPending).toBe(!carried);
      const catalogs = await createModelListingClient({
        authDir: connection.authDir,
        classifySlot: credentialSlotClassifier(testCapabilityModules()),
        providers: accessProviderRegistry(testCapabilityModules()).selection,
        modelsClient: getSharedModelsClient(userDataRoot),
        oauthPersistence: "access-only",
        modelAccess: connection.modelAccess,
        captureSubscriptions: () => connection.subscriptionCredentials,
      }).getModelCatalogs(auth, { mode: "audit" });
      const vertex = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }));
      expect(vertex?.visibleModels?.has(vertexModel)).toBe(true);
      expect(vertex?.models?.has(vertexModel) ?? false).toBe(carried);
      expect(vertex?.visibleModels?.has("gemini-refused")).toBe(!carried);
      const grok = catalogs.candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "supergrok", instanceId: "primary" }));
      expect(grok?.models?.has("grok-allowed") ?? false).toBe(carried);
      expect(grok?.visibleModels?.has("grok-refused")).toBe(!carried);
      expect(requests.some((url) => url.includes(":countTokens") || url.includes("/responses"))).toBe(false);
      expect(await readFile(join(profileDirectory, "provider-model-catalogs.json"))).toEqual(catalogBefore);
      expect(await readFile(join(profileDirectory, "model-preferences.json"))).toEqual(preferencesBefore);
      expect(await readFile(join(profileDirectory, "auth.json"))).toEqual(authBefore);
      expect(await readdir(transferredAuthDirectory)).toEqual([]);
    } finally {
      await runtime.dispose();
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test.each([false, true])("owns background refresh and cancels a pending credential capture=%s", async (cancelCapture) => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-catalog-owner-"));
    const store = new AuthProfileStore(userDataRoot);
    const access = await store.create("default");
    const profileDirectory = access.authDirectory;
    access.writeFile("auth.json", JSON.stringify({ openai_api: { type: "api_key", key: "!helper", lineageId: "00000000-0000-4000-8000-000000000001" } }));
    access.writeFile("provider-model-catalogs.json", JSON.stringify({
      version: 1,
      accounts: [{
        account: { kind: "singleton", providerId: "openai_api" },
        lineage: "00000000-0000-4000-8000-000000000001",
        rows: [{ modelId: "gpt-5.5", offerings: [{ wireModelId: "gpt-5.5", metadata: null, dataUse: "standard", transport: "openai-responses" }] }],
      }],
    }));
    access.close();
    const snapshotFile = modelsSnapshotFile(userDataRoot);
    await mkdir(dirname(snapshotFile), { recursive: true });
    await writeFile(snapshotFile, modelsDevJson());

    let networkInvoked = false;
    let networkSettled = false;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== "https://models.dev/catalog.json") {
        return new Response("unavailable", { status: 503 });
      }
      networkInvoked = true;
      try {
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        networkSettled = true;
      }
      return new Response();
    }, { preconnect: originalFetch.preconnect });

    const auth = testAuthContext({
      apiKeys: { openai_api: "test-key" },
      credentialLineages: { openai_api: "00000000-0000-4000-8000-000000000001" },
    });
    const connection = captureProviderConnection({ authDir: profileDirectory, auth });
    let workflowPublications = 0;
    let usageAcquisitions = 0;
    let keyResolutions = 0;
    const captureEntered = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const runtime = await createHeadlessProfileRuntime({
      userDataRoot,
      modelsClient: getSharedModelsClient(userDataRoot),
      profile: { id: "default", directory: profileDirectory },
      moduleSelection: testCapabilityModules,
      allowTrainingRoutes: false,
      resolveKey: async () => {
        if (++keyResolutions === 2) {
          captureEntered.resolve();
          await releaseCapture.promise;
        }
        return Redacted.make("test-key");
      },
      ...(cancelCapture ? {} : { connection }),
      workflowPreparation: workflowPreparation(userDataRoot),
      captureRuntimeConfig: testRuntimeConfigCapture,
      captureSubscriptionAdmission: async () => { throw new Error("Subscription admission is outside this cache ownership test"); },
      acquireUsageSettlementAuthority: async () => {
        usageAcquisitions++;
        return {
          profileId: "default",
          authorityIncarnation: "test",
          append: () => ({ kind: "appended" }),
          release: async () => {},
        };
      },
      prepareWorkflowDeps: async (input) => {
        workflowPublications += 1;
        return prepareWorkflowDeps(input);
      },
    });

    const caller = new AbortController();
    let outcome: unknown;
    const operation = runtime.prepare(caller.signal).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    try {
      if (cancelCapture) {
        await captureEntered.promise;
        const reason = new DOMException("Caller cancelled", "AbortError");
        caller.abort(reason);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(outcome).toBe(reason);
        expect(usageAcquisitions).toBe(0);
        expect(workflowPublications).toBe(0);
        releaseCapture.resolve();
        await operation;
        expect(usageAcquisitions).toBe(0);
        expect(workflowPublications).toBe(0);
        return;
      }
      await operation;
      expect(outcome).toBeDefined();
      expect(workflowPublications).toBe(1);
      expect(networkInvoked).toBe(true);

      await runtime.dispose();
      expect(networkSettled).toBe(true);
      expect(workflowPublications).toBe(1);
    } finally {
      releaseCapture.resolve();
      await operation;
      await runtime.dispose();
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
