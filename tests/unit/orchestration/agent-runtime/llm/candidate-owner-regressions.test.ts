import { expect, test } from "bun:test";
import { Redacted } from "effect";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { createSubscriptionSpendEnvelope } from "../../../../../src/infra/auth/subscription-spend-consent.js";
import { createSubscriptionAccountIdentity } from "../../../../../src/infra/llm/subscription-account-identity.js";
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js";
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js";
import { authDir } from "../../../../../src/infra/paths.js";
import { AllCandidatesExhaustedError, LlmStreamError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import type { ProviderAvailability, QuotaStanding } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { chain, failoverFailure, fakeAvailability, fakeClient, preparedRequest, singletonCandidate, subscriptionCandidate, textStream } from "./_provider-chain-harness.js";
import { harness } from "./_provider-availability-harness.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { testCapabilityModules, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import { authProviders } from "../../../../helpers/auth-context.js";

// An outage the adapter inferred without wire evidence: it advances the walk and records nothing durable.
const failure = () => ({ kind: "provider_failure" as const, failure: failoverFailure(new LlmStreamError("stream closed before response.completed", "transient")) });
const pending: QuotaStanding = { kind: "recheck_pending", revision: 7, untilMs: 30_000 };

test("pending head survives a later failure and each exact candidate is selected once", async () => {
  let ready = false;
  let waits = 0;
  const base = fakeAvailability({});
  const availability: ProviderAvailability = {
    ...base.availability,
    chatGptStanding: () => ready ? { kind: "live" } : pending,
    waitForChange: async (value) => { expect(value).toEqual(pending); waits += 1; ready = true; },
  };
  const seen: string[] = [];
  const request = await chain({ availability }).admitRequest();
  const result = await request.run({ prepare: preparedRequest, execute: async ({ attempt }) => {
    seen.push(attempt.accessProvider);
    return attempt.accessProvider === "openai_api" ? failure() : { kind: "success", value: "done" };
  } });
  expect(result).toBe("done");
  // The failed head spends its in-place retries before the pending
  // candidate is waited on; it is never selected a second time.
  expect(seen).toEqual(["openai_api", "openai_api", "openai_api", "openai_api", "chatgpt"]);
  expect(waits).toBe(1);
  expect(base.genericEntryCount()).toBe(0);
  expect(base.serviceEntryCount()).toBe(0);
});

test("duplicate exact candidates cannot repeat once the candidate's retries are spent", async () => {
  const candidate = singletonCandidate("openai_api");
  let attempts = 0;
  const request = await chain({ availability: fakeAvailability({}).availability, candidates: [candidate, candidate] }).admitRequest();
  await expect(request.run({ prepare: preparedRequest, execute: async () => { attempts += 1; return failure(); } })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
  expect(attempts).toBe(4);
});

test("suppressed unpaid candidates never build in planning or execution", async () => {
  const availability = fakeAvailability({}).availability;
  availability.markUnreachable("chatgpt");
  let builds = 0;
  const candidate: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "a", spendMode: "automatic" };
  const client = chain({ availability, candidates: [candidate], build: async (provider) => { builds += 1; return fakeClient(provider, textStream(provider)); } });
  await expect(client.plannedAttempt()).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
  await expect((await client.admitRequest()).run({ prepare: preparedRequest, execute: async () => ({ kind: "success", value: 1 }) })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
  expect(builds).toBe(0);
});

test("planning chooses ready paid fallback after pending or suppressed included capacity", async () => {
  for (const standing of [pending, { kind: "suppressed", exhaustion: { exhaustedAtMs: 0, resetsAtMs: 30_000 } } satisfies QuotaStanding]) {
    let claims = 0;
    let waits = 0;
    const availability: ProviderAvailability = {
      ...fakeAvailability({}).availability,
      serviceStanding: (provider) => provider === "chatgpt" ? standing : { kind: "live" },
      claimServiceProbe: () => { claims += 1; return undefined; },
      waitForChange: async () => { waits += 1; },
    };
    expect((await chain({ availability }).plannedAttempt()).accessProvider).toBe("openai_api");
    expect(claims).toBe(0);
    expect(waits).toBe(0);
  }
});

test("settled quota publishes through the real owner for only the exact account mode", async () => {
  const included = subscriptionCandidate("chatgpt", "a");
  const other = subscriptionCandidate("chatgpt", "b");
  const paid: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "a", spendMode: "automatic" };
  const state = harness([], undefined, [included, other, paid]);
  try {
    const request = await chain({ availability: state.availability, candidates: [included] }).admitRequest();
    await expect(request.run({ prepare: preparedRequest, execute: async () => {
      expect(state.availability.chatGptStanding(included).kind).toBe("live");
      return { kind: "provider_failure", failure: failoverFailure(new QuotaExhaustedError()) };
    } })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(state.availability.chatGptStanding(included).kind).toBe("suppressed");
    expect(state.availability.chatGptStanding(other).kind).toBe("live");
    expect(state.availability.chatGptStanding(paid).kind).toBe("live");
  } finally { await state.owner.dispose(); }
});

test("an already recorded quota observation is not counted again", async () => {
  const base = fakeAvailability({}).availability;
  const candidate = subscriptionCandidate("chatgpt");
  const observation = base.observeChatGptQuotaExhausted(candidate, undefined);
  let publishes = 0;
  const request = await chain({ availability: { ...base, chatGptStanding: () => ({ kind: "live" }), observeChatGptQuotaExhausted: () => { publishes += 1; return observation; }, markQuotaExhausted: () => { publishes += 1; return observation; } }, candidates: [candidate] }).admitRequest();
  await expect(request.run({ prepare: preparedRequest, execute: async () => ({ kind: "provider_failure", failure: failoverFailure(new QuotaExhaustedError("spent", { quotaObservation: observation })) }) })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
  expect(publishes).toBe(0);
});

test("generic terminal quota is published for the next request", async () => {
  const candidate = singletonCandidate("openai_api");
  const state = harness([], undefined, [candidate]);
  try {
    const client = chain({ availability: state.availability, candidates: [candidate] });
    await expect((await client.admitRequest()).run({ prepare: preparedRequest, execute: async () => ({ kind: "provider_failure", failure: failoverFailure(new QuotaExhaustedError()) }) })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(state.availability.genericQuotaStanding(candidate).kind).toBe("suppressed");
    await expect(client.plannedAttempt()).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
  } finally { await state.owner.dispose(); }
});

test("local lazy construction failure releases probes and stops before another build", async () => {
  const base = fakeAvailability({});
  const defect = new TypeError("local construction defect");
  const builds: string[] = [];
  const availability: ProviderAvailability = { ...base.availability, genericQuotaStanding: () => ({ kind: "probe_due" }) };
  const client = chain({ availability, candidates: ["openai_api", "openrouter"], build: async (provider) => { builds.push(provider); throw defect; } });
  await expect((await client.admitRequest()).run({ prepare: preparedRequest, execute: async () => ({ kind: "success", value: 1 }) })).rejects.toBe(defect);
  expect(builds).toEqual(["openai_api"]);
  expect(base.probeReleases).toEqual(["openai_api"]);
});

test("runtime admission uses captured paid permission with the captured training policy", async () => {
  const directories = testDirectories("/scratch");
  const directory = authDir(directories.userDataRoot, "default");
  const auth = { providers: authProviders({ oauth: ["github_copilot"] }), credentialLineages: {}, droppedCredentials: [] };
  const connection = captureProviderConnection({ profileId: "default", auth, authDir: directory,
    subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "a", identity: "subject", credential: { type: "oauth", access: Redacted.make("test-token"), refresh: Redacted.make("test-refresh"), expires: 1 } }]]]),
    oauthPersistence: "memory-only" });
  const account = createSubscriptionAccountIdentity("github_copilot", "a", "subject");
  const envelope = createSubscriptionSpendEnvelope("default", account, "automatic");
  const trainingPolicyReads: boolean[] = [];
  const runtimeConfig = Object.freeze({ ...testRuntimeConfigCapture(), allowTrainingRoutes: true });
  const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {}, profileId: "default", getAuth: () => auth, definitions: repoDefinitions(), moduleSelection: testCapabilityModules(), captureRuntimeConfig: () => runtimeConfig,
    authDirectory: () => directory, connection, userDataRoot: directories.userDataRoot, modelsClient: fakeModelsClient,
    getProviderModelEligibility: () => ({ modelUnavailableReason: () => undefined, candidateModelUnavailableReason: (candidate) => candidate.spendMode === "automatic" ? undefined : "automatic only", candidateOffering: (candidate, model, allowTrainingRoutes) => {
      trainingPolicyReads.push(allowTrainingRoutes);
      return allowTrainingRoutes ? {
        candidate,
        wireModelId: `${model}:training`,
        dataUse: "contributor" as const,
        transport: "openai-responses" as const,
        catalogMetadata: { supportedEndpoints: ["/responses"] },
        resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
      } : undefined;
    } }),
    captureSubscriptionAdmission: async () => ({ consent: { profileId: "default", usageGeneration: 1, authorityIncarnation: "test", authorityRevision: 1,
      rows: [{ envelope, status: "accepted" }],
      authorizations: new Map([[envelope.id, { envelope, profileId: "default", account, authorityIncarnation: "test", authorityRevision: 1 }]]) },
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      bankedResetFor: () => false,
      expiringResetFor: () => undefined,
    }),
  });
  const request = await (await runtime.createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime())).admitRequest();
  expect((await request.plannedAttempt()).accessProviderCandidate?.spendMode).toBe("automatic");
  expect(trainingPolicyReads.every(Boolean)).toBe(true);
});
