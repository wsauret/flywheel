/**
 * OpenCode Go endpoint dispatch in the client factory: each curated model
 * builds the adapter for its verified wire, and the Anthropic wire uses the
 * plan base without the /v1 segment (the Anthropic SDK appends /v1/messages).
 * Requests are captured at a stubbed global fetch; no network I/O occurs.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import { openCodeGoRequestHeaders } from "../../../../../src/infra/llm/provider-request-identity.js";
import { OPENCODE_GO_V1_BASE } from "../../../../../src/orchestration/modules/provider-opencode-go/wire.js";
const DIRECTORIES = testDirectories("/scratch");
const CREDENTIALS = authDir(DIRECTORIES.userDataRoot, "default");

const AUTH: AuthContext = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Builds the admitted OpenCode Go client for `model`, drives one request
 *  into a stubbed fetch that rejects with 400, and returns the URLs hit. */
async function capturedRequests(model: string): Promise<Array<{ url: string; headers: Headers }>> {
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    requests.push({ url, headers });
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
  }, { preconnect: realFetch.preconnect });

  const connection = captureProviderConnection({
    profileId: "default",
    authDir: CREDENTIALS,
    auth: AUTH,
    subscriptionCredentials: new Map([["opencode_go", [{ instanceId: "go-a", credential: { type: "api_key", key: Redacted.make("go-test-key") } }]]]),
  });
  const providers = accessProviderRegistry(testCapabilityModules());
  const transport = model === "qwen3.7-max"
    ? "anthropic-messages" as const
    : model === "grok-4.5"
      ? "openai-responses" as const
      : "openai-completions" as const;
  const eligibility = {
    modelUnavailableReason: () => undefined,
    candidateOffering: (candidate: import("../../../../../src/infra/llm/access-provider.js").AccessProviderCandidate) => ({
      candidate,
      wireModelId: model,
      dataUse: "standard" as const,
      transport,
      catalogMetadata: {
        transport: {
          npm: transport === "anthropic-messages"
            ? "@ai-sdk/anthropic"
            : transport === "openai-responses"
              ? "@ai-sdk/openai"
              : "@ai-sdk/openai-compatible",
        },
      },
      resolvedModelMetadata: modelInfo(transport === "anthropic-messages" ? "anthropic" : "openai", model, "test", 1, 4, "2026-01-01"),
    }),
  };
  const plan = providers.selection.plan(model, connection, eligibility);
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
      providerSessionKey: "provider-session-stable",
      cacheRetention: "none",
    });
  } catch {
    // The stubbed 400 is the expected terminal outcome.
  }
  return requests;
}

describe("OpenCode Go client factory endpoint dispatch", () => {
  test("a qwen id requests the Anthropic messages wire under /zen/go", async () => {
    const request = (await capturedRequests("qwen3.7-max")).find(({ url }) => url === `${OPENCODE_GO_V1_BASE}/messages`);
    expect(request?.url).toBe(`${OPENCODE_GO_V1_BASE}/messages`);
    await expectOpenCodeGoIdentity(request?.headers);
  });

  test("a Responses id requests /zen/go/v1/responses", async () => {
    const request = (await capturedRequests("grok-4.5")).find(({ url }) => url === `${OPENCODE_GO_V1_BASE}/responses`);
    expect(request?.url).toBe(`${OPENCODE_GO_V1_BASE}/responses`);
    await expectOpenCodeGoIdentity(request?.headers);
  });

  test("a chat-completions id requests /zen/go/v1/chat/completions", async () => {
    const request = (await capturedRequests("glm-5.2")).find(({ url }) => url === `${OPENCODE_GO_V1_BASE}/chat/completions`);
    expect(request?.url).toBe(`${OPENCODE_GO_V1_BASE}/chat/completions`);
    await expectOpenCodeGoIdentity(request?.headers);
  });
});

/** The request carries Flywheel's user agent and every OpenCode Go identity header for its provider session. */
async function expectOpenCodeGoIdentity(headers: Headers | undefined): Promise<void> {
  expect(headers?.get("user-agent")).toMatch(/^flywheel\/\d+\.\d+\.\d+ \(.+ .+; .+\)$/);
  for (const [name, value] of Object.entries(await openCodeGoRequestHeaders("provider-session-stable"))) expect(headers?.get(name)).toBe(value);
}
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
