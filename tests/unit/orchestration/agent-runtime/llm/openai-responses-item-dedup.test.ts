/**
 * Terminal item deduplication on the OpenAI Responses stream.
 *
 * Some proxies (OpenCode Go's grok) stream `output_index` values that
 * disagree with the completed response's array positions. The adapter
 * therefore dedupes terminal items by their wire item id, falling back to
 * the output index only for items without one; keying by index alone
 * re-yielded the same function_call on the `response.completed` refold and
 * produced duplicate tool_use ids downstream.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Redacted } from "effect";
import type { OpenAIAuth } from "../../../../../src/infra/auth/openai-auth-types.js";
import type { LLMClient, StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { installChatGptAdapterModuleMocks, state, REASONING_INFO } from "./_openai-chatgpt-adapter-fixtures.js";

installChatGptAdapterModuleMocks();

const API_KEY_AUTH: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") };

const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
};

const FUNCTION_CALL = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "echo",
  arguments: '{"text":"hi"}',
  status: "completed",
};

const MESSAGE_ITEM = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello", annotations: [] }],
};

async function collect(client: LLMClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamWithTools({
    messages: [{ kind: "user", content: "hi" }],
    tools: [],
    systemPrompt: stableSystemPrompt(""),
  })) {
    events.push(event);
  }
  return events;
}

describe("OpenAI Responses terminal item dedup", () => {
  let createOpenAIAdapter: typeof import("../../../../../src/orchestration/agent-runtime/llm/openai.js").createOpenAIAdapter;

  beforeEach(async () => {
    state.streamEvents = [];
    state.webSocketStreamEvents = undefined;
    state.lastResponsesCreateParams = undefined;
    state.ensureFreshCalls = [];
    state.ensureFreshImpl = undefined;
    const mod = await import("../../../../../src/orchestration/agent-runtime/llm/openai.js");
    createOpenAIAdapter = mod.createOpenAIAdapter;
  });

  it("yields one tool_use when the completed refold's array position differs from the streamed output_index", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", item: MESSAGE_ITEM, output_index: 0 },
      { type: "response.output_text.delta", delta: "hello", output_index: 0 },
      { type: "response.output_item.added", item: { ...FUNCTION_CALL, arguments: "" }, output_index: 1 },
      { type: "response.output_item.done", item: FUNCTION_CALL, output_index: 1 },
      // The proxy's completed frame lists the function_call at array
      // position 0, not the streamed output_index 1.
      {
        type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: USAGE, output: [FUNCTION_CALL, MESSAGE_ITEM] },
      },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", REASONING_INFO);

    const events = await collect(client);

    const toolUses = events.filter((event) => event.kind === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ toolCall: { id: "call_1", name: "echo" } });
    // The message item folds exactly once too, under its own id.
    expect(events.filter((event) => event.kind === "text_terminal")).toHaveLength(1);
  });

  it("preserves interleaved deltas and reconciles text, refusals, and arguments from terminal items", async () => {
    const secondMessage = { ...MESSAGE_ITEM, id: "msg_2", content: [{ type: "refusal", refusal: "final refusal" }] };
    const secondCall = { ...FUNCTION_CALL, id: "fc_2", call_id: "call_2", arguments: '{"text":"second"}' };
    state.streamEvents = [
      { type: "response.output_item.added", item: MESSAGE_ITEM, output_index: 0 },
      { type: "response.output_item.added", item: secondMessage, output_index: 1 },
      { type: "response.output_item.added", item: { ...FUNCTION_CALL, arguments: "unused prefix" }, output_index: 2 },
      { type: "response.output_item.added", item: { ...secondCall, arguments: "" }, output_index: 3 },
      { type: "response.output_text.delta", delta: "hel", output_index: 0 },
      { type: "response.function_call_arguments.delta", delta: '{"text":', output_index: 2 },
      { type: "response.refusal.delta", delta: "partial refusal", output_index: 1 },
      { type: "response.function_call_arguments.delta", delta: '{"text":"second"}', output_index: 3 },
      { type: "response.output_text.delta", delta: "lo", output_index: 0 },
      { type: "response.function_call_arguments.delta", delta: '"partial"}', output_index: 2 },
      { type: "response.output_item.done", item: FUNCTION_CALL, output_index: 2 },
      { type: "response.function_call_arguments.delta", delta: "after completion", output_index: 2 },
      {
        type: "response.completed",
        response: { id: "resp_interleaved", status: "completed", usage: USAGE, output: [MESSAGE_ITEM, secondMessage, FUNCTION_CALL, secondCall] },
      },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", REASONING_INFO);

    const events = await collect(client);

    expect(events.filter((event) => event.kind === "text_delta" || event.kind === "tool_input_start" || event.kind === "tool_input_delta")).toEqual([
      { kind: "tool_input_start", toolUseId: "call_1", name: "echo" },
      { kind: "tool_input_start", toolUseId: "call_2", name: "echo" },
      { kind: "text_delta", text: "hel", blockKey: expect.stringMatching(/:0$/) },
      { kind: "tool_input_delta", toolUseId: "call_1", partialJson: '{"text":' },
      { kind: "text_delta", text: "partial refusal", blockKey: expect.stringMatching(/:1$/) },
      { kind: "tool_input_delta", toolUseId: "call_2", partialJson: '{"text":"second"}' },
      { kind: "text_delta", text: "lo", blockKey: expect.stringMatching(/:0$/) },
      { kind: "tool_input_delta", toolUseId: "call_1", partialJson: '"partial"}' },
    ]);
    expect(events.filter((event) => event.kind === "text_terminal").map((event) => event.content)).toEqual(["hello", "final refusal"]);
    expect(events.filter((event) => event.kind === "text_complete")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "tool_use").map((event) => event.toolCall)).toEqual([
      { id: "call_1", name: "echo", input: { text: "hi" }, providerItemId: "fc_1", providerCallId: "call_1" },
      { id: "call_2", name: "echo", input: { text: "second" }, providerItemId: "fc_2", providerCallId: "call_2" },
    ]);
  });

  it("keeps distinct item ids distinct on the completed refold", async () => {
    const second = { ...FUNCTION_CALL, id: "fc_2", call_id: "call_2" };
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.done", item: FUNCTION_CALL, output_index: 0 },
      {
        type: "response.completed",
        response: { id: "resp_2", status: "completed", usage: USAGE, output: [FUNCTION_CALL, second] },
      },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", REASONING_INFO);

    const events = await collect(client);

    const ids = events.filter((event) => event.kind === "tool_use").map((event) => event.toolCall.id);
    expect(ids).toEqual(["call_1", "call_2"]);
  });

  it("deduplicates a function_call that has no wire id and moves index on the refold", async () => {
    // The case both prior guards miss. A provider that omits the item id AND
    // reports a different array position on the completed frame defeats the id
    // key (absent) and the index key (changed), so the same call yielded twice
    // and the session tree refused the turn with "assistant message 1 contains
    // duplicate tool_use ids". Observed live on the Responses transport.
    const noId = { ...FUNCTION_CALL, id: undefined };
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_4" } },
      { type: "response.output_item.added", item: MESSAGE_ITEM, output_index: 0 },
      { type: "response.output_item.done", item: MESSAGE_ITEM, output_index: 0 },
      { type: "response.output_item.done", item: noId, output_index: 1 },
      // Completed lists the function_call first, so its array position is 0.
      {
        type: "response.completed",
        response: { id: "resp_4", status: "completed", usage: USAGE, output: [noId, MESSAGE_ITEM] },
      },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", REASONING_INFO);

    const events = await collect(client);

    expect(events.filter((event) => event.kind === "tool_use")).toHaveLength(1);
  });

});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
