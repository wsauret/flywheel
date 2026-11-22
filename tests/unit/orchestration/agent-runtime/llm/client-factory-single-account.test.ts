import { describe, expect, test } from "bun:test";
import { Log } from "../../../../../src/infra/log.js";
import type { DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import type { AccessProviderCandidate, AccessProviderDefinition, ExternalLoginProblem } from "../../../../../src/infra/llm/access-provider.js";
import { createAccessProviderSelection } from "../../../../../src/infra/llm/access-provider.js";
import { createClient, providerAdapter, type AccessProviderFactory } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { QuotaExhaustedError, RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import type { AdmittedModelRequestExecution, ProviderSessionLifetime } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import { testEligibility, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { failoverFailure, fakeAvailability, fakeClient, preparedRequest, textStream } from "./_provider-chain-harness.js";

const SINGLE = "single_plan";
const AUTH_DIR = "/scratch/profile";
const MODEL = "gpt-5.5";

interface Fixture {
  /** The tree account that the provider names for each tree root. */
  readonly trees?: ReadonlyMap<string, string>;
  readonly problems?: readonly ExternalLoginProblem[];
  readonly awaitLogin?: "renewed" | "declined";
  /** An account that offers no route for the model, so the request plans none of its candidates. */
  readonly unplanned?: string;
}

/** A client on a provider whose accounts never rotate, with accounts `a` and `b`, beside the metered `openai_api`
 *  (provider C). Every adapter is a fake, so `staged` lists each account that a request staged. */
function singleAccountClient(fixture: Fixture, lifetime: ProviderSessionLifetime = testProviderSessionLifetime()) {
  const registry = accessProviderRegistry(composeFirstPartyModules());
  const claude = registry.selection.definitions.find((definition) => definition.id === "claude_agent_sdk");
  if (claude === undefined || claude.auth.kind !== "external" || claude.billing !== "subscription") throw new Error("expected the external Claude definition");
  const single: AccessProviderDefinition = {
    ...claude, id: SINGLE, displayName: "Single Plan", shortName: "Single Plan",
    paidModes: [], accountRotation: "never",
    preferredAccount: (root) => fixture.trees?.get(root),
    auth: {
      ...claude.auth,
      problems: () => fixture.problems ?? [],
      awaitLogin: async () => fixture.awaitLogin ?? "declined",
    },
  };
  const definitions = [single, ...registry.selection.definitions.filter((definition) => definition.id === "openai_api")];
  const staged: string[] = [];
  // No quota mark holds an account back, so only the single-account rule can keep account `b` out of a walk.
  const availability = { ...fakeAvailability({}).availability, genericQuotaStanding: () => ({ kind: "live" as const }) };
  const fake: AccessProviderFactory = async (build) => {
    const name = build.candidate.kind === "subscription" ? `${build.candidate.providerId}:${build.candidate.instanceId}` : build.candidate.providerId;
    const client = { ...fakeClient(name, textStream(name)), modelFamily: build.family };
    return providerAdapter(build, (attribution) => { staged.push(name); return { ...client, candidateAttribution: attribution }; }, async () => client, (connected) => connected);
  };
  const external = (instanceId: string) => ({ instanceId, lineageId: instanceId, credential: { type: "external" as const, configDir: `${AUTH_DIR}/${instanceId}` } });
  const auth = { providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }), credentialLineages: { openai_api: "00000000-0000-4000-8000-000000000001" }, droppedCredentials: [] };
  const connection = captureProviderConnection({ profileId: "default", authDir: AUTH_DIR, auth, subscriptionCredentials: new Map([[SINGLE, [external("a"), external("b")]]]) });
  const client = createClient(MODEL, fakeModelsClient, auth, {
    notify: () => {}, providerSessionLifetime: lifetime, authDir: AUTH_DIR, profileId: "default", allowTrainingRoutes: false, connection,
    projectRoot: testDirectories("/scratch").projectRoot,
    availability: { forCandidates: () => availability, dispose: () => Promise.resolve() },
    requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }),
    providers: { ...registry, selection: createAccessProviderSelection(definitions), factories: new Map([[SINGLE, fake], ["openai_api", fake]]) },
    getProviderModelEligibility: () => testEligibility({
      modelIds: new Set([MODEL]),
      candidateOfferings: (candidate: AccessProviderCandidate, model: string) => candidate.kind === "subscription" && candidate.instanceId === fixture.unplanned ? [] : [{
        candidate, wireModelId: model, dataUse: "standard" as const, transport: "openai-responses" as const,
        resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
      }],
    }),
    ...(fixture.awaitLogin === undefined ? {} : { waitForLogin: true as const }),
  });
  return { client, staged };
}

