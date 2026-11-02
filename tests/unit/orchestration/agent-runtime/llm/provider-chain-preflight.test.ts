import { describe, expect, test } from "bun:test";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { Redacted } from "effect";
import type { AuthContext, CapturedSubscriptionCredential, ProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { accessProviderAccountKey, candidateProviderId, createAccessProviderSelection, type AccessProviderCandidate, type AdmittedFailoverPlan, type FailoverPlan } from "../../../../../src/infra/llm/access-provider.js";
import { authDir } from "../../../../../src/infra/paths.js";
import { createAdmittedClient } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { workerProviderModelEligibilityFromState } from "../../../../../src/orchestration/config/provider-model-eligibility.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { fakeAvailability } from "./_provider-chain-harness.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";

import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
// The directory authorities a composition root publishes for a run. No case
// here reaches the developer's own account state.
const DIRECTORIES = testDirectories("/scratch");
const CREDENTIALS = authDir(DIRECTORIES.userDataRoot, "default");
const testModelsClient = () => fakeModelsClient;
const PROVIDERS = accessProviderRegistry(composeFirstPartyModules());

const NO_KEYS: AuthContext = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
};

const SECRET = Redacted.make("[redacted secret]");

const OAUTH_TOKENS = { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: Date.now() + 3_600_000 } as const;

function connect(
  auth: Partial<AuthContext>,
  captured: { authDir?: string; oauth?: Readonly<{ [providerId: string]: typeof OAUTH_TOKENS | undefined }>; external?: Readonly<{ [providerId: string]: string }> } = {},
): ProviderConnection & { readonly profileId: string } {
  const resolvedAuth = { ...NO_KEYS, ...auth };
  return captureProviderConnection({
    profileId: "default",
    authDir: captured.authDir ?? CREDENTIALS,
    auth: resolvedAuth,
    subscriptionCredentials: new Map<string, readonly CapturedSubscriptionCredential[]>([
      ...Object.entries(captured.oauth ?? {}).flatMap(([providerId, credential]) => credential === undefined ? [] : [[providerId, [{ instanceId: "test-instance", credential }]] as const]),
      ...Object.entries(captured.external ?? {}).map(([providerId, configDir]) => [providerId, [{ instanceId: "test-account", credential: { type: "external" as const, configDir } }]] as const),
      ...(resolvedAuth.providers.get("opencode_go")?.kind === "api_key" ? [["opencode_go", [{ instanceId: "test-instance", credential: { type: "api_key" as const, key: Redacted.make("test-key") } }]] as const] : []),
    ]),
  });
}

function admitted(plan: FailoverPlan): AdmittedFailoverPlan {
  if (plan.kind !== "admitted") throw new Error(`expected an admitted plan: ${plan.reason}`);
  return plan;
}

interface ExactEligibilityRoutes {
  readonly [providerId: string]: {
    readonly transport: "anthropic-messages" | "openai-responses" | "openai-completions" | "google";
    readonly wireModelId?: string;
  };
}

function exactEligibility(
  routes: ExactEligibilityRoutes,
) {
  return {
    modelUnavailableReason: () => undefined,
    candidateOffering: (candidate: AccessProviderCandidate, model: string) => {
      const route = routes[candidate.providerId];
      return route === undefined ? undefined : {
        candidate,
        wireModelId: route.wireModelId ?? model,
        dataUse: "standard" as const,
        transport: route.transport,
        resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
      };
    },
  };
}

/** Provider selection for one planned attempt, over scripted account state, so
 *  no case reads the machine's own quota rows. */
function chainOptions(eligibility?: ReturnType<typeof exactEligibility>) {
  const { availability } = fakeAvailability({});
  return { notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(), providers: PROVIDERS, eligibility, projectRoot: DIRECTORIES.projectRoot, allowTrainingRoutes: false, requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }), availability: { forCandidates: () => availability, dispose: () => Promise.resolve() } };
}

// Derived from the composed registry so a newly registered provider fails here
// until its relative auto-routing priority (billing + rank) is deliberately placed.
test("every installed provider declares its place in the auto-routing order", () => {
  const routingOrder = [...PROVIDERS.selection.definitions]
    .sort((a, b) => Number(a.billing === "metered") - Number(b.billing === "metered") || a.rank - b.rank)
    .map(({ id, billing, rank }) => ({ id, billing, rank }));
  expect(routingOrder).toEqual([
    { id: "claude_agent_sdk", billing: "subscription", rank: 0 },
    { id: "chatgpt", billing: "subscription", rank: 10 },
    { id: "github_copilot", billing: "subscription", rank: 20 },
    { id: "opencode_go", billing: "subscription", rank: 30 },
    { id: "supergrok", billing: "subscription", rank: 40 },
    { id: "anthropic_api", billing: "metered", rank: 50 },
    { id: "openai_api", billing: "metered", rank: 60 },
    { id: "google_api", billing: "metered", rank: 70 },
    { id: "google_vertex", billing: "metered", rank: 75 },
    { id: "deepseek", billing: "metered", rank: 78 },
    { id: "openrouter", billing: "metered", rank: 80 },
  ]);
});

