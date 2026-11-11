import { lowerProviderHistory, planHistoryLowering } from "../../../../../src/orchestration/agent-runtime/llm/provider-history.js";
import { describe, expect, test } from "bun:test";
import type { ConversationMessage, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { toOpenAIResponsesInput } from "../../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses.js";
import { toAnthropicMessagesRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages.js";
import { toGoogleGenerativeAiRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/google-generative-ai.js";
import { toChatCompletionsMessages } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions-messages.js";
import { createClaudeReminders, createModelReminders, parseRuntimeReminder } from "../../../../../src/orchestration/agent-runtime/llm/runtime-reminders.js";
import { captureForkMessages } from "../../../../../src/orchestration/agent-runtime/agent-loop-history.js";
import { AGENT_APPENDIX, AGENT_IDENTITY, conversationTierEntry, createHostedAgentEntries, DISPATCH_TEXT } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js";
import { createConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { openAIResponsesTarget } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";
import { Redacted } from "effect";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { openrouterModule } from "../../../../../src/orchestration/modules/provider-openrouter/module.js";
import { fakeAvailability } from "./_provider-chain-harness.js";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";

const directory = temporaryDirectories();

const openai = { sharedHost: false, accessProvider: "openai_api" as const, provider: "openai" as const, api: "openai-responses" as const, model: "o4" };
const anthropic = { sharedHost: false, accessProvider: "anthropic_api" as const, provider: "anthropic" as const, api: "anthropic-messages" as const, model: "claude-sonnet-5-5" };
const google = { accessProvider: "google_api" as const, provider: "google" as const, api: "google-generative-ai" as const, model: "gemini-2.0", supportsImages: true };

function textResult(toolUseId: string, text: string, isError = false): ConversationMessage {
  return { kind: "toolResult", toolUseId, content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

describe("Claude framing", () => {
  const tier = "# Session identity\n\nYou are session one.";
  const brief: ConversationMessage = { kind: "user", origin: "human", content: "Do the work." };
  const reminders = createClaudeReminders("claude-sonnet-5-5", 200_000)([brief], "/scratch", SHELL_CAPABILITIES);
  const engine = createHostedAgentEntries(() => true)({ messages: [brief, ...reminders], systemPrompt: { stable: "Stable.", session: "", conversation: tier }, tools: [], reasoningEffort: "medium" });
  const notice: ConversationMessage = { kind: "user", origin: "system", runtimeNotice: true, content: "<subagent_notifications>child done</subagent_notifications>" };
  const toolNotice: ConversationMessage = { kind: "user", origin: "system", framing: "tool-notice", content: "## Tools\n\nThe tool `read` is available again." };
  const history: ConversationMessage[] = [
    brief, ...reminders, ...engine, toolNotice,
    { kind: "assistant", content: [{ type: "tool_use", id: "wait-1", name: "process", input: { action: "wait" } }], ...anthropic, timestamp: 1 },
    textResult("wait-1", "Wait acknowledged."), notice,
  ];
  const reminderKind = (message: ConversationMessage) => message.kind === "user" && typeof message.content === "string" ? parseRuntimeReminder(message.content)?.kind : undefined;
  const model = reminders.find((message) => reminderKind(message) === "model");
  const environment = reminders.find((message) => reminderKind(message) === "environment");
  const text = (message: ConversationMessage | undefined) => message?.kind === "user" && typeof message.content === "string" ? message.content : "";
  const wire = (value: string) => JSON.stringify(value).slice(1, -1);
  // The engine's text and the conversation tier are framing of the shared host, which only a request that it serves reads.
  const hostOnly = [AGENT_IDENTITY, AGENT_APPENDIX.trim().slice(0, 60), DISPATCH_TEXT, conversationTierEntry(tier)].map(wire);
  const claudeOnly = [...hostOnly, wire(text(model))];
  const kept = [text(brief), text(notice), text(environment), text(toolNotice), "Wait acknowledged."].map(wire);
  const conversions = {
    "OpenAI Responses": (messages: ConversationMessage[]) => JSON.stringify(toOpenAIResponsesInput(openai, messages)),
    "chat completions": (messages: ConversationMessage[]) => JSON.stringify(toChatCompletionsMessages(messages, true, openAIResponsesTarget("openrouter", "test-model"))),
    Google: (messages: ConversationMessage[]) => JSON.stringify(toGoogleGenerativeAiRequest(google, messages)),
  };

  test("only the shared host reads its framing, every Anthropic Messages request to the model reads the Claude model reminder, and every route reads the rest", () => {
    expect(claudeOnly.every((value) => value.length > 0) && text(model) !== "").toBe(true);
    for (const convert of Object.values(conversions)) {
      const body = convert(history);
      for (const value of claudeOnly) expect(body).not.toContain(value);
      for (const value of kept) expect(body).toContain(value);
    }
    // The Anthropic API key and the agent's own engine are Anthropic Messages routes that the host does not serve.
    const ownEngineBody = JSON.stringify(toAnthropicMessagesRequest(anthropic, history));
    for (const value of hostOnly) expect(ownEngineBody).not.toContain(value);
    for (const value of [wire(text(model)), ...kept]) expect(ownEngineBody).toContain(value);
    const hostedBody = JSON.stringify(toAnthropicMessagesRequest({ ...anthropic, sharedHost: true }, history));
    for (const value of [...claudeOnly, ...kept]) expect(hostedBody).toContain(value);
  });

  test("a model reminder of another route reaches only a request to the model that it names, and no Anthropic request reads one for another model", async () => {
    // OpenRouter names its canonical model in its history target and sends the vendor's wire ID, so the reminder and the
    // target come from the route's own wiring.
    const metadata = providerModelInfo({ provider: "openai", id: "gpt-6.1-sol", contextLimit: 400_000, outputLimit: 32_000 });
    const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const;
    const build: AccessProviderBuild = {
      notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
      candidate, providerIdentity: { name: "OpenRouter API Key", credential: "api_key" },
      model: metadata.id, wireModelId: `openai/${metadata.id}`, family: "openai",
      modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
      connection: {
        id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
        auth: { providers: new Map([["openrouter", { kind: "api_key", key: Redacted.make("sk-or-test") }]]), credentialLineages: {}, droppedCredentials: [] },
        subscriptionCredentials: new Map(),
      },
      classifySlot: () => "metered", availability: fakeAvailability({}).availability, projectRoot: "/scratch",
      attribution: { candidate, wireModelId: `openai/${metadata.id}`, dataUse: "standard", resolvedModelMetadata: metadata },
      recordModelRefusal: () => {}, accountOfferings: () => [],
    };
    const staged = await openrouterModule.contributions[0].value.createClient(build);
    const sol = await (await staged.connect()).historyTarget({ messages: [], tools: [], systemPrompt: { stable: "", session: "", conversation: "" } } satisfies StreamOptions);
    const gemini = { ...google, model: "gemini-3-pro" };
    const ownModel = (appended: readonly ConversationMessage[]) => text(appended.find((message) => reminderKind(message) === "model"));
    const conversation: ConversationMessage[] = [...history, { kind: "assistant", content: "Done.", ...anthropic, timestamp: 2 }, { kind: "user", origin: "human", content: "Switch." }];
    const solReminders = staged.attempt.messagesToAppend?.(conversation, "/scratch", SHELL_CAPABILITIES) ?? [];
    conversation.push(...solReminders, { kind: "assistant", content: "Switched.", ...sol, timestamp: 3 }, { kind: "user", origin: "human", content: "Again." });
    // A failover to another provider states its own model in the same request.
    const geminiReminders = createModelReminders(gemini.model, 1_048_576)(conversation, "/scratch", SHELL_CAPABILITIES);
    conversation.push(...geminiReminders);
    const [solText, geminiText, claudeText] = [ownModel(solReminders), ownModel(geminiReminders), text(model)].map(wire);
    expect([solText, geminiText, claudeText].every((value) => value !== "")).toBe(true);
    const bodies = {
      [solText!]: JSON.stringify(toChatCompletionsMessages(conversation, true, sol)),
      [geminiText!]: JSON.stringify(toGoogleGenerativeAiRequest(gemini, conversation)),
      [claudeText!]: JSON.stringify(toAnthropicMessagesRequest(anthropic, conversation)),
    };
    for (const [own, body] of Object.entries(bodies)) {
      for (const named of [solText, geminiText, claudeText]) expect(body.includes(named!)).toBe(named === own);
    }
    expect(planHistoryLowering(conversation, anthropic).filter((edit) => edit.reason === "model-framing").map((edit) => edit.at))
      .toEqual([conversation.indexOf(solReminders[0]!), conversation.indexOf(geminiReminders[0]!)]);
  });

  test("a Claude model reminder reaches only a request to the model that it names, which reads it unchanged", () => {
    const extended = createClaudeReminders("claude-sonnet-5-5", 1_000_000)([brief], "/scratch", SHELL_CAPABILITIES);
    const conversation: ConversationMessage[] = [brief, ...extended, { kind: "assistant", content: "Done.", ...anthropic, timestamp: 2 }, { kind: "user", origin: "human", content: "Next." }];
    const claudeText = wire(text(extended.find((message) => reminderKind(message) === "model")));
    // The engine names the extended window in its model ID, and the request to that model reads its reminder as written.
    for (const own of [anthropic, { ...anthropic, sharedHost: true }]) {
      expect(planHistoryLowering(conversation, own)).toEqual([]);
      expect(JSON.stringify(toAnthropicMessagesRequest(own, conversation))).toContain(claudeText);
    }
    // Another Claude model, and another route's spelling of one, state their own model instead.
    for (const other of [{ ...anthropic, model: "claude-opus-5-5" }, { ...anthropic, accessProvider: "github_copilot" as const, model: "claude-sonnet-5.5" }]) {
      expect(planHistoryLowering(conversation, other)).toEqual([{ at: 2, reason: "claude-framing" }]);
      expect(JSON.stringify(toAnthropicMessagesRequest(other, conversation))).not.toContain(claudeText);
    }
  });

  test("a request that continues a partial answer after a route's reminders still asks to continue", () => {
    const partial: ConversationMessage = { kind: "assistant", content: "Half of the", ...anthropic, timestamp: 2, incomplete: true };
    const conversation: ConversationMessage[] = [brief, ...reminders, partial];
    const takeover = createClaudeReminders("claude-opus-5-5", 200_000)(conversation, "/scratch", SHELL_CAPABILITIES);
    const lowered = lowerProviderHistory([...conversation, ...takeover], { ...anthropic, model: "claude-opus-5-5" });
    expect(lowered.slice(-3).map((message) => message.kind === "user" ? message.content : message.kind)).toEqual([
      "assistant", text(takeover[0]), "Continue the original request from the retained assistant output without repeating completed work.",
    ]);
  });

  test("the labels that name who wrote a block change no request bytes on any route, also in a fork", async () => {
    // A person's text with a reminder's bytes, and the request-only text with its in-memory mark.
    const labeled: ConversationMessage[] = [...history, { kind: "assistant", content: "Done.", ...anthropic, timestamp: 2 }, { kind: "user", origin: "human", content: text(environment) }, { kind: "user", content: "Continue smaller.", requestOnly: true }];
    const unlabeled = labeled.map((message): ConversationMessage => {
      if (message.kind !== "user") return message;
      const { framing, requestOnly: _mark, ...rest } = message;
      return framing === "reminder" ? rest : { ...rest, ...(framing ? { framing } : {}) };
    });
    expect(unlabeled).not.toEqual(labeled);
    for (const convert of Object.values(conversions)) expect(convert(labeled)).toBe(convert(unlabeled));
    for (const target of [anthropic, { ...anthropic, sharedHost: true }]) {
      const [stamped, unstamped] = [toAnthropicMessagesRequest(target, labeled), toAnthropicMessagesRequest(target, unlabeled)];
      expect(JSON.stringify([stamped.system, stamped.messages])).toBe(JSON.stringify([unstamped.system, unstamped.messages]));
      // Only the labels decide the origins: the reminders are the runtime's, the same bytes from the person stay the person's.
      expect(stamped.origins[0]?.slice(0, 4)).toEqual(["person", "runtime-reminder", "claude-framing", "runtime-reminder"]);
      expect(stamped.origins.at(-1)?.slice(-2)).toEqual(["person", "request-context"]);
      expect(unstamped.origins.at(-1)?.slice(-2)).toEqual(["person", "person"]);
    }
    expect(conversions["OpenAI Responses"](await captureForkMessages(labeled))).toBe(conversions["OpenAI Responses"](await captureForkMessages(unlabeled)));
  });

  test("a fork of that history converted for OpenAI Responses holds no conversation-tier entry either", async () => {
    const body = conversions["OpenAI Responses"](await captureForkMessages(history));
    expect(body).not.toContain(JSON.stringify(conversationTierEntry(tier)).slice(1, -1));
    for (const value of claudeOnly) expect(body).not.toContain(value);
    expect(body).toContain(text(notice));
    expect(body).not.toContain(wire(text(toolNotice)));
  });

  test("the same history that a build before 2026-10-26 stored without framing reads back with it, and the stored entries keep their shape", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(directory("claude-framing-")));
    const tree = await createConversationTree({ conversationId: "conversation", sessionId: "session", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    // Builds before 2026-10-26 stored no framing, and builds before 2026-10-27 stored the tool notice as a conversation tier.
    const unlabeled = history.map((message): ConversationMessage => {
      if (message.kind !== "user") return message;
      const { framing, ...previous } = message;
      // The current writer no longer types the `conversation-tier` framing that the stored schema still reads.
      if (framing === "tool-notice") Reflect.set(previous, "framing", "conversation-tier");
      return previous;
    });
    for (const message of unlabeled) await tree.appendMessage(message);
    try {
      const stored = (await tree.getBranch()).flatMap((entry) => entry.kind === "message" ? [entry.message] : []);
      expect(stored.flatMap((message) => message.kind === "user" && message.framing !== undefined ? [message.framing] : [])).toEqual(["conversation-tier"]);
      const read = (await tree.buildContext()).messages;
      expect(read.map((message) => message.kind === "user" ? message.framing : undefined)).toEqual(history.map((message) => message.kind === "user" ? message.framing : undefined));
      for (const convert of Object.values(conversions)) {
        const body = convert(read);
        for (const value of claudeOnly) expect(body).not.toContain(value);
        for (const value of kept) expect(body).toContain(value);
      }
      const fork = conversions["OpenAI Responses"](await captureForkMessages([], () => tree.captureCommittedForkMessages()));
      expect(fork).not.toContain(JSON.stringify(conversationTierEntry(tier)).slice(1, -1));
      for (const value of claudeOnly) expect(fork).not.toContain(value);
      expect(fork).toContain(text(notice));
    } finally {
      await tree.getStorage().dispose();
      store.close();
    }
  });
});
