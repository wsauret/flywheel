import { describe, expect, test } from "bun:test";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { join } from "node:path";
import { authDir } from "../../../../../src/infra/paths.js";
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js";
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js";
import { captureAccountConnection, providerAdapter, type AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { installedModules } from "../../../../../src/orchestration/module-catalog.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { fakeClient, preparedRequest, textStream } from "./_provider-chain-harness.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const noKeysAuth = { providers: authProviders(), credentialLineages: {}, droppedCredentials: [] };
const directories = testDirectories("/scratch");
const eligibility = {
  modelUnavailableReason: () => undefined,
  candidateOffering: (candidate: AccessProviderCandidate, model: string) => ({
    candidate, wireModelId: model, dataUse: "standard" as const,
    resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
  }),
};

describe("client construction login recovery", () => {
  const temporaryDirectory = temporaryDirectories();

  test.each(["interactive-external", "headless-external", "interactive-api"] as const)("binds login recovery only for %s across client construction routes", async (mode) => {
    const home = temporaryDirectory("client-login-wait-");
    const directory = authDir(join(home, ".flywheel"), "personal");
    const account = { accountId: "claude-personal", identity: "personal@example.com", configDir: join(directory, LOGIN_ACCOUNTS_DIRECTORY, "a") };
    await Bun.write(join(account.configDir, ".claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: account.accountId, emailAddress: account.identity },
    }));
    const observations = createLoginObservations();
    const claude = createClaudeAgentSdkModule({ account: () => ({ home, user: "tester" }), observations });
    const calls: unknown[][] = [];
    const contribution = claude.contributions[0];
    const external = {
      ...claude,
      contributions: [
        { ...contribution, value: {
          ...contribution.value,
          definition: { ...contribution.value.definition, auth: {
            ...contribution.value.definition.auth,
            awaitLogin: (authDirectory: string, accountId: string, signal: AbortSignal) => {
              calls.push([authDirectory, accountId, signal]);
              return contribution.value.definition.auth.awaitLogin(authDirectory, accountId, signal);
            },
          } },
          createClient: async (build: AccessProviderBuild) => {
            const client = { ...fakeClient(build.candidate.providerId, textStream("unused")), modelFamily: build.family };
            return providerAdapter(build, () => client, async () => client, (connected) => connected);
          },
        } },
        ...claude.contributions.slice(1),
      ],
    };
    const modules = composeFirstPartyModules(installedModules().map((module) => module.id === external.id ? external : module));
    const auth = mode === "interactive-api"
      ? { ...noKeysAuth, providers: authProviders({ apiKeys: { anthropic_api: "test-key" } }) }
      : noKeysAuth;
    const providers = accessProviderRegistry(modules);
    const connection = captureAccountConnection(auth, directory, providers, "personal");
    const failure = normalizeProviderAttemptFailure(Object.assign(new Error("login refused"), { status: 401 })).failure;
    if (failure._tag !== "AuthFailure") throw new Error("expected login refusal");
    const signal = new AbortController().signal;
    const stop = observations.observe(() => {
      const [question] = observations.loginQuestions();
      if (question?.phase === "asking") observations.answerLogin(question.id, "declined");
    });
    try {
      for (const captured of [false, true]) {
        const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
          profileId: "personal", getAuth: () => auth, definitions: repoDefinitions(),
          moduleSelection: modules, captureRuntimeConfig: testRuntimeConfigCapture,
          authDirectory: () => directory, connection: captured ? connection : undefined,
          getProviderModelEligibility: () => ({
            ...eligibility,
            candidateModelUnavailableReason: (candidate) => candidate.providerId === (mode === "interactive-api" ? "anthropic_api" : contribution.value.definition.id)
              ? undefined : "not selected",
          }),
          userDataRoot: directories.userDataRoot, modelsClient: fakeModelsClient,
          ...(mode === "headless-external" ? {} : { waitForLogin: true as const }),
        });
        const capture = await runtime.captureProviderConnection();
        const model = "claude-sonnet-4-6";
        const plan = capture.providers.selection.plan(model, capture.connection, capture.eligibility);
        const clients = [
          await runtime.createLLMClient(model, undefined, undefined, testProviderSessionLifetime()),
          await capture.admit(new Map([[model, plan]])).createLLMClient(model, undefined, undefined, testProviderSessionLifetime()),
        ];
        for (const client of clients) {
          observations.clearRequest(account);
          observations.recordRequest(account, "login-rejected");
          expect(await (await client.admitRequest()).run({
            signal,
            prepare: preparedRequest,
            execute: async () => ({ kind: "login_refused", failure, value: failure }),
          })).toBe(failure);
          expect(observations.loginQuestions()).toEqual([]);
        }
      }
      expect(calls).toEqual(mode === "interactive-external"
        ? Array.from({ length: 4 }, () => [directory, account.accountId, signal])
        : []);
    } finally {
      stop();
      observations.clearRequest(account);
    }
  });
});
