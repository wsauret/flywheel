import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Redacted, Scope } from "effect";
import { captureProviderConnection, resolveAuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { createSubscriptionSpendEnvelope } from "../../../../../src/infra/auth/subscription-spend-consent.js";
import { createSubscriptionAccountIdentity } from "../../../../../src/infra/llm/subscription-account-identity.js";
import { HandoffCorrectionExhausted, isAgentRuntimeError, toFailureReason } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { captureAccountConnection, createAdmittedClient, createClient, stagedProviderClient, type AccessProviderBuild, type ModelRefusalRecord } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { ModelAccessRefusedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { isFailoverFailure, normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { installedModules } from "../../../../../src/orchestration/module-catalog.js";
import { anthropicApiModule } from "../../../../../src/orchestration/modules/provider-anthropic-api/module.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js";
import { isWebSocketSseFallbackActive, recordWebSocketFailure, recordWebSocketSuccess } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket-session.js";
import { authDir } from "../../../../../src/infra/paths.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { testCapabilityModules, testProviderRegistry, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { fixedDefinitions, repoDefinitions } from "../../../../helpers/project-definitions.js";
import { fakeAvailability, preparedRequest, requestEvents } from "./_provider-chain-harness.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "../_model-client.js";

const noKeysAuth = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
};

// The directory authorities a composition root publishes for a run. No case
// here reaches the developer's own account state.
const DIRECTORIES = testDirectories("/scratch");
const EMPTY_ADMISSION = async () => Object.freeze({ subscriptionSpendAuthorizationFor: () => undefined });
const TEST_ELIGIBILITY = {
  modelUnavailableReason: () => undefined,
  candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({
    candidate,
    wireModelId: model,
    dataUse: "standard" as const,
    catalogMetadata: candidate.providerId === "github_copilot" ? { supportedEndpoints: ["/responses"] } : undefined,
    resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
  }),
};
const CLIENT_DIRECTORIES = { notify: () => {}, authDir: authDir(DIRECTORIES.userDataRoot, "default"), profileId: "default", projectRoot: DIRECTORIES.projectRoot, providers: testProviderRegistry(), eligibility: TEST_ELIGIBILITY, requestAdmission: EMPTY_ADMISSION, allowTrainingRoutes: false, providerSessionLifetime: testProviderSessionLifetime() };
const testModelsClient = () => fakeModelsClient;

describe("createClient universal chain", () => {
  const temporaryDirectory = temporaryDirectories();

  test("a family with exactly one configured access provider builds a chain client on it", async () => {
    const client = await createClient("claude-sonnet-4-6", testModelsClient(), {
      ...noKeysAuth,
      providers: authProviders({ base: noKeysAuth.providers, apiKeys: { anthropic_api: "[redacted secret]" } }),
    }, CLIENT_DIRECTORIES);
    expect(client.model).toBe("claude-sonnet-4.6");
    // A ModelClient names no provider; the chain resolves one per request.
    expect((await client.plannedAttempt()).accessProvider).toBe("anthropic_api");
  });

  test("a request whose first candidate is quota-exhausted is served by the second", async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const availability = fakeAvailability({
      chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: resetsAtSeconds * 1000, hold: { kind: "usage_limit", stated: true } },
    }).availability;
    // The client binds its accounts once, at its build.
    const availabilityOwner = { forCandidates: () => availability, dispose: () => Promise.resolve() };
    const client = await createClient(
      "gpt-5.5",
      testModelsClient(),
      { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "[redacted secret]" }, oauth: ["chatgpt"] }),},
      { ...CLIENT_DIRECTORIES, availability: availabilityOwner },
    );
    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api");
  });

  test("one admitted request shares its captured chain between planning and serving", async () => {
    let disabled = new Set<string>();
    let captures = 0;
    const client = await createClient(
      "gpt-5.5",
      testModelsClient(),
      {
        ...noKeysAuth,
        providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "api-key", openrouter: "router-key" } }),
      },
      {
        ...CLIENT_DIRECTORIES,
        eligibility: undefined,
        getProviderModelEligibility: () => {
          captures += 1;
          const captured = disabled;
          return {
            modelUnavailableReason: (provider, model) => captured.has(provider) ? `${provider} is disabled for ${model}.` : undefined,
            candidateOffering: (candidate, model) => ({ candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: fakeModelsClient.modelInfos.get(model) }),
          };
        },
      },
    );

    const first = await client.admitRequest();
    expect((await first.plannedAttempt()).accessProvider).toBe("openai_api");
    disabled = new Set(["openai_api"]);
    expect((await first.plannedAttempt()).accessProvider).toBe("openai_api");

    const second = await client.admitRequest();
    expect((await second.plannedAttempt()).accessProvider).toBe("openrouter");
    expect(captures).toBe(3);
  });

  test("an exhausted handoff correction raised by the request's own work is neither a provider failure nor a failover", async () => {
    const client = await createClient("gpt-5.5", testModelsClient(), {
      ...noKeysAuth,
      providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "api-key", openrouter: "router-key" } }),
    }, CLIENT_DIRECTORIES);
    const exhausted = new HandoffCorrectionExhausted({ message: "handoff failed 3 consecutive attempts" });
    const served: string[] = [];

    const request = (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt }) => {
        served.push(attempt.accessProvider);
        throw exhausted;
      },
    });

    await expect(request).rejects.toBe(exhausted);
    expect(served).toEqual(["openai_api"]);
  });

  test("admits a Claude request with no archived catalog while models.dev never answers", async () => {
    const originalFetch = globalThis.fetch;
    let modelsDevRequests = 0;
    globalThis.fetch = Object.assign(async () => {
      modelsDevRequests += 1;
      return new Promise<Response>(() => {});
    }, { preconnect: originalFetch.preconnect });
    const directory = mkdtempSync(join(tmpdir(), "flywheel-client-factory-catalog-"));
    try {
      const catalog = createModelsClient(join(directory, "models.json"));
      const client = await createClient("claude-sonnet-4-6", {
        ...testModelsClient(),
        getTokenizerIdentity: (model) => catalog.getTokenizerIdentity(model),
      }, {
        ...noKeysAuth,
        providers: authProviders({ base: noKeysAuth.providers, apiKeys: { anthropic_api: "[redacted secret]" } }),
      }, CLIENT_DIRECTORIES);

      expect((await client.plannedAttempt()).tokenizerIdentity).toBe("ClaudeV3");
      expect(modelsDevRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a subscription-only provider with a stored credential is admitted without an AuthContext flag", async () => {
    // opencode_go holds no singleton key, so no AuthContext state names it;
    // the stored subscription credential alone must make the capture admit
    // it (the model listing already works this way).
    // Account layout the locked store expects: an account home with the auth
    // directory nested inside it.
    const dir = join(temporaryDirectory("flywheel-test-auth-"), ".flywheel", "auth");
    await Bun.write(`${dir}/auth.json`, JSON.stringify({ opencode_go: [{ id: "go-account", identity: "••••-key", lineageId: "11111111-1111-4111-8111-111111111111", credential: { type: "api_key", key: "go-test-key" } }] }));
    const providers = testProviderRegistry();
    const connection = captureAccountConnection(noKeysAuth, dir, providers, "default");
    const capturedAuth = await resolveAuthContext({ authDir: dir, resolveKey: async (key) => Redacted.make(key), credentialSlotClassifier: credentialSlotClassifier(providers.composition), definitions: providers.selection.definitions });
    await Bun.write(`${dir}/auth.json`, "{");
    const held = captureAccountConnection(capturedAuth, dir, providers, "default");
    expect(held.subscriptionCredentials.get("opencode_go")?.[0]?.credential).toEqual(connection.subscriptionCredentials.get("opencode_go")?.[0]?.credential);
    expect(providers.selection.plan("qwen3.8-max", held, TEST_ELIGIBILITY).kind).toBe("admitted");
    const plan = providers.selection.plan("qwen3.8-max", connection, TEST_ELIGIBILITY);
    expect(plan.kind).toBe("admitted");
    if (plan.kind !== "admitted") throw new Error("expected admitted plan");
    expect(plan.candidates.map((candidate) => candidate.providerId)).toContain("opencode_go");
  });
});

