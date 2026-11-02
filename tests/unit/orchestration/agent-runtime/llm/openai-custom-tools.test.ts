import { beforeEach, describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import type { OpenAIAuth } from "../../../../../src/infra/auth/openai-auth-types.js";
import { createOpenAITools } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { installChatGptAdapterModuleMocks, state, stubModelsClient } from "./_openai-chatgpt-adapter-fixtures.js";

installChatGptAdapterModuleMocks();

const API_KEY_AUTH: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-key") };
const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";
const APPLY_PATCH = {
  name: "apply_patch",
  description: "Apply a patch",
  input_schema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  },
  wire: { kind: "custom" as const, grammar: { syntax: "lark" as const, definition: "start: \"*** Begin Patch\"" }, functionDescription: "Put the patch in the input string" },
};
const ECHO = {
  name: "echo",
  description: "Echo text",
  input_schema: { type: "object", properties: { text: { type: "string" } } },
};

async function collect(client: LLMClient, signal?: AbortSignal): Promise<{ events: StreamEvent[]; error?: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      tools: [APPLY_PATCH],
      systemPrompt: stableSystemPrompt(""),
      signal,
    })) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

describe("OpenAI Responses custom tools", () => {
  let createOpenAIAdapter: typeof import("../../../../../src/orchestration/agent-runtime/llm/openai.js").createOpenAIAdapter;

  beforeEach(async () => {
    state.streamEvents = [];
    state.webSocketStreamEvents = undefined;
    state.lastResponsesCreateParams = undefined;
    const mod = await import("../../../../../src/orchestration/agent-runtime/llm/openai.js");
    createOpenAIAdapter = mod.createOpenAIAdapter;
  });

  it("presents apply_patch as a grammar-constrained custom tool and leaves other tools as functions", () => {
    const [applyPatch, echo] = createOpenAITools([APPLY_PATCH, ECHO]) ?? [];
    if (!applyPatch || !echo) throw new Error("expected apply_patch and echo tools");
    expect(applyPatch).toMatchObject({
      type: "custom",
      name: "apply_patch",
      description: "Apply a patch",
      format: { type: "grammar", syntax: "lark" },
    });
    expect(JSON.stringify(applyPatch)).toContain("*** Begin Patch");
    expect(echo).toEqual({
      type: "function",
      name: "echo",
      description: "Echo text",
      parameters: ECHO.input_schema,
      strict: false,
    });
  });

  it("sends a custom-wire tool as a function with the description it declares for the function wire", () => {
    expect(createOpenAITools([APPLY_PATCH], FUNCTION_TOOL_PRESENTATION)).toEqual([{
      type: "function",
      name: "apply_patch",
      description: "Put the patch in the input string",
      parameters: APPLY_PATCH.input_schema,
      strict: false,
    }]);
  });

  it("keeps canonical input in function form when the current presentation is not custom", async () => {
    state.streamEvents = [{ type: "response.completed", response: { id: "resp_fn", status: "completed", output: [] } }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());
    const messages = [
      { kind: "assistant" as const, provider: "openai" as const, api: "openai-responses" as const, model: "gpt-5.4", content: [{ type: "tool_use" as const, id: "call_echo", name: "echo", input: { text: "hello" } }] },
      { kind: "toolResult" as const, toolUseId: "call_echo", content: [{ type: "text" as const, text: "hello" }] },
      { kind: "user" as const, content: "continue" },
    ];

    for await (const _event of client.streamWithTools({ messages, tools: [ECHO], systemPrompt: stableSystemPrompt("") })) { /* consume */ }

    expect(state.lastResponsesCreateParams?.input).toContainEqual(expect.objectContaining({ type: "function_call", name: "echo", arguments: JSON.stringify({ text: "hello" }) }));
    expect(state.lastResponsesCreateParams?.input).toContainEqual(expect.objectContaining({ type: "function_call_output", output: "hello" }));
  });

  it.each([
    { split: false, inputDone: true },
    { split: true, inputDone: true },
    { split: false, inputDone: false },
    { split: true, inputDone: false },
  ])("preserves custom generation and canonical input (split=$split, inputDone=$inputDone)", async ({ split, inputDone }) => {
    const input = PATCH.replace("hello", '"hello"\\world');
    const chunks = split ? [input.slice(0, 20), input.slice(20)] : [input];
    const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input };
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
      ...chunks.map((delta) => ({ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_1", delta })),
      ...(inputDone ? [{ type: "response.custom_tool_call_input.done", output_index: 0, item_id: "ctc_1", input }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events, error } = await collect(client);

    expect(error).toBeUndefined();
    const deltas = events.filter((event) => event.kind === "tool_input_delta");
    expect(deltas).toEqual([
      { kind: "tool_input_delta", toolUseId: "call_1", partialJson: '{"input":"', generationText: "" },
      ...chunks.map((generationText) => ({
        kind: "tool_input_delta" as const, toolUseId: "call_1", partialJson: JSON.stringify(generationText).slice(1, -1), generationText,
      })),
      { kind: "tool_input_delta", toolUseId: "call_1", partialJson: '"}', generationText: "" },
    ]);
    expect(deltas.map((event) => event.partialJson).join("")).toBe(JSON.stringify({ input }));
    expect(events.filter((event) => event.kind === "tool_use")).toEqual([
      expect.objectContaining({ toolCall: expect.objectContaining({ id: "call_1", name: "apply_patch", input: { input } }) }),
    ]);
  });

  it("folds terminal-only custom calls into canonical input", async () => {
    const item = { type: "custom_tool_call", id: "ctc_2", call_id: "call_2", name: "apply_patch", input: PATCH };
    state.streamEvents = [{
      type: "response.completed",
      response: { id: "resp_2", status: "completed", output: [item] },
    }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events } = await collect(client);

    expect(events.filter((event) => event.kind === "tool_input_delta")).toEqual([]);
    expect(events.find((event) => event.kind === "tool_use")).toMatchObject({ toolCall: { input: { input: PATCH } } });
  });

  it("replays recorded native custom calls when the current request has no tools", async () => {
    state.streamEvents = [{ type: "response.completed", response: { id: "resp_empty", status: "completed", output: [] } }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());
    const messages = [
      { kind: "assistant" as const, provider: "openai" as const, api: "openai-responses" as const, model: "gpt-5.4", accessProvider: "openai_api" as const, content: [{ type: "tool_use" as const, id: "historical", providerCallId: "call_historical", providerItemId: "ctc_historical", name: "apply_patch", input: { input: PATCH } }] },
      { kind: "toolResult" as const, toolUseId: "historical", content: [{ type: "text" as const, text: "Done" }] },
    ];

    for await (const _event of client.streamWithTools({ messages, tools: [], systemPrompt: stableSystemPrompt("") })) { /* consume */ }

    expect(state.lastResponsesCreateParams?.input).toContainEqual({ type: "custom_tool_call", id: "ctc_historical", call_id: "call_historical", name: "apply_patch", input: PATCH });
    expect(state.lastResponsesCreateParams?.input).toContainEqual({ type: "custom_tool_call_output", call_id: "call_historical", output: "Done" });
  });

  it("emits an interrupted custom call with its accumulated canonical input", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled by caller");
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_3" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_3", call_id: "call_3", name: "apply_patch", input: "" } },
      { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_3", delta: PATCH },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());
    const events: StreamEvent[] = [];
    let error: unknown;
    try {
      for await (const event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [APPLY_PATCH], systemPrompt: stableSystemPrompt(""), signal: controller.signal })) {
        events.push(event);
        if (event.kind === "tool_input_delta" && event.partialJson.includes("Begin Patch")) controller.abort(cancellation);
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBe(cancellation);
    expect(events.find((event) => event.kind === "tool_use")).toMatchObject({ toolCall: { input: { input: PATCH } } });
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
