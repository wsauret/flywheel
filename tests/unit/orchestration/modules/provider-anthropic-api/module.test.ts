import { expect, setSystemTime, test } from "bun:test";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { createClaudeReminders } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { anthropicApiModule } from "../../../../../src/orchestration/modules/provider-anthropic-api/module.js";
import { fakeAvailability } from "../../agent-runtime/llm/_provider-chain-harness.js";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";

function build(id: string, contextLimit: number): AccessProviderBuild {
  const candidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const;
  const metadata = providerModelInfo({ provider: "anthropic", id, contextLimit, outputLimit: 32_000 });
  return {
    notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
    candidate, providerIdentity: { name: "Anthropic API Key", credential: "api_key" },
    model: metadata.id, wireModelId: metadata.id, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map(),
    },
    classifySlot: () => "metered", availability: fakeAvailability({}).availability, projectRoot: "/scratch",
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: () => {},
    accountOfferings: () => [],
  };
}

test("API-key client appends the shared Claude reminders", async () => {
  const [provider] = anthropicApiModule.contributions;
  const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Hi." }];
  // Both sides read the local date, so a fixed clock keeps them on one day.
  setSystemTime(new Date("2026-10-07T12:00:00"));
  try {
    for (const [model, contextLimit] of [["claude-haiku-4-5", 200_000], ["claude-opus-4-6", 1_000_000]] as const) {
      const staged = await provider.value.createClient(build(model, contextLimit));
      expect(staged.attempt.messagesToAppend?.(history, "/scratch")).toEqual(createClaudeReminders(model, contextLimit)(history, "/scratch"));
    }
  } finally {
    setSystemTime();
  }
});