describe("subscription usage binding", () => {
  test("binds profile availability and included-allowance policy to ordinary and admitted clients", async () => {
    const providers = testProviderRegistry();
    const connection = captureProviderConnection({
      profileId: "default",
      auth: { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, oauth: ["github_copilot"] }),},
      authDir: CLIENT_DIRECTORIES.authDir,
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "copilot-a", credential: { type: "oauth", access: Redacted.make("copilot"), refresh: Redacted.make("github"), expires: 1 } }]]]),
      oauthPersistence: "memory-only",
    });
    const bound: unknown[] = [];
    const availability = fakeAvailability({}).availability;
    const owner = { forCandidates: (profileId: string) => { bound.push(profileId); return availability; }, dispose: () => Promise.resolve() };
    const subscriptionSpendAuthorizationFor = () => undefined;
    // The provider module's own allowance decision rides the admission; the
    // kernel only carries a refusal.
    const subscriptionAllowanceFor = (candidate: AccessProviderCandidate) => candidate.providerId === "github_copilot"
      ? { allowance: "refused", detail: "the current Copilot allowance cannot be verified." } as const
      : { allowance: "unknown" } as const;
    const requestAdmission = async () => Object.freeze({ subscriptionSpendAuthorizationFor, subscriptionAllowanceFor });
    const options = { notify: () => {}, projectRoot: CLIENT_DIRECTORIES.projectRoot, providers, eligibility: TEST_ELIGIBILITY, availability: owner, requestAdmission, allowTrainingRoutes: false, providerSessionLifetime: testProviderSessionLifetime() };
    const plan = providers.selection.plan("gpt-6-luna", connection, TEST_ELIGIBILITY);

    const ordinary = await createClient("gpt-5.5", testModelsClient(), { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "api-key" } }),}, { ...options, authDir: connection.authDir, profileId: "default" });
    const admitted = await createAdmittedClient(plan, testModelsClient(), connection, options);
    await ordinary.plannedAttempt();
    await expect(admitted.plannedAttempt()).rejects.toThrow("allowance cannot be verified");

    expect(bound).toEqual(["default", "default", "default", "default"]);
  });

  test("awaits one secret-free pooled admission before constructing the request chain", async () => {
    const providers = testProviderRegistry();
    const connection = captureProviderConnection({
      profileId: "default",
      auth: { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "raw-secret" } }),},
      authDir: CLIENT_DIRECTORIES.authDir,
      subscriptionCredentials: new Map(),
      oauthPersistence: "memory-only",
    });
    const plan = providers.selection.plan("gpt-5.5", connection, TEST_ELIGIBILITY);
    let checks = 0;
    let admitted = false;
    const seen: unknown[] = [];
    const owner = {
      forCandidates: (_profileId: string, _candidates: unknown, resolver?: unknown) => {
        if (resolver !== undefined) expect(admitted).toBeTrue();
        return fakeAvailability({}).availability;
      },
      dispose: () => Promise.resolve(),
    };
    const client = await createAdmittedClient(plan, testModelsClient(), connection, {
      notify: () => {},
      providerSessionLifetime: testProviderSessionLifetime(),
      projectRoot: CLIENT_DIRECTORIES.projectRoot,
      providers,
      eligibility: TEST_ELIGIBILITY,
      availability: owner,
      allowTrainingRoutes: false,
      requestAdmission: async () => {
        checks += 1;
        await Promise.resolve();
        admitted = true;
        const subscriptionAllowanceFor = () => Object.freeze({ freshness: "fresh", allowance: "pooled", usedCredits: 40 } as const);
        seen.push(subscriptionAllowanceFor());
        return Object.freeze({
          subscriptionSpendAuthorizationFor: () => undefined,
          subscriptionAllowanceFor,
        });
      },
    });

    await client.plannedAttempt();

    expect(checks).toBe(1);
    expect(seen).toEqual([{ freshness: "fresh", allowance: "pooled", usedCredits: 40 }]);
    expect(JSON.stringify(seen)).not.toMatch(/raw-secret|default|openai|github|organization|provider/i);
  });

  test("keeps staged attempt attribution distinct across spend modes of the same account", async () => {
    const base = testProviderRegistry();
    const gate = Promise.withResolvers<void>();
    let builds = 0;
    const providers = {
      ...base,
      factories: new Map(base.factories).set("github_copilot", async ({ candidate, model, family }) => {
        builds += 1;
        await gate.promise;
        const client = { historyTarget: ownHistoryTarget,
          accessProvider: "github_copilot",
          accessProviderCandidate: candidate,
          model,
          modelFamily: family,
          toolPresentation: FUNCTION_TOOL_PRESENTATION,
          contextLimit: 1_000,
          outputLimit: 100,
          supportsReasoning: false,
          promptNotes: { progress: "", modelNotes: "" },
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
          async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } as const; },
        };
        return { attempt: client, connect: async () => client };
      }),
    };
    const connection = captureProviderConnection({
      profileId: "default",
      auth: { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, oauth: ["github_copilot"] }),},
      authDir: CLIENT_DIRECTORIES.authDir,
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "copilot-a", identity: "subject", credential: { type: "oauth", access: Redacted.make("copilot"), expires: 1 } }]]]),
    });
    let mode = "included";
    const eligibility = () => ({
      modelUnavailableReason: () => undefined,
      candidateModelUnavailableReason: (candidate: { spendMode: string }) => candidate.spendMode === mode ? undefined : "other mode",
      candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({ candidate, wireModelId: model, dataUse: "standard" as const, resolvedModelMetadata: fakeModelsClient.modelInfos.get(model) }),
    });
    const plan = providers.selection.plan("gpt-6-luna", connection, TEST_ELIGIBILITY);
    const account = createSubscriptionAccountIdentity("github_copilot", "copilot-a", "subject");
    const envelope = createSubscriptionSpendEnvelope("default", account, "automatic");
    const client = await createAdmittedClient(plan, testModelsClient(), connection, {
      notify: () => {},
      providerSessionLifetime: testProviderSessionLifetime(),
      providers,
      projectRoot: CLIENT_DIRECTORIES.projectRoot,
      allowTrainingRoutes: false,
      getProviderModelEligibility: eligibility,
      requestAdmission: async () => ({
        subscriptionSpendAuthorizationFor: (candidate) => candidate.spendMode === "automatic" ? { envelope, profileId: "default", account, usageGeneration: 1, authorityIncarnation: "test", authorityRevision: 1 } : undefined,
        subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      }),
    });
    const included = await client.admitRequest();
    mode = "automatic";
    const paid = await client.admitRequest();
    const attempts = Promise.all([included.plannedAttempt(), paid.plannedAttempt()]);
    await Promise.resolve();
    expect(builds).toBe(2);
    gate.resolve();
    const [includedAttempt, paidAttempt] = await attempts;
    expect(includedAttempt.accessProviderCandidate?.spendMode).toBe("included");
    expect(paidAttempt.accessProviderCandidate?.spendMode).toBe("automatic");
    expect(await paid.run({
      prepare: preparedRequest,
      execute: async ({ attempt }) => ({ kind: "success", value: attempt.accessProviderCandidate?.spendMode }),
    })).toBe("automatic");
  });

  test("a client hands every refusal its requests proved to the owner with the exact connection, candidate, and wire model, and each build reads its account's offerings from the request's eligibility", async () => {
    const base = testProviderRegistry();
    const builds: AccessProviderBuild[] = [];
    const records: ModelRefusalRecord[] = [];
    const providers = {
      ...base,
      factories: new Map(base.factories).set("openai_api", async (build) => {
        builds.push(build);
        return base.factories.get("openai_api")!(build);
      }),
    };
    const client = await createClient("gpt-5.5", testModelsClient(), {
      ...noKeysAuth,
      providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "key" } }),
    }, {
      ...CLIENT_DIRECTORIES, providers, recordModelRefusal: (record) => { records.push(record); },
      eligibility: { ...TEST_ELIGIBILITY, modelIds: new Set(["gpt-5.5", "gpt-5.4"]), candidateOfferings: (candidate: AccessProviderCandidate, model: string) => [TEST_ELIGIBILITY.candidateOffering(candidate, model)] },
    });
    const request = await client.admitRequest();
    const refusal = { kind: "extended-context", contextLimit: 200_000 } as const;
    const failure = normalizeProviderAttemptFailure(new ModelAccessRefusedError("refused", refusal)).failure;
    if (!isFailoverFailure(failure)) throw new Error("expected a failover failure");
    // The walk records a refusal that reached it; the adapter records one that it answered itself.
    await expect(request.run({ prepare: preparedRequest, execute: async () => ({ kind: "provider_failure", failure }) })).rejects.toThrow();
    builds[0]!.recordModelRefusal("gpt-5.4", { kind: "model" });
    expect(records.map(({ candidate, wireModelId, refusal: refused }) => ({ providerId: candidate.providerId, wireModelId, refused }))).toEqual([
      { providerId: "openai_api", wireModelId: "gpt-5.5", refused: refusal },
      { providerId: "openai_api", wireModelId: "gpt-5.4", refused: { kind: "model" } },
    ]);
    expect(builds[0]!.accountOfferings().map(({ candidate, wireModelId }) => ({ candidate, wireModelId }))).toEqual([
      { candidate: builds[0]!.candidate, wireModelId: "gpt-5.5" },
      { candidate: builds[0]!.candidate, wireModelId: "gpt-5.4" },
    ]);
    expect(records.every(({ connection }) => connection.profileId === "default")).toBe(true);
  });

  test("evicts a rejected adapter promise before reconstructing it", async () => {
    const base = testProviderRegistry();
    let builds = 0;
    const providers = {
      ...base,
      factories: new Map(base.factories).set("openai_api", async (build) => {
        builds += 1;
        if (builds === 1) throw new Error("adapter failed");
        return base.factories.get("openai_api")!(build);
      }),
    };
    const client = await createClient("gpt-5.5", testModelsClient(), { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "key" } }),}, { ...CLIENT_DIRECTORIES, providers });
    await expect(client.plannedAttempt()).rejects.toThrow("adapter failed");
    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api");
    expect(builds).toBe(2);
  });

  test("a staged client whose connection failed connects again on its next request, and shares concurrent and successful connections", async () => {
    const base = testProviderRegistry();
    let connections = 0;
    const providers = {
      ...base,
      factories: new Map(base.factories).set("openai_api", async (build) => {
        const staged = await base.factories.get("openai_api")!(build);
        return stagedProviderClient(build, staged.attempt, async () => {
          connections += 1;
          if (connections === 1) throw new Error("engine directory unsafe");
          return await staged.connect();
        });
      }),
    };
    const client = await createClient("gpt-5.5", testModelsClient(), { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { openai_api: "key" } }) }, { ...CLIENT_DIRECTORIES, providers });
    const serve = async () => await (await client.admitRequest()).run({ prepare: preparedRequest, execute: async ({ attempt }) => ({ kind: "success", value: attempt.accessProvider }) });
    await expect(serve()).rejects.toThrow("engine directory unsafe");
    expect(await Promise.all([serve(), serve()])).toEqual(["openai_api", "openai_api"]);
    expect(await serve()).toBe("openai_api");
    expect(connections).toBe(2);
  });
});