describe("provider chain preflight", () => {
  test("serves Claude first through the Agent SDK provider, then the other subscriptions, without bypassing eligibility or spend classes", () => {
    const model = "claude-sonnet-4-6";
    const connection = connect(
      { providers: authProviders({ apiKeys: { anthropic_api: SECRET, openrouter: SECRET }, oauth: ["github_copilot"] }) },
      { oauth: { github_copilot: OAUTH_TOKENS }, external: { claude_agent_sdk: `/home/person/.flywheel/auth/profiles/default/${LOGIN_ACCOUNTS_DIRECTORY}/a` } },
    );
    const eligibility = exactEligibility({
      claude_agent_sdk: { transport: "anthropic-messages" },
      github_copilot: { transport: "anthropic-messages" },
      anthropic_api: { transport: "anthropic-messages" },
      openrouter: { transport: "openai-completions" },
    });
    const routes = admitted(PROVIDERS.selection.plan(model, connection, eligibility)).candidates;
    expect(routes.slice(0, 2).map(({ providerId, spendMode }) => ({ providerId, spendMode }))).toEqual([
      { providerId: "claude_agent_sdk", spendMode: "included" },
      { providerId: "github_copilot", spendMode: "included" },
    ]);
    expect(routes.findIndex(({ providerId, spendMode }) => providerId === "claude_agent_sdk" && spendMode === "automatic")).toBeGreaterThan(1);
    const unavailable = { ...eligibility, candidateModelUnavailableReason: (candidate: AccessProviderCandidate) => candidate.providerId === "claude_agent_sdk" ? "Account is unavailable for this model" : undefined };
    expect(admitted(PROVIDERS.selection.plan(model, connection, unavailable)).candidates[0]?.providerId).toBe("github_copilot");
  });

  test("names what an unavailable plan lacks: any provider, or a provider that offers the model", () => {
    const refusing = { modelUnavailableReason: () => "not offered", candidateOffering: () => undefined };
    expect(PROVIDERS.selection.plan("claude-sonnet-4-6", connect({}), refusing)).toMatchObject({ kind: "unavailable", missing: "provider" });
    expect(PROVIDERS.selection.plan("claude-sonnet-4-6", connect({ providers: authProviders({ apiKeys: { anthropic_api: SECRET } }) }), refusing)).toMatchObject({ kind: "unavailable", missing: "offering" });
  });

  test("names a pending access check when no account can serve yet because its model access is still being checked", async () => {
    const supergrok = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const;
    const connection = captureProviderConnection({
      profileId: "default",
      authDir: CREDENTIALS,
      auth: NO_KEYS,
      subscriptionCredentials: new Map([["supergrok", [{ instanceId: "primary", credential: OAUTH_TOKENS }]]]),
    });
    const pending = workerProviderModelEligibilityFromState({
      catalogs: new Map(),
      enabledCandidates: new Map([[accessProviderAccountKey(supergrok), { candidate: supergrok, configured: true, currentConnection: true, enabledOfferings: null, catalog: { kind: "unavailable", reason: "discovery-pending" } }]]),
    });
    // A role that materialized before any model was verified still names its tier.
    for (const model of ["grok-4", "powerful"]) {
      const plan = PROVIDERS.selection.plan(model, connection, pending);
      expect(plan).toMatchObject({ kind: "unavailable", missing: "access" });
      expect(await createAdmittedClient(plan, testModelsClient(), connection, chainOptions()).catch((error: unknown) => error)).toMatchObject({ _tag: "ModelUnavailable", missing: "access" });
    }
  });

  test("dispatches an unknown first-party id through the provider default transport", () => {
    const model = "future-first-party-model";
    const connection = connect({ providers: authProviders({ apiKeys: { openai_api: SECRET } }) });
    const eligibility = {
      modelUnavailableReason: () => undefined,
      candidateOffering: (candidate: AccessProviderCandidate) =>
        candidate.providerId === "openai_api"
          ? { candidate, wireModelId: model, dataUse: "standard" as const }
          : undefined,
    };

    const plan = admitted(PROVIDERS.selection.plan(model, connection, eligibility));
    expect(plan.family).toBe("openai");
    expect(plan.candidateAttributions).toEqual([
      expect.objectContaining({ wireModelId: model, transport: "openai-responses" }),
    ]);
  });

  test.each([true, false])("plans only supported spend modes by class, rank, and account order (paid modes %s)", (paid) => {
    const connection = connect(
      { providers: authProviders({ apiKeys: { openai_api: SECRET, openrouter: SECRET }, oauth: ["chatgpt", "github_copilot"] }),},
      { oauth: { chatgpt: OAUTH_TOKENS, github_copilot: OAUTH_TOKENS } },
    );
    const definitions = paid ? PROVIDERS.selection.definitions : PROVIDERS.selection.definitions.map((definition) => definition.id === "chatgpt" && definition.billing === "subscription" ? { ...definition, paidModes: [] } : definition);
    const plan = admitted(createAccessProviderSelection(definitions).plan("gpt-5.4", connection, exactEligibility({
      chatgpt: { transport: "openai-responses" },
      github_copilot: { transport: "openai-responses" },
      openai_api: { transport: "openai-responses" },
      openrouter: { transport: "openai-responses" },
    })));
    const chatgptPaid: { providerId: string; spendMode: AccessProviderCandidate["spendMode"] }[] = paid ? [{ providerId: "chatgpt", spendMode: "prepaid" }, { providerId: "chatgpt", spendMode: "automatic" }] : [];
    expect(plan.candidates.map(({ providerId, spendMode }) => ({ providerId, spendMode }))).toEqual([
      { providerId: "chatgpt", spendMode: "included" },
      { providerId: "github_copilot", spendMode: "included" },
      ...chatgptPaid,
      { providerId: "github_copilot", spendMode: "automatic" },
      { providerId: "openai_api", spendMode: "direct_api" },
      { providerId: "openrouter", spendMode: "aggregator" },
    ]);
    expect(plan.family).toBe("openai");
  });

  test("applies the current user eligibility mask after provider serveability", () => {
    const connection = connect(
      { providers: authProviders({ apiKeys: { openai_api: SECRET }, oauth: ["chatgpt"] }),},
      { oauth: { chatgpt: OAUTH_TOKENS } },
    );
    const eligibility = {
      modelUnavailableReason: (provider: string, model: string) =>
        provider === "chatgpt" && model === "gpt-5.4" ? "ChatGPT is disabled for gpt-5.4." : undefined,
      candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({ candidate, wireModelId: model, dataUse: "standard" as const }),
    };

    expect(admitted(PROVIDERS.selection.plan("gpt-5.4", connection, eligibility)).candidates.filter(({ spendMode }) => spendMode === "included" || spendMode === "direct_api" || spendMode === "aggregator").map(candidateProviderId)).toEqual(["openai_api"]);
  });

  test("filters subscription candidates by exact account catalog", () => {
    const connection = captureProviderConnection({
      authDir: CREDENTIALS,
      auth: { ...NO_KEYS, providers: authProviders({ base: NO_KEYS.providers, oauth: ["chatgpt"] }),},
      subscriptionCredentials: new Map([["chatgpt", [
        { instanceId: "account-a", credential: OAUTH_TOKENS },
        { instanceId: "account-b", credential: OAUTH_TOKENS },
      ]]]),
    });
    const eligibility = {
      modelUnavailableReason: () => undefined,
      candidateModelUnavailableReason: (candidate: AccessProviderCandidate, model: string) =>
        candidate.kind === "subscription" && (candidate.instanceId !== "account-a" || model !== "gpt-5.4") ? "not listed" : undefined,
      candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({ candidate, wireModelId: model, dataUse: "standard" as const }),
    };

    expect(admitted(PROVIDERS.selection.plan("gpt-5.4", connection, eligibility)).candidates).toEqual([
      { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "included" },
      { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "prepaid" },
      { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "automatic" },
    ]);
  });

  test("a plan from another connection is refused rather than served on this account", async () => {
    const auth = { providers: authProviders({ apiKeys: { anthropic_api: SECRET } }),};
    const plan = PROVIDERS.selection.plan("claude-sonnet-4-6", connect(auth), exactEligibility({ anthropic_api: { transport: "anthropic-messages" } }));

    await expect(createAdmittedClient(plan, testModelsClient(), connect(auth), chainOptions()))
      .rejects.toThrow("different provider connection");
  });

  test("an admitted plan serves the parent's captured account", async () => {
    const connection = connect({ providers: authProviders({ apiKeys: { anthropic_api: SECRET } }),});
    const eligibility = exactEligibility({ anthropic_api: { transport: "anthropic-messages" } });
    const client = await createAdmittedClient(
      PROVIDERS.selection.plan("claude-sonnet-4-6", connection, eligibility),
      testModelsClient(),
      connection,
      chainOptions(eligibility),
    );
    expect(client.model).toBe("claude-sonnet-4.6");
    expect((await client.plannedAttempt()).accessProvider).toBe("anthropic_api");
  });

  test("an OAuth provider whose tokens are absent from the capture is not a candidate, so the chain falls through", () => {
    const plan = admitted(PROVIDERS.selection.plan("gpt-5.4", connect(
      { providers: authProviders({ apiKeys: { openai_api: SECRET }, oauth: ["chatgpt"] }),},
    ), exactEligibility({ chatgpt: { transport: "openai-responses" }, openai_api: { transport: "openai-responses" } })));
    expect(plan.candidates.filter(({ spendMode }) => spendMode === "included" || spendMode === "direct_api" || spendMode === "aggregator").map(candidateProviderId)).toEqual(["openai_api"]);
  });

});
