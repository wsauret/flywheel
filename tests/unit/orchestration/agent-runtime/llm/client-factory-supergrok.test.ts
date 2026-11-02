/**
 * SuperGrok client construction: an admitted grok plan builds the OpenAI
 * Responses adapter against the subscription proxy and authenticates every request with
 * the captured OAuth bearer. Requests are captured at a stubbed global fetch;
 * no network I/O occurs.
 */
import { afterEach, expect, test } from "bun:test";
import { Redacted } from "effect";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { authDir, modelsSnapshotFile } from "../../../../../src/infra/paths.js";
import { createAdmittedClient } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { testCapabilityModules, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { fakeAvailability, requestEvents } from "./_provider-chain-harness.js";

import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js";
const DIRECTORIES = testDirectories("/scratch");
const CREDENTIALS = authDir(DIRECTORIES.userDataRoot, "default");

const AUTH: AuthContext = {
  providers: authProviders({ oauth: ["supergrok"] }),
  credentialLineages: {}, droppedCredentials: [],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an admitted grok plan requests subscription Responses with the captured bearer and required client headers", async () => {
  const requests: { url: string; authorization: string | null; tokenAuth: string | null; clientVersion: string | null }[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization"), tokenAuth: headers.get("X-XAI-Token-Auth"), clientVersion: headers.get("x-grok-client-version") });
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
  }, { preconnect: realFetch.preconnect });

  const connection = captureProviderConnection({
    profileId: "default",
    authDir: CREDENTIALS,
    auth: AUTH,
    subscriptionCredentials: new Map([["supergrok", [{
      instanceId: "supergrok-test",
      credential: { type: "oauth", access: Redacted.make("xai-access-token"), refresh: Redacted.make("xai-refresh-token"), expires: Date.now() + 3_600_000 },
    }]]]),
  });
  const providers = accessProviderRegistry(testCapabilityModules());
  const eligibility = {
    modelUnavailableReason: () => undefined,
    candidateOffering: (candidate: import("../../../../../src/infra/llm/access-provider.js").AccessProviderCandidate, model: string) => ({
      candidate,
      wireModelId: model,
      dataUse: "standard" as const,
      transport: "openai-responses" as const,
      catalogMetadata: { transport: { npm: "@ai-sdk/openai" } },
      resolvedModelMetadata: modelInfo("openai", model, "grok", 2, 8, "2026-01-01"),
    }),
  };
  const plan = providers.selection.plan("grok-4.6", connection, eligibility);
  const { availability } = fakeAvailability({});
  const client = await createAdmittedClient(
    plan,
    createModelsClient(modelsSnapshotFile(DIRECTORIES.userDataRoot)),
    connection,
    { notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(), projectRoot: DIRECTORIES.projectRoot, providers, eligibility, allowTrainingRoutes: false, requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }), availability: { forCandidates: () => availability, dispose: () => Promise.resolve() } },
  );
  try {
    await requestEvents(client, {
      messages: [{ kind: "user", content: "hi" }],
      tools: [],
      systemPrompt: stableSystemPrompt(""),
    });
  } catch {
    // The stubbed 400 is the expected terminal outcome.
  }

  expect(requests.map((r) => r.url)).toContain("https://cli-chat-proxy.grok.com/v1/responses");
  const responsesRequest = requests.find((r) => r.url === "https://cli-chat-proxy.grok.com/v1/responses");
  expect(responsesRequest?.tokenAuth).toBe("xai-grok-cli");
  expect(responsesRequest?.clientVersion).toBe("1.0.45");
  expect(responsesRequest?.authorization).toBe("Bearer xai-access-token");
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
