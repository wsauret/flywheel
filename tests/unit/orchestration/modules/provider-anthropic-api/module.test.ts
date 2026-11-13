import { Redacted } from "effect";
import { expect, setSystemTime, test } from "bun:test";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { createClaudeReminders } from "../../../../../src/orchestration/agent-runtime/llm/runtime-reminders.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import type { ConversationMessage, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { anthropicApiModule } from "../../../../../src/orchestration/modules/provider-anthropic-api/module.js";
import { fakeAvailability } from "../../agent-runtime/llm/_provider-chain-harness.js";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

function build(id: string, contextLimit: number, outputLimit = 32_000): AccessProviderBuild {
  const candidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const;
  const metadata = providerModelInfo({ provider: "anthropic", id, contextLimit, outputLimit });
  return {
    notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
    candidate, providerIdentity: { name: "Anthropic API Key", credential: "api_key" },
    model: metadata.id, wireModelId: metadata.id, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map([["anthropic_api", { kind: "api_key", key: Redacted.make("sk-ant-test") }]]), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map(),
    },
    classifySlot: () => "metered", availability: fakeAvailability({}).availability, projectRoot: "/scratch",
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: () => {},
  };
}

test("API-key client appends the shared Claude reminders", async () => {
  const [provider] = anthropicApiModule.contributions;
  const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Hi." }];
  // Both sides read the local date, so a fixed clock keeps them on one day.
  setSystemTime(new Date("2026-10-07T12:00:00"));
  try {
    for (const [model, contextLimit] of [["claude-haiku-4-5", 200_000], ["claude-opus-4-6", 1_000_000]] as const) {
      const adapterBuild = build(model, contextLimit);
      const staged = await (await provider.value.createClient(adapterBuild)).stage({ attribution: adapterBuild.attribution, accountOfferings: [] });
      expect(staged.attempt.messagesToAppend?.(history, "/scratch", SHELL_CAPABILITIES)).toEqual(createClaudeReminders(model, contextLimit)(history, "/scratch", SHELL_CAPABILITIES));
    }
  } finally {
    setSystemTime();
  }
});

test("one connection sends each request with the output cap and context window of that request's own eligibility", async () => {
  const [provider] = anthropicApiModule.contributions;
  // The client opens on the extended window; a later publication narrows the window and the output limit.
  const opened = build("claude-opus-4-6", 1_000_000, 64_000);
  const narrowed = build("claude-opus-4-6", 200_000, 8_000).attribution;
  const sent: { readonly maxTokens: unknown; readonly betas: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    const body: { max_tokens?: unknown } = JSON.parse(String(init?.body));
    sent.push({ maxTokens: body.max_tokens, betas: new Headers(init?.headers).get("anthropic-beta") ?? "" });
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }), { status: 400, headers: { "content-type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  const options = { messages: [{ kind: "user", origin: "human", content: "Hi." }], tools: [], systemPrompt: { stable: "", session: "", conversation: "" } } satisfies StreamOptions;
  try {
    const adapter = await provider.value.createClient(opened);
    for (const attribution of [opened.attribution, narrowed]) {
      const client = await (await adapter.stage({ attribution, accountOfferings: [] })).connect();
      try {
        for await (const _event of client.streamWithTools(options)) { /* The recorded refusal ends the stream. */ }
      } catch { /* The recorded refusal fails the request after its body was sent. */ }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(sent.map(({ maxTokens }) => maxTokens)).toEqual([32_000, 8_000]);
  expect(sent.map(({ betas }) => betas.includes("context-1m"))).toEqual([true, false]);
});
