import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../../../../../src/infra/llm/models.js";
import { prepareAnthropicRequest } from "../../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import type { ConversationMessage, StreamOptions } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import { cliView, type QueryIdentity } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import { CLAUDE_AGENT_SDK_PROVIDER_ID } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { conversationTierEntry, createHostedAgentEntries, DISPATCH_TEXT, ENGINE_INSTRUCTIONS, hostedTransportContext, hostedView } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";

const brief: ConversationMessage = { kind: "user", origin: "human", content: "Do the work." };
const TIERS = { stable: "Stable.", session: "Session.", conversation: "# Session identity\n\nYou are session one." };
const TIER_ENTRY = conversationTierEntry(TIERS.conversation);
const request = (messages: ConversationMessage[], systemPrompt = TIERS): StreamOptions => ({ messages, systemPrompt, tools: [], reasoningEffort: "medium" });
const engineEntries = (entries: readonly ConversationMessage[]) => entries.flatMap((message) => message.kind === "user" ? [message.content] : []);
/** A query identity whose system blocks are `systemPrompt`. The view reads only those blocks and the cache mark. */
const identity = (systemPrompt: readonly string[]): QueryIdentity => ({
  systemPrompt, tools: [], thinking: { type: "adaptive" }, toolChoice: undefined, maxTokens: 64_000, extraBody: {}, cwd: "/scratch", eagerInputStreaming: false, promptCaching: false, effort: undefined,
});

describe("the hosted agent's request entries", () => {
  test("a dispatch adds the conversation tier and the engine's system text once per context and one wrapper after the newest input", () => {
    const entries = createHostedAgentEntries(() => true);
    const first = entries(request([brief]));
    expect(engineEntries(first)).toEqual([TIER_ENTRY, ENGINE_INSTRUCTIONS, DISPATCH_TEXT]);
    expect(first.every((message) => message.origin === "system")).toBe(true);
    // The tier entry and the engine's text are framing of the shared host, which no other route and no fork reads.
    expect(first.map((message) => message.framing)).toEqual(["agent-host", "agent-host", "agent-host"]);
    // A retried attempt of the same request finds them all and adds none.
    expect(entries(request([brief, ...first]))).toEqual([]);
    // So does one that ends with request-only text, such as the continuation after a stall.
    expect(entries({ ...request([brief, ...first, { kind: "user", content: "Continue smaller." }]), requestContext: "Continue smaller." })).toEqual([]);
    const steer: ConversationMessage[] = [brief, ...first, { kind: "assistant", content: [{ type: "text", text: "Done." }] }, { kind: "user", origin: "human", content: "Again." }];
    expect(engineEntries(entries(request(steer)))).toEqual([DISPATCH_TEXT]);
  });

  test("a dispatch answers a system-origin input, such as a workflow task or a steer, with one wrapper", () => {
    const entries = createHostedAgentEntries(() => true);
    const task: ConversationMessage = { kind: "user", origin: "system", content: "Workflow task." };
    const untiered = { ...TIERS, conversation: "" };
    const first = entries(request([task], untiered));
    expect(engineEntries(first)).toEqual([ENGINE_INSTRUCTIONS, DISPATCH_TEXT]);
    expect(entries(request([task, ...first], untiered))).toEqual([]);
    const steered: ConversationMessage[] = [task, ...first, { kind: "assistant", content: [{ type: "text", text: "Done." }] }, { kind: "user", origin: "system", content: "Parent steer." }];
    expect(engineEntries(entries(request(steered, untiered)))).toEqual([DISPATCH_TEXT]);
  });

  test("a tier that holds a plugin variable stays hosted and reaches the model in the opening message, never in the definition", () => {
    // The engine fills `${CLAUDE_PLUGIN_ROOT}` in a definition's prompt, so the definition would not send the request's bytes.
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- the engine's own plugin variable, written literally
    const plugin = { ...TIERS, session: "Run ${CLAUDE_PLUGIN_ROOT}/bin/tool." };
    const first = createHostedAgentEntries(() => true)(request([brief], plugin));
    expect(engineEntries(first)).toEqual([conversationTierEntry(plugin.session), TIER_ENTRY, ENGINE_INSTRUCTIONS, DISPATCH_TEXT]);
    expect(first.map((message) => message.framing)).toEqual(["agent-host", "agent-host", "agent-host", "agent-host"]);
    const text = (value: string) => ({ type: "text" as const, text: value });
    const view = {
      messages: [{ role: "user" as const, content: ["Do the work.", ...engineEntries(first)].map((value) => text(String(value))) }],
      reminders: [],
      identity: identity([plugin.stable, plugin.session, plugin.conversation]),
      origins: [["person" as const, ...first.map(() => "host-framing" as const)]],
    };
    const hosted = hostedView(view);
    expect(hosted.definitionPrompt).toBe(plugin.stable);
    expect(hosted.messages[0]?.content).toEqual([text("Do the work."), text(conversationTierEntry(plugin.session)), text(TIER_ENTRY)]);
    expect(hostedTransportContext(hosted, true, false, [], undefined, []).additions.filter(({ kind }) => kind === "system-tier:conversation"))
      .toEqual([{ part: "message", kind: "system-tier:conversation", at: 0, value: "1" }, { part: "message", kind: "system-tier:conversation", at: 0, value: "2" }]);
  });

  test("an extension of the agent's turn adds no engine text", () => {
    const entries = createHostedAgentEntries(() => false);
    const history: ConversationMessage[] = [brief, { kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }, { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "x" }] }];
    expect(entries(request(history))).toEqual([]);
  });
});

