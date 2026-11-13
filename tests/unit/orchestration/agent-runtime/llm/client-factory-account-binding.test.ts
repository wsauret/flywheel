import { describe, expect, test } from "bun:test";
import { Redacted, Schema } from "effect";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthStore, OAuthCredential } from "../../../../../src/infra/auth/auth-store-types.js";
import { captureProviderConnection, captureSubscriptionCredentials, type AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { storedTokensToCredential } from "../../../../../src/infra/auth/openai-auth-types.js";
import { authDir, modelsSnapshotFile } from "../../../../../src/infra/paths.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { fakeModelsClient, modelInfo } from "../../../../helpers/model-tier-fixtures.js";
import { clearSharedModelListingClients, getSharedModelListingClient, getSharedModelsClient, resetSharedLlmClients } from "../../../../../src/orchestration/config/llm-clients.js";
import { createAdmittedClient, createClient, type AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import type { AdapterAdmission } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules, composeRealmModuleSnapshot } from "../../../../../src/orchestration/modules.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { AccessProviderCandidateSchema, createAccessProviderSelection, type AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js";

import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { combinedModelsDevJson, combinedModelsDevProviders } from "../../../../helpers/model-catalog-fixtures.js";
import { requestEvents } from "./_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js";
import { fixedDefinitions } from "../../../../helpers/project-definitions.js";
import { roleCapture } from "../../../../helpers/role-capture.js";
import { resolveSessionRoles } from "../../../../../src/orchestration/config/session-role-resolver.js";
import { asModelClient } from "../_model-client.js";
import { testCapabilityModules, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { SESSION_TITLE_PURPOSE } from "../../../../../src/orchestration/session/session-title.js";

const temporaryDirectory = temporaryDirectories();

/** The fixture metadata of `model`. */
function listedInfo(model: string): ModelInfo {
  const info = fakeModelsClient.modelInfos.get(model);
  if (info === undefined) throw new Error(`Missing fixture metadata for ${model}`);
  return info;
}

/** A standard-data Responses offering of `model` with its fixture metadata. */
function liveOffering(candidate: AccessProviderCandidate, model: string) {
  return { candidate, wireModelId: model, dataUse: "standard" as const, transport: "openai-responses" as const, resolvedModelMetadata: listedInfo(model) } as const;
}

/** The options of a client on the live-eligibility auth whose admission allows every request. */
function liveClientOptions() {
  return {
    notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(), authDir: CREDENTIALS, profileId: "default", allowTrainingRoutes: true,
    requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }), projectRoot: testDirectories(process.cwd()).projectRoot,
  };
}

const accountA: OAuthCredential = {
  type: "oauth",
  access: "access-a",
  refresh: "refresh-a",
  expires: 1,
  accountId: "account-a",
};

const accountB: OAuthCredential = {
  type: "oauth",
  access: "access-b",
  refresh: "refresh-b",
  expires: 2,
  accountId: "account-b",
};

// The account credential directory the composition root publishes. The read is
// injected here, so no case touches the developer's own credentials.
const CREDENTIALS = authDir(testDirectories(process.cwd()).userDataRoot, "default");

const LIVE_ELIGIBILITY_AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "test-openai-key", openrouter: "test-openrouter-key" } }),
  droppedCredentials: [],
  credentialLineages: { openai_api: "00000000-0000-4000-8000-000000000001", openrouter: "00000000-0000-4000-8000-000000000002" },
};