/** Runs one request whose attempt on account `a` settles as `first` and whose every later attempt succeeds. */
async function serve(client: Awaited<ReturnType<typeof singleAccountClient>["client"]>, first?: AdmittedModelRequestExecution<string>): Promise<{ visits: string[]; value: string }> {
  const visits: string[] = [];
  const value = await (await client.admitRequest()).run<string>({
    prepare: preparedRequest,
    execute: async ({ attempt }) => {
      visits.push(attempt.accessProvider);
      return visits.length === 1 && first !== undefined ? first : { kind: "success", value: attempt.accessProvider };
    },
  });
  return { visits, value };
}

function treeLifetime(root: string): ProviderSessionLifetime {
  return { ...testProviderSessionLifetime(), treeRootSessionId: root };
}

const loginRefusal = (() => {
  const failure = normalizeProviderAttemptFailure(Object.assign(new Error("login refused"), { status: 401 })).failure;
  if (failure._tag !== "AuthFailure") throw new Error("expected login refusal");
  return failure;
})();

describe("a provider whose accounts never rotate keeps one account per request (PI-MODEL-094)", () => {
  test.each([
    ["spent quota", new QuotaExhaustedError("quota spent")],
    ["a route that cannot run", new RouteUnavailableError("engine cannot start")],
  ] as const)("a failure for %s moves the request to another provider, never to the provider's other account", async (_name, error) => {
    const { client, staged } = await singleAccountClient({});
    const { visits } = await serve(await client, { kind: "provider_failure", failure: failoverFailure(error) });
    expect(visits).toEqual(["single_plan:a", "openai_api"]);
    expect(staged).toEqual(["single_plan:a", "openai_api"]);
  });

  test("a request of a tree keeps the account that the provider names for that tree, and a request of another tree keeps the first", async () => {
    const trees = new Map([["root-1", "b"]]);
    const child = await singleAccountClient({ trees }, treeLifetime("root-1"));
    expect((await serve(await child.client)).visits).toEqual(["single_plan:b"]);
    expect(child.staged).toEqual(["single_plan:b"]);
    const other = await singleAccountClient({ trees }, treeLifetime("root-2"));
    expect((await serve(await other.client)).visits).toEqual(["single_plan:a"]);
    expect(other.staged).toEqual(["single_plan:a"]);
  });

  test("a tree account whose login the provider refused is not kept, and the kept account's failure moves to another provider", async () => {
    const { client, staged } = await singleAccountClient({
      trees: new Map([["root-1", "b"]]),
      problems: [{ kind: "login-rejected", accountId: "b", message: "Log in again." }],
    }, treeLifetime("root-1"));
    const { visits } = await serve(await client, { kind: "provider_failure", failure: failoverFailure(new QuotaExhaustedError("quota spent")) });
    expect(visits).toEqual(["single_plan:a", "openai_api"]);
    expect(staged).toEqual(["single_plan:a", "openai_api"]);
  });

  test("a tree account that the request cannot plan is passed over with its reason recorded, also when one account remains", async () => {
    const records: DebugLogRecordInput[] = [];
    await Log.init({ level: "DEBUG", forward: (record) => { records.push(record); } });
    try {
      const { client, staged } = await singleAccountClient({
        trees: new Map([["root-1", "b"]]),
        problems: [{ kind: "login-rejected", accountId: "b", message: "Log in again." }],
        unplanned: "b",
      }, treeLifetime("root-1"));
      expect((await serve(await client)).visits).toEqual(["single_plan:a"]);
      expect(staged).toEqual(["single_plan:a"]);
      expect(records.map(({ payload }) => payload).filter((payload) => typeof payload === "object" && payload !== null && "message" in payload && payload.message === "tree account not kept for a single-account provider"))
        .toEqual([expect.objectContaining({ provider: SINGLE, preferred: "b", kept: "a", reason: "login-rejected" })]);
    } finally { await Log.closeGlobal(); }
  });

  test.each(["declined", "renewed"] as const)("a refused login whose new login is %s", async (answer) => {
    const { client } = await singleAccountClient({ awaitLogin: answer });
    const { visits, value } = await serve(await client, { kind: "login_refused", failure: loginRefusal, value: "login error" });
    expect(visits).toEqual(answer === "declined" ? ["single_plan:a", "openai_api"] : ["single_plan:a", "single_plan:a"]);
    expect(value).toBe(answer === "declined" ? "openai_api" : "single_plan:a");
  });
});