const SONNET: ModelInfo = {
  provider: "anthropic", family: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, toolCall: true,
  attachment: true, temperature: true, openWeights: false, cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text", "image"], output: ["text"] }, contextLimit: 1_000_000, outputLimit: 64_000,
};

/** The hosted view of the request that the shared adapter prepares for the shared host from `history`. */
function preparedHostedView(history: ConversationMessage[]) {
  const prepared = prepareAnthropicRequest({
    accessProvider: CLAUDE_AGENT_SDK_PROVIDER_ID, model: SONNET.id, wireModel: SONNET.id, info: SONNET, hosted: true, options: request(history),
    presentation: { format: "mcp-function-schema", present: (tool) => ({ kind: "function", description: tool.description, inputFormat: tool.input_schema }), wireName: (name) => `mcp__runtime__${name}` },
  });
  expect(prepared.historyTarget.sharedHost).toBe(true);
  return hostedView(cliView(prepared.params, prepared.origins, "/scratch"));
}

describe("the hosted view", () => {
  test("takes out only the engine's text that the runtime wrote, so a person's message with the same bytes reaches the agent", () => {
    const entries = createHostedAgentEntries(() => true);
    const history: ConversationMessage[] = [brief];
    history.push(...entries(request(history)), { kind: "assistant", content: [{ type: "text", text: "Done." }] }, { kind: "user", origin: "human", content: ENGINE_INSTRUCTIONS }, { kind: "user", origin: "human", content: DISPATCH_TEXT });
    const dispatched = entries(request(history));
    history.push(...dispatched);
    const text = (value: string) => ({ type: "text" as const, text: value });
    const view = preparedHostedView(history);

    expect(view.messages).toEqual([
      { role: "user", content: [text("Do the work."), text(TIER_ENTRY)] },
      { role: "assistant", content: [text("Done.")] },
      { role: "user", content: [text(ENGINE_INSTRUCTIONS), text(DISPATCH_TEXT)] },
    ]);
    expect(view.dispatches).toEqual([0, 2]);
    expect(view.definitionPrompt).toBe("Stable.\n\n---\n\nSession.");
  });

  test("takes the engine's text out of every user message, names the user message that a wrapper ends, and keeps the conversation tier out of the definition", () => {
    const view = hostedView({
      messages: [
        // A dispatch that no answer followed leaves the engine's text before the steer that the next dispatch answers.
        { role: "user", content: [{ type: "text", text: "Do the work." }, { type: "text", text: TIER_ENTRY }, { type: "text", text: ENGINE_INSTRUCTIONS }, { type: "text", text: DISPATCH_TEXT }, { type: "text", text: "Steer." }, { type: "text", text: DISPATCH_TEXT }] },
        // An answer that is the wrapper, and an input that quotes it, are the conversation's own text.
        { role: "assistant", content: [{ type: "text", text: DISPATCH_TEXT }] },
        { role: "user", content: [{ type: "text", text: `Quote: ${DISPATCH_TEXT}` }, { type: "text", text: "Again." }] },
      ],
      reminders: [],
      identity: identity([TIERS.stable, TIERS.session, TIERS.conversation]),
      origins: [["person", "host-framing", "host-framing", "host-framing", "person", "host-framing"], ["assistant"], ["person", "person"]],
    });
    expect(view.messages.map((message) => message.content)).toEqual([[{ type: "text", text: "Do the work." }, { type: "text", text: TIER_ENTRY }, { type: "text", text: "Steer." }], [{ type: "text", text: DISPATCH_TEXT }], [{ type: "text", text: `Quote: ${DISPATCH_TEXT}` }, { type: "text", text: "Again." }]]);
    expect(view.dispatches).toEqual([0]);
    // The conversation tier that the conversation holds leaves the definition's prompt.
    expect(view.definitionPrompt).toBe("Stable.\n\n---\n\nSession.");
  });

  test("a wrapper that only the request's request-only text follows records a dispatch, and one that later input follows does not", () => {
    const text = (value: string) => ({ type: "text" as const, text: value });
    const origin = (value: string) => value === DISPATCH_TEXT ? "host-framing" as const : value === "Continue smaller." ? "request-context" as const : "person" as const;
    const view = (...content: string[]) => hostedView({ messages: [{ role: "user", content: content.map(text) }], reminders: [], identity: identity([]), origins: [content.map(origin)] });
    const continued = view("Do the work.", DISPATCH_TEXT, "Continue smaller.");
    expect(continued.dispatches).toEqual([0]);
    expect(continued.messages[0]?.content).toEqual([text("Do the work."), text("Continue smaller.")]);
    expect(view("Do the work.", DISPATCH_TEXT, "Steer.", "Continue smaller.").dispatches).toEqual([]);
  });
});