describe("provider credential binding", () => {
  test("uses one injected Copilot connection and honors the next role request's capture", async () => {
    const noKeysAuth = { providers: authProviders(), credentialLineages: {}, droppedCredentials: [] };
    const auth = { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, oauth: ["github_copilot"] }) };
    const directories = testDirectories("/scratch");
    const eligibility = {
      modelIds: new Set(["gpt-6-luna"]),
      modelUnavailableReason: () => undefined,
      candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({
        candidate, wireModelId: model, dataUse: "standard" as const, transport: "openai-responses" as const,
        catalogMetadata: { supportedEndpoints: ["/responses"] },
        resolvedModelMetadata: modelInfo("openai", model, "fixture", 2, 8, "2026-10-01"),
      }),
    };
    let authDirectoryReads = 0;
    const connection = captureProviderConnection({
      profileId: "default", auth, authDir: CREDENTIALS,
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "copilot-a", credential: {
        type: "oauth", access: Redacted.make("copilot-token"), refresh: Redacted.make("github-token"), expires: 1,
      } }]]]),
      oauthPersistence: "memory-only",
    });
    // The definition owner names the test project, never the checkout: the finished
    // title run below sweeps its owner's project root for aged breadcrumbs.
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default", getAuth: () => noKeysAuth, definitions: fixedDefinitions({ projectRoot: directories.projectRoot }),
      moduleSelection: testCapabilityModules(), captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => { authDirectoryReads += 1; return CREDENTIALS; },
      getProviderModelEligibility: () => eligibility, connection,
      userDataRoot: directories.userDataRoot, modelsClient: fakeModelsClient,
      captureSubscriptionAdmission: async () => ({
        consent: { profileId: "default", rows: [], authorizations: new Map() },
        subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
        bankedResetFor: () => false,
        expiringResetFor: () => undefined,
      }),
    });
    const client = await runtime.createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime());
    const capture = await runtime.captureProviderConnection();
    const plan = capture.providers.selection.plan("gpt-6-luna", capture.connection, eligibility);
    expect(plan).toMatchObject({
      kind: "admitted", model: "gpt-6-luna",
      candidateAttributions: expect.arrayContaining([expect.objectContaining({ wireModelId: "gpt-6-luna" })]),
    });
    const admittedClient = await capture.admit(new Map([["gpt-6-luna", plan]])).createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime());
    expect((await client.plannedAttempt()).accessProvider).toBe("github_copilot");
    expect((await admittedClient.plannedAttempt()).accessProvider).toBe("github_copilot");
    expect(capture.connection).toBe(connection);
    expect(authDirectoryReads).toBe(0);

    const outgoing: string[] = [];
    const requestCapture = {
      ...roleCapture(["gpt-6-luna"]),
      admit: () => ({
        createAgent: runtime.createAgent,
        createLLMClient: async (model: string) => asModelClient({
          model, modelFamily: "openai", accessProvider: "openai_api",
          contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: true,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() {
            outgoing.push(model);
            yield { kind: "text_delta", text: "done", blockKey: "text" };
            yield { kind: "done", stopReason: "end_turn" };
          },
        }),
      }),
    };
    const agent = capture.admit(new Map()).createAgent({
      ...directories, purpose: SESSION_TITLE_PURPOSE, agentsMd: "", memorySnapshot: null,
      runtimeSurfaces: {}, toolProfile: "none", conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
      onEvent: () => {}, captureProviderConnection: async () => requestCapture,
      resolveRoles: (current) => resolveSessionRoles({ defaults: {}, overrides: {} }, current ?? requestCapture, directories.userDataRoot),
      requestSelection: (roles) => ({ roleId: "title-generation", ...roles.get("title-generation") }),
    });
    agent.send("work");
    expect((await agent.done).terminal.kind).toBe("completed");
    expect(outgoing).toEqual(["gpt-6-luna"]);
  });

  test("captures usage-only Claude seats into one account-specific metered route without changing ordinary seat routes", () => {
    const directory = temporaryDirectory("claude-seat-routing-");
    for (const [instanceId, fields] of [
      ["metered", { seatTier: "enterprise_usage_based", billingType: "aws_marketplace" }],
      ["included", { seatTier: "enterprise", billingType: "aws_marketplace", planDisplayName: "Claude Enterprise" }],
      ["unknown", { planDisplayName: "Claude Enterprise", billingType: "usage_based" }],
    ] as const) {
      const configDir = join(directory, LOGIN_ACCOUNTS_DIRECTORY, instanceId);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: {
        accountUuid: instanceId, emailAddress: `${instanceId}@example.com`, ...fields,
      } }));
    }
    const { definition } = createClaudeAgentSdkModule().contributions[0].value;
    const credentials = captureSubscriptionCredentials([definition], { kind: "decoded", authDir: directory, store: {} });
    const connection = captureProviderConnection({
      authDir: directory, auth: { providers: new Map(), droppedCredentials: [], credentialLineages: {} }, subscriptionCredentials: credentials,
    });
    const plan = createAccessProviderSelection([definition]).plan("claude-opus-4.5", connection, {
      modelUnavailableReason: () => undefined,
      candidateOffering: (candidate, model) => ({
        candidate, wireModelId: model, dataUse: "standard", transport: "anthropic-messages",
      }),
    });
    if (plan.kind !== "admitted") throw new Error(plan.reason);
    const expected: AccessProviderCandidate[] = [
      ...(["included", "automatic"] as const).flatMap((spendMode) => ["included", "unknown"].map((instanceId) => ({
        kind: "subscription" as const, providerId: "claude_agent_sdk", instanceId, spendMode,
      }))),
      { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "metered", spendMode: "direct_api" },
    ];
    expect(plan.candidates).toEqual(expected);
    for (const candidate of plan.candidates) expect(Schema.decodeUnknownSync(AccessProviderCandidateSchema)(candidate)).toEqual(candidate);
    expect(credentials.get("claude_agent_sdk")?.find(({ instanceId }) => instanceId === "metered")).toMatchObject({
      identity: "metered@example.com", lineageId: "metered", credential: { type: "external", configDir: join(directory, LOGIN_ACCOUNTS_DIRECTORY, "metered") },
    });
  });

  test("ChatGPT refresh preserves metered and disabled subscription credentials and lineages", async () => {
    const directory = temporaryDirectory("chatgpt-client-");
    const profileDir = join(directory, "profile");
    mkdirSync(profileDir);
    const lineageId = "00000000-0000-4000-8000-000000000010";
    const jwt = (access: string) => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-a" }, access })).toString("base64url")}.signature`;
    writeFileSync(join(profileDir, "auth.json"), JSON.stringify({
      openai_api: { type: "api_key", key: "metered-key", lineageId },
      github_copilot: [{ id: "disabled", identity: "disabled", lineageId, credential: accountB }],
      chatgpt: [{ id: "selected", identity: "selected", lineageId, credential: { type: "oauth", access: jwt("old"), refresh: "refresh-a", expires: 1, accountId: "account-a" } }],
    }));
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      return url.includes("oauth/token")
        ? Response.json({ access_token: jwt("new"), refresh_token: "refresh-b", expires_in: 3600, token_type: "Bearer" })
        : new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
    }, { preconnect: originalFetch.preconnect });
    // Without a WebSocket the ChatGPT transport takes the stubbed HTTP path, so
    // the refreshed token never leaves this process.
    const globalObject: { WebSocket?: unknown } = globalThis;
    const originalWebSocket = globalObject.WebSocket;
    globalObject.WebSocket = undefined;
    try {
      const providers = accessProviderRegistry(composeFirstPartyModules(undefined, ["provider-github-copilot"]));
      const connection = captureProviderConnection({
        profileId: "default", authDir: profileDir,
        auth: { providers: authProviders({ oauth: ["chatgpt"] }), droppedCredentials: [], credentialLineages: {} },
        subscriptionCredentials: captureSubscriptionCredentials(
          providers.selection.definitions, { kind: "persisted", authDir: profileDir, classifySlot: credentialSlotClassifier(providers.composition) },
        ),
      });
      const eligibility = {
        modelUnavailableReason: () => undefined,
        candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({
          candidate, wireModelId: model, dataUse: "standard" as const, transport: "openai-responses" as const,
          resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
        }),
      };
      const plan = providers.selection.plan("gpt-5.5", connection, eligibility);
      const client = await createAdmittedClient(plan, fakeModelsClient, connection, {
        notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
        providers, eligibility, projectRoot: directory, allowTrainingRoutes: false,
        requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }),
      });
      try {
        await requestEvents(client, { messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("") });
      } catch (error) {
        expect(String(error)).toContain("stub");
      }
      expect(requested.some((url) => url.includes("oauth/token"))).toBe(true);
      const persisted = await Bun.file(join(profileDir, "auth.json")).json();
      expect(persisted.openai_api).toEqual({ type: "api_key", key: "metered-key", lineageId });
      expect(persisted.github_copilot).toEqual([{ id: "disabled", identity: "disabled", lineageId, credential: accountB }]);
      expect(persisted.chatgpt[0]).toMatchObject({ id: "selected", lineageId, credential: { refresh: "refresh-b" } });
    } finally {
      globalThis.fetch = originalFetch;
      globalObject.WebSocket = originalWebSocket;
    }
  });
  test("captures immutable, deterministically ordered subscription instances", () => {
    let store: AuthStore = {
      chatgpt: [
        { id: "instance-b", identity: "account-b", lineageId: "00000000-0000-4000-8000-00000000000b", credential: accountB },
        { id: "instance-a", identity: "account-a", lineageId: "00000000-0000-4000-8000-00000000000a", credential: accountA },
      ],
    };
    const definitions = accessProviderRegistry(composeFirstPartyModules()).selection.definitions.filter(({ id }) => id === "chatgpt");
    const first = captureSubscriptionCredentials(definitions, { kind: "decoded", store, authDir: "/scratch/auth" });

    store = { chatgpt: [{ id: "instance-c", identity: "account-c", lineageId: "00000000-0000-4000-8000-00000000000c", credential: accountB }] };
    const second = captureSubscriptionCredentials(definitions, { kind: "decoded", store, authDir: "/scratch/auth" });

    const firstAccounts = first.get("chatgpt");
    expect(firstAccounts?.map(({ instanceId, identity }) => ({ instanceId, identity }))).toEqual([
      { instanceId: "instance-a", identity: "account-a" },
      { instanceId: "instance-b", identity: "account-b" },
    ]);
    const captured = firstAccounts?.[0]?.credential;
    expect(captured?.type).toBe("oauth");
    if (captured?.type !== "oauth") throw new Error("expected captured OAuth credential");
    expect(Redacted.value(captured.access)).toBe("access-a");
    expect(Redacted.value(captured.refresh ?? Redacted.make(""))).toBe("refresh-a");
    expect(JSON.stringify(captured)).not.toContain("access-a");
    expect(JSON.stringify(captured)).not.toContain("refresh-a");
    expect(storedTokensToCredential({ accessToken: captured.access, refreshToken: captured.refresh, expiresAtMs: captured.expires, accountId: captured.accountId })).toEqual(accountA);
    expect(second.get("chatgpt")?.map(({ instanceId, identity }) => ({ instanceId, identity }))).toEqual([{ instanceId: "instance-c", identity: "account-c" }]);
  });

  test("each request captures one immutable eligibility candidate order", async () => {
    let disabled = new Set<string>();
    let eligibilityReads = 0;
    const trainingPolicyReads: boolean[] = [];
    const admittedProviders: string[][] = [];
    const composition = composeFirstPartyModules();
    const directories = testDirectories(process.cwd());
    const client = await createClient(
      "gpt-5.5",
      fakeModelsClient,
      LIVE_ELIGIBILITY_AUTH,
      {
        notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
        authDir: CREDENTIALS,
        profileId: "default",
        allowTrainingRoutes: true,
        requestAdmission: async (candidates) => {
          admittedProviders.push(candidates.map((candidate) => candidate.providerId));
          disabled = new Set(["openai_api"]);
          return Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined });
        },
        projectRoot: directories.projectRoot,
        providers: accessProviderRegistry(composition),
        getProviderModelEligibility: () => {
          eligibilityReads += 1;
          const captured = disabled;
          return {
            modelUnavailableReason: (provider: string, model: string) => captured.has(provider) ? `${provider} is disabled for ${model}.` : undefined,
            candidateModelUnavailableReason: () => undefined,
            candidateOffering: (candidate, model: string, allowTrainingRoutes: boolean) => {
              trainingPolicyReads.push(allowTrainingRoutes);
              const resolvedModelMetadata = fakeModelsClient.modelInfos.get(model);
              if (resolvedModelMetadata === undefined) throw new Error(`Missing fixture metadata for ${model}`);
              return {
                candidate,
                wireModelId: model,
                dataUse: allowTrainingRoutes ? "contributor" as const : "standard" as const,
                transport: "openai-responses" as const,
                resolvedModelMetadata,
              } as const;
            },
          };
        },
      },
    );

    expect(await client.plannedAttempt()).toMatchObject({ accessProvider: "openai_api", credentialLineage: LIVE_ELIGIBILITY_AUTH.credentialLineages.openai_api });
    disabled = new Set(["openai_api"]);
    expect((await client.plannedAttempt()).accessProvider).toBe("openrouter");
    expect(eligibilityReads).toBe(3);
    expect(trainingPolicyReads.every(Boolean)).toBe(true);
    expect(admittedProviders).toEqual([["openai_api", "openrouter"], ["openrouter"]]);

    // The person revoked training routes after the client was built: the request's own capture of the permission
    // plans it, and the client that the permission built admits no contributor route for it.
    trainingPolicyReads.length = 0;
    expect((await client.plannedAttempt(undefined, { allowTrainingRoutes: false })).candidateAttribution?.dataUse).toBe("standard");
    expect(trainingPolicyReads.length).toBeGreaterThan(0);
    expect(trainingPolicyReads.some(Boolean)).toBe(false);
  });

  test("one adapter serves every admission of the same exact wire, also of a later eligibility revision, and each request plans on its own captured eligibility", async () => {
    const builds: string[] = [];
    const registry = accessProviderRegistry(composeFirstPartyModules());
    const factories = new Map([...registry.factories].map(([id, factory]) => [id, async (build: AccessProviderBuild) => {
      builds.push(`${build.candidate.providerId}@${build.attribution.eligibilityRevision}`);
      return factory(build);
    }]));
    const published = (revision: number, refused: ReadonlySet<string> = new Set()) => ({
      profileId: "default", revision, candidateModelUnavailableReason: () => undefined, candidateOffering: liveOffering,
      modelUnavailableReason: (provider: string) => refused.has(provider) ? `${provider} no longer offers the model` : undefined,
    });
    const client = await createClient("gpt-5.5", fakeModelsClient, LIVE_ELIGIBILITY_AUTH, {
      ...liveClientOptions(), providers: { ...registry, factories }, getProviderModelEligibility: () => published(1),
    });

    // Two admissions of one request route: the adapter is a value of the client, so the second finds the first's.
    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api");
    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api");
    // The client outlives later publications (ARCH-PROVIDERS-070): each request plans on its own capture, and a new
    // revision of the same wire reuses the adapter (ARCH-PROVIDERS-023).
    expect((await (await client.admitRequest({ eligibility: published(2), allowTrainingRoutes: true })).plannedAttempt()).accessProvider).toBe("openai_api");
    expect((await client.plannedAttempt(undefined, { eligibility: published(3), allowTrainingRoutes: true })).accessProvider).toBe("openai_api");
    expect((await (await client.admitRequest({ eligibility: published(4, new Set(["openai_api"])), allowTrainingRoutes: true })).plannedAttempt()).accessProvider).toBe("openrouter");
    expect(builds).toEqual(["openai_api@1", "openrouter@4"]);
  });

  test("one adapter stages each request's attempt from that request's eligibility: its provenance, revision, narrowed window, and account lineup, which no later request changes", async () => {
    const builds: AccessProviderBuild[] = [];
    const admissions: AdapterAdmission[] = [];
    const registry = accessProviderRegistry(composeFirstPartyModules());
    const openai = registry.factories.get("openai_api");
    if (openai === undefined) throw new Error("openai_api factory missing");
    const factories = new Map(registry.factories).set("openai_api", async (build) => {
      builds.push(build);
      const adapter = await openai(build);
      return { stage: (admission: AdapterAdmission) => { admissions.push(admission); return adapter.stage(admission); } };
    });
    const listed = listedInfo("gpt-5.5");
    const published = (revision: number, catalogProvenance: "last-known-good" | "live", contextLimit: number, modelIds: readonly string[]) => {
      const candidateOffering = (candidate: AccessProviderCandidate, model: string) => ({ ...liveOffering(candidate, model), catalogProvenance, resolvedModelMetadata: { ...listedInfo(model), contextLimit } });
      return {
        profileId: "default", revision, modelIds: new Set(modelIds), modelUnavailableReason: () => undefined, candidateModelUnavailableReason: () => undefined, candidateOffering,
        candidateOfferings: (candidate: AccessProviderCandidate, model: string) => [candidateOffering(candidate, model)],
      };
    };
    const client = await createClient("gpt-5.5", fakeModelsClient, { ...LIVE_ELIGIBILITY_AUTH, providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }) }, {
      ...liveClientOptions(), providers: { ...registry, factories }, getProviderModelEligibility: () => published(0, "live", listed.contextLimit, ["gpt-5.5"]),
    });
    const lineup = (admission: AdapterAdmission | undefined) => admission?.accountOfferings.map(({ wireModelId }) => wireModelId);

    const first = await (await client.admitRequest({ eligibility: published(1, "last-known-good", listed.contextLimit, ["gpt-5.5", "gpt-5.4"]), allowTrainingRoutes: false })).plannedAttempt();
    expect(first).toMatchObject({ catalogProvenance: "last-known-good", contextLimit: listed.contextLimit, candidateAttribution: { eligibilityRevision: 1 } });
    expect(lineup(admissions[0])).toEqual(["gpt-5.5", "gpt-5.4"]);

    // The listing went live, the account refused the extended window, and a person disabled gpt-5.4.
    const narrowed = await (await client.admitRequest({ eligibility: published(2, "live", 100_000, ["gpt-5.5"]), allowTrainingRoutes: false })).plannedAttempt();
    expect(narrowed).toMatchObject({ catalogProvenance: "live", contextLimit: 100_000, candidateAttribution: { eligibilityRevision: 2 } });
    // Each request carries its own lineup: the later request's narrower lineup leaves the earlier one as it was.
    expect(lineup(admissions[1])).toEqual(["gpt-5.5"]);
    expect(lineup(admissions[0])).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(builds).toHaveLength(1);
  });

  test("each request plans its own candidates, not those of the plan that built the client", async () => {
    let disabled = new Set(["openrouter"]);
    let admissions = 0;
    const composition = composeFirstPartyModules();
    const providers = accessProviderRegistry(composition);
    const directories = testDirectories(process.cwd());
    const connection = captureProviderConnection({
      profileId: "default",
      authDir: CREDENTIALS,
      auth: LIVE_ELIGIBILITY_AUTH,
      subscriptionCredentials: new Map(),
    });
    const eligibility = () => ({
      modelUnavailableReason: (provider: string) => disabled.has(provider) ? `${provider} disabled` : undefined,
      candidateModelUnavailableReason: () => undefined,
      candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({
        candidate,
        wireModelId: model,
        dataUse: "standard" as const,
        transport: "openai-responses" as const,
        resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
      }),
    });
    const plan = providers.selection.plan("gpt-5.5", connection, eligibility());
    if (plan.kind !== "admitted") throw new Error("expected admitted plan");
    disabled = new Set(["openai_api"]);

    const client = await createAdmittedClient(plan, fakeModelsClient, connection, {
      notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
      providers,
      projectRoot: directories.projectRoot,
      requestAdmission: async () => {
        admissions += 1;
        return Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined });
      },
      getProviderModelEligibility: eligibility,
      allowTrainingRoutes: testRuntimeConfigCapture().allowTrainingRoutes,
    });

    // The client outlives a publication that moves the model from one candidate to another (ARCH-PROVIDERS-070),
    // and the request plans the candidate that its own eligibility admits (ARCH-PROVIDERS-023).
    expect((await client.plannedAttempt()).accessProvider).toBe("openrouter");
    expect(admissions).toBe(1);
  });

  test("model listings retain one generation per auth directory and enabled provider identity", () => {
    resetSharedLlmClients();
    const complete = composeFirstPartyModules();
    const anthropicOnly = composeRealmModuleSnapshot({ moduleIds: ["anthropic"] });
    const first = getSharedModelListingClient("/accounts/a", "/profiles/a", complete);
    const otherProfile = getSharedModelListingClient("/accounts/a", "/profiles/b", anthropicOnly);

    expect(getSharedModelListingClient("/accounts/a", "/profiles/a", complete)).toBe(first);
    expect(getSharedModelListingClient("/accounts/b", "/profiles/a", complete)).not.toBe(first);
    expect(getSharedModelListingClient("/accounts/a", "/profiles/a", anthropicOnly)).not.toBe(first);
    expect(otherProfile).not.toBe(first);
    clearSharedModelListingClients("/profiles/a");
    expect(getSharedModelListingClient("/accounts/a", "/profiles/a", complete)).not.toBe(first);
    expect(getSharedModelListingClient("/accounts/a", "/profiles/b", anthropicOnly)).toBe(otherProfile);
    resetSharedLlmClients();
  });
  test("shared model listings read the models.dev catalog the owned refresh published", async () => {
    resetSharedLlmClients();
    // An account root of its own: the shared test home carries the models.dev
    // snapshot a sibling test archived, and an archive stands in for the live
    // document by design, which is not what this case measures.
    const userDataRoot = join(temporaryDirectory("fw-live-catalog-"), ".flywheel");
    const profileDir = authDir(userDataRoot, "live-catalog");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(`${profileDir}/auth.json`, JSON.stringify({
      opencode_go: [{
        id: "go-account",
        identity: "go-account",
        lineageId: "00000000-0000-4000-8000-000000000001",
        credential: { type: "api_key", key: "go-test-key" },
      }],
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json(combinedModelsDevProviders({
      anthropic: { name: "Anthropic", models: { "claude-test": { id: "claude-test" } } },
      "opencode-go": { name: "OpenCode Go", npm: "@ai-sdk/openai-compatible", models: { "deepseek-live-only": { id: "deepseek-live-only" } } },
      p1: { name: "P1", models: {} },
      p2: { name: "P2", models: {} },
      p3: { name: "P3", models: {} },
      p4: { name: "P4", models: {} },
      p5: { name: "P5", models: {} },
      p6: { name: "P6", models: {} },
      p7: { name: "P7", models: {} },
      p8: { name: "P8", models: {} },
    })), { preconnect: originalFetch.preconnect });
    try {
      await getSharedModelsClient(userDataRoot).refresh(new AbortController().signal);
      const client = getSharedModelListingClient(userDataRoot, profileDir, composeFirstPartyModules());
      const models = (await client.getModelCatalogs({ providers: authProviders(), droppedCredentials: [], credentialLineages: {} }, { mode: "fresh" })).providers;

      expect(models.get("opencode_go")).toEqual(new Set(["deepseek-live-only"]));
    } finally {
      globalThis.fetch = originalFetch;
      resetSharedLlmClients();
    }
  });
  test("each account keeps one models generation that listing refresh retains and that archives only under that account", async () => {
    resetSharedLlmClients();
    const firstRoot = join(temporaryDirectory("fw-models-first-"), ".flywheel");
    const secondRoot = join(temporaryDirectory("fw-models-second-"), ".flywheel");
    const first = getSharedModelsClient(firstRoot);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response(combinedModelsDevJson()), { preconnect: originalFetch.preconnect });
    try {
      expect(getSharedModelsClient(firstRoot)).toBe(first);
      clearSharedModelListingClients();
      expect(getSharedModelsClient(firstRoot)).toBe(first);
      // The first account's home can be gone by now. A refresh that another
      // account owns must not create it again by archiving there.
      await getSharedModelsClient(secondRoot).refresh(new AbortController().signal);

      expect(existsSync(modelsSnapshotFile(secondRoot))).toBe(true);
      expect(existsSync(modelsSnapshotFile(firstRoot))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      resetSharedLlmClients();
    }
  });
});