describe("createAgentRuntime connection forwarding", () => {
  const temporaryDirectory = temporaryDirectories();

  test.each([false, true])("owns ChatGPT state through ordinary and admitted construction (captured: %s)", async (captured) => {
    const directory = join(temporaryDirectory("provider-lifetime-"), ".flywheel", "auth");
    const auth = { ...noKeysAuth, providers: authProviders({ oauth: ["chatgpt"] }) };
    await Bun.write(join(directory, "auth.json"), JSON.stringify({
      chatgpt: [{ id: "chatgpt-a", identity: "test-account", lineageId: "11111111-1111-4111-8111-111111111111", credential: { type: "oauth", access: "test-token", refresh: "test-refresh", expires: Date.now() + 3_600_000, accountId: "test-account" } }],
    }));
    const providers = testProviderRegistry();
    const connection = captureAccountConnection(auth, directory, providers, "default");
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default", getAuth: () => auth, definitions: repoDefinitions(),
      moduleSelection: testCapabilityModules(), captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => directory, connection: captured ? connection : undefined,
      getProviderModelEligibility: () => TEST_ELIGIBILITY,
      userDataRoot: DIRECTORIES.userDataRoot, modelsClient: testModelsClient(),
    });
    const scope = Scope.makeUnsafe("sequential");
    const reviewScope = Scope.makeUnsafe("sequential");
    const providerSessionKey = `factory-lifetime-${captured}`;
    try {
      const client = await runtime.createLLMClient("gpt-5.5", undefined, undefined, { providerSessionKey, scope });
      const capture = await runtime.captureProviderConnection();
      const plan = capture.providers.selection.plan("gpt-5.5", capture.connection, TEST_ELIGIBILITY);
      const review = await capture.admit(new Map([["gpt-5.5", plan]])).createLLMClient("gpt-5.5", undefined, undefined, { providerSessionKey, scope: reviewScope });
      for (const owned of [client, review]) {
        expect((await owned.plannedAttempt()).accessProvider).toBe("chatgpt");
        expect((await owned.plannedAttempt()).accessProvider).toBe("chatgpt");
      }
      recordWebSocketFailure(providerSessionKey);
      await Effect.runPromise(Scope.close(reviewScope, Exit.void));
      expect(isWebSocketSseFallbackActive(providerSessionKey)).toBe(true);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(isWebSocketSseFallbackActive(providerSessionKey)).toBe(false);
    } finally {
      await Effect.runPromise(Scope.close(reviewScope, Exit.void));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      recordWebSocketSuccess(providerSessionKey);
    }
  });

  test.each([false, true])("hands the generation's launch authority to the provider build (captured: %s)", async (captured) => {
    const launcher: LauncherScope = {
      spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
      adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
      open: () => launcher,
      close: async () => ({ settled: true }),
    };
    const builds: AccessProviderBuild[] = [];
    const recording: typeof anthropicApiModule = {
      ...anthropicApiModule,
      contributions: [
        { ...anthropicApiModule.contributions[0], value: { ...anthropicApiModule.contributions[0].value, createClient: (build) => { builds.push(build); return anthropicApiModule.contributions[0].value.createClient(build); } } },
        anthropicApiModule.contributions[1],
      ],
    };
    const modules = composeFirstPartyModules(installedModules().map((module) => module.id === recording.id ? recording : module));
    const auth = { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { anthropic_api: "[redacted secret]" } }) };
    const connection = captureAccountConnection(auth, CLIENT_DIRECTORIES.authDir, accessProviderRegistry(modules), "default");
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default", getAuth: () => auth, definitions: repoDefinitions(),
      moduleSelection: modules, captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => CLIENT_DIRECTORIES.authDir, connection: captured ? connection : undefined,
      getProviderModelEligibility: () => TEST_ELIGIBILITY,
      userDataRoot: DIRECTORIES.userDataRoot, modelsClient: testModelsClient(), launcher,
    });

    await (await runtime.createLLMClient("claude-sonnet-4-6", undefined, undefined, testProviderSessionLifetime())).plannedAttempt();
    const capture = await runtime.captureProviderConnection();
    const plan = capture.providers.selection.plan("claude-sonnet-4-6", capture.connection, TEST_ELIGIBILITY);
    await (await capture.admit(new Map([["claude-sonnet-4-6", plan]])).createLLMClient("claude-sonnet-4-6", undefined, undefined, testProviderSessionLifetime())).plannedAttempt();

    expect(builds.map((build) => build.launcher)).toEqual([launcher, launcher]);
  });

  test("a retained client recaptures revoked paid consent before provider I/O", async () => {
    const auth = { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, oauth: ["github_copilot"] }),};
    const connection = captureProviderConnection({
      profileId: "default",
      auth,
      authDir: CLIENT_DIRECTORIES.authDir,
      subscriptionCredentials: new Map([["github_copilot", [{
        instanceId: "copilot-a",
        identity: "replacement-subject",
        credential: { type: "oauth", access: Redacted.make("copilot-token"), refresh: Redacted.make("github-token"), expires: 1 },
      }]]]),
      oauthPersistence: "memory-only",
    });
    const account = createSubscriptionAccountIdentity("github_copilot", "copilot-a", "replacement-subject");
    const envelope = createSubscriptionSpendEnvelope("default", account, "automatic");
    let consentAccepted = true;
    let consentCaptures = 0;
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default",
      getAuth: () => auth,
      definitions: repoDefinitions(),
      moduleSelection: testCapabilityModules(),
      captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => CLIENT_DIRECTORIES.authDir,
      getProviderModelEligibility: () => ({
        modelUnavailableReason: () => undefined,
        candidateModelUnavailableReason: (candidate) => candidate.spendMode === "automatic" ? undefined : "test selects automatic billing",
        candidateOffering: (candidate, model) => ({
          candidate,
          wireModelId: model,
          dataUse: "standard",
          catalogMetadata: { supportedEndpoints: ["/responses"] },
          resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
        }),
      }),
      connection,
      userDataRoot: DIRECTORIES.userDataRoot,
      modelsClient: testModelsClient(),
      captureSubscriptionAdmission: async () => {
        consentCaptures += 1;
        return {
          subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
          bankedResetFor: () => false,
          expiringResetFor: () => undefined,
          consent: {
            profileId: "default",
            usageGeneration: consentCaptures,
            authorityIncarnation: "incarnation-a",
            authorityRevision: consentCaptures,
            rows: [{ envelope, status: consentAccepted ? "accepted" : "declined" }],
            authorizations: consentAccepted ? new Map([[envelope.id, {
              envelope,
              profileId: "default",
              account,
              authorityIncarnation: "incarnation-a",
              authorityRevision: consentCaptures,
            }]]) : new Map(),
          },
        };
      },
    });

    const directClient = await runtime.createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime());
    const capture = await runtime.captureProviderConnection();
    const plan = capture.providers.selection.plan("gpt-6-luna", capture.connection, capture.eligibility);
    const admittedClient = await capture.admit(new Map([["gpt-6-luna", plan]])).createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime());
    const providerDispatches = { count: 0 };
    for (const client of [directClient, admittedClient]) {
      consentAccepted = true;
      expect((await client.plannedAttempt()).accessProvider).toBe("github_copilot");
      consentAccepted = false;
      let caught: unknown;
      try {
        await requestEvents(client, {
          messages: [{ kind: "user", content: "hi" }],
          tools: [],
          systemPrompt: stableSystemPrompt(""),
          onDispatch: () => { providerDispatches.count += 1; },
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof Error)) throw new Error("expected missing consent error");
      expect(caught.message).toContain("requires review");
    }
    expect(providerDispatches.count).toBe(0);
    expect(consentCaptures).toBe(4);
  });

  test("runs an admitted agent on its caller's module selection", async () => {
    // A provider build that refuses keeps the run off the network; the module
    // selection is read before the request is built. The definition owner names
    // the test project, never the checkout: a finished run sweeps its owner's
    // project root for aged breadcrumbs, and in a developer's checkout that walk
    // reads thousands of session trees and deletes their old files.
    const refusing = { ...anthropicApiModule, contributions: [{ ...anthropicApiModule.contributions[0], value: { ...anthropicApiModule.contributions[0].value, createClient: () => { throw new Error("no provider in a unit test"); } } }, anthropicApiModule.contributions[1]] } satisfies typeof anthropicApiModule;
    const installed = installedModules().map((module) => module.id === refusing.id ? refusing : module);
    const auth = { ...noKeysAuth, providers: authProviders({ base: noKeysAuth.providers, apiKeys: { anthropic_api: "[redacted secret]" } }) };
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default", getAuth: () => auth, definitions: fixedDefinitions({ projectRoot: DIRECTORIES.projectRoot }), moduleSelection: composeFirstPartyModules(installed), captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => CLIENT_DIRECTORIES.authDir, getProviderModelEligibility: () => TEST_ELIGIBILITY, userDataRoot: DIRECTORIES.userDataRoot, modelsClient: testModelsClient(),
    });
    const capture = await runtime.captureProviderConnection();
    const plan = capture.providers.selection.plan("claude-sonnet-4-6", capture.connection, TEST_ELIGIBILITY);
    let selections = 0;
    const agent = capture.admit(new Map([["claude-sonnet-4-6", plan]])).createAgent({
      model: "claude-sonnet-4-6", effort: "low", purpose: { kind: "chat-routing-benchmark" }, onEvent: () => {},
      executionCwd: DIRECTORIES.projectRoot, projectRoot: DIRECTORIES.projectRoot, userDataRoot: DIRECTORIES.userDataRoot, accountHome: DIRECTORIES.accountHome,
      moduleSelection: () => { selections += 1; return composeFirstPartyModules(installed, ["subagents"]); },
      runtimeSurfaces: {}, toolProfile: "none", conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
    });
    agent.send("route");
    await agent.done.catch(() => undefined);
    expect(selections).toBeGreaterThan(0);
  });
});

describe("createClient missing-key auth failures are typed runtime errors", () => {
  test("a model with no configured provider surfaces a typed model_unavailable failure, not an opaque defect", async () => {
    // The mid-session model-switch / subagent-tiering scenario: a model whose
    // family has no configured access provider. The runner's Effect boundary
    // keys recoverable failures off isAgentRuntimeError; a bare Error would
    // become an unrecoverable defect (Effect.die) instead.
    let caught: unknown;
    try {
      await createClient("gpt-5.5", testModelsClient(), noKeysAuth, CLIENT_DIRECTORIES);
      throw new Error("createClient resolved instead of rejecting");
    } catch (err) {
      caught = err;
    }
    expect(isAgentRuntimeError(caught)).toBe(true);
    if (!isAgentRuntimeError(caught)) throw new Error("expected agent runtime error");
    // A catalog miss calls no provider, so it never reads as a provider api_error.
    const failure = toFailureReason(caught);
    expect(failure.kind).toBe("model_unavailable");
    expect(failure).toMatchObject({ message: expect.stringContaining("No captured provider catalog"), missing: "provider" });
  });
});
