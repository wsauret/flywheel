/**
 * Chat-completions message conversion invariants.
 *
 * Port sources (pi `openai-completions.ts`): batched tool-result
 * images with the contiguous tool block preserved (:1195-1263), skipped empty
 * assistant messages (:1182-1193), non-empty tool content placeholders
 * (:1210-1212), and thinking replayed on its reasoning field (:502-506,
 * :1100-1136). Foreign thinking is withheld (`provider-history.ts`).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createGenerationMeasurement } from "../../../../../src/orchestration/agent-runtime/generation-measurement.js";
import OpenAI from "openai";
import type { ModelInfo, ModelsClient } from "../../../../../src/infra/llm/models.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { toChatCompletionsMessages } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions-messages.js";
import type { ConversationMessage, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const PNG = { type: "image" as const, mediaType: "image/png", data: "AAA" };

/** A chat-completions turn as builds before 2026-10-27 stored it: the API, provider, and model, with no access
 *  provider (`replayOf` in provider-history.ts). */
const LEGACY_CHAT_TURN = { api: "openai-responses", provider: "openai", model: "test-model" } as const;

describe("tool-result runs", () => {
  test("keeps parallel tool results contiguous and appends their images once", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      {
        kind: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "shot", input: {} },
          { type: "tool_use", id: "c2", name: "shot", input: {} },
        ],
      },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "one" }, PNG] },
      { kind: "toolResult", toolUseId: "c2", content: [{ type: "text", text: "two" }, PNG] },
      { kind: "user", content: "thanks" },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const roles = out.map((m) => m.role);

    // Both tool messages adjacent, then one image-carrying user message.
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user", "user"]);
    const imageMessage = out[4];
    if (imageMessage?.role !== "user" || typeof imageMessage.content === "string") throw new Error("expected an image user message");
    expect(imageMessage.content.filter((part) => part.type === "image_url")).toHaveLength(2);
  });

  test("an image-only tool result sends a placeholder rather than empty content", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
      { kind: "toolResult", toolUseId: "c1", content: [PNG] },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const toolMessage = out.find((m) => m.role === "tool");

    expect(toolMessage?.content).toBe("(see attached image)");
  });

  test("an empty tool result sends the no-output placeholder", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "noop", input: {} }] },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "" }] },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const toolMessage = out.find((m) => m.role === "tool");

    expect(toolMessage?.content).toBe("(no tool output)");
  });
});

describe("assistant messages", () => {
  test("lowers an incomplete fragment and settled tool continuation without changing canonical history", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      {
        kind: "assistant",
        content: [{ type: "text", text: "partial " }],
        incomplete: true,
        accessProvider: "openai_api",
        provider: "openai",
        model: "gpt-5",
        responseId: "response_partial",
      },
      {
        kind: "assistant",
        content: [
          { type: "thinking", thinking: "reason", signature: "reasoning_content" },
          { type: "tool_use", id: "canonical_call", providerCallId: "provider_call", name: "read", input: { path: "a.ts" } },
        ],
        accessProvider: "openai_api",
        provider: "openai",
        model: "gpt-5",
      },
      { kind: "toolResult", toolUseId: "canonical_call", content: [{ type: "text", text: "done" }] },
    ];
    const canonical = structuredClone(history);

    const out = toChatCompletionsMessages(history, false, openAIResponsesTarget("openrouter", "test-model"));

    expect(out.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    // The joined turn keeps no provider identity, so it replays no reasoning.
    expect(Object.hasOwn(out[1] ?? {}, "reasoning_content")).toBe(false);
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: "partial ",
      tool_calls: [{
        id: "provider_call",
        function: { name: "read", arguments: JSON.stringify({ path: "a.ts" }) },
      }],
    });
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "canonical_call", content: "done" });
    expect(history).toEqual(canonical);
  });

  test("adds a transient continuation instruction only for an incomplete assistant tail", () => {
    const incomplete: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "text", text: "partial" }], incomplete: true },
    ];
    const complete: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    expect(toChatCompletionsMessages(incomplete, false, openAIResponsesTarget("openrouter", "test-model")).at(-1)).toEqual({
      role: "user",
      content: "Continue the original request from the retained assistant output without repeating completed work.",
    });
    expect(toChatCompletionsMessages(complete, false, openAIResponsesTarget("openrouter", "test-model")).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(incomplete).toHaveLength(2);
  });

  test("an assistant message with neither content nor tool calls is skipped", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [] },
      { kind: "user", content: "still there?" },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));

    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("thinking captured on this API replays on its reasoning field", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      {
        kind: "assistant",
        ...LEGACY_CHAT_TURN,
        content: [
          { type: "thinking", thinking: "step one", signature: "reasoning_content" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const assistantMessage = out.find((m) => m.role === "assistant");

    expect(assistantMessage).toMatchObject({ content: "answer", reasoning_content: "step one" });
  });

  test("foreign thinking (an Anthropic signature) is withheld", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      {
        kind: "assistant",
        content: [
          { type: "thinking", thinking: "cross-provider thought", signature: "EqoBCkYIB..." },
          { type: "text", text: "answer" },
        ],
      },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const assistantMessage = out.find((m) => m.role === "assistant");

    expect(assistantMessage?.content).toBe("answer");
    expect(Object.hasOwn(assistantMessage ?? {}, "reasoning_content")).toBe(false);
  });

  test("an interleaved-reasoning model receives its reasoning field on every assistant message", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "c1", name: "bash", input: {} }] },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "one" }] },
      {
        kind: "assistant",
        ...LEGACY_CHAT_TURN,
        content: [
          { type: "thinking", thinking: "next step", signature: "reasoning_content" },
          { type: "tool_use", id: "c2", name: "bash", input: {} },
        ],
      },
      { kind: "toolResult", toolUseId: "c2", content: [{ type: "text", text: "two" }] },
    ];

    const assistants = (field: string | undefined) => toChatCompletionsMessages(history, true, openAIResponsesTarget("opencode_go", "test-model"), field).filter((m) => m.role === "assistant");

    expect(assistants("reasoning_content")).toMatchObject([
      { content: "checking", reasoning_content: "" },
      { content: null, reasoning_content: "next step" },
    ]);
    // A model without the declaration gets no field it did not stream.
    expect(Object.hasOwn(assistants(undefined)[0] ?? {}, "reasoning_content")).toBe(false);
  });

  test("a thinking-only assistant turn still sends its reasoning field", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", ...LEGACY_CHAT_TURN, accessProvider: "openrouter", content: [{ type: "thinking", thinking: "interrupted thought", signature: "reasoning" }] },
      { kind: "user", content: "continue" },
    ];

    const out = toChatCompletionsMessages(history, true, openAIResponsesTarget("openrouter", "test-model"));
    const assistantMessage = out.find((m) => m.role === "assistant");

    expect(assistantMessage).toMatchObject({ reasoning: "interrupted thought" });
  });
});

describe("user images", () => {
  test("a non-vision model gets an omitted-image placeholder instead of a dropped part", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "look" }, PNG] },
    ];

    const out = toChatCompletionsMessages(history, false, openAIResponsesTarget("openrouter", "test-model"));
    const userMessage = out[0];
    if (userMessage?.role !== "user" || typeof userMessage.content === "string") throw new Error("expected a parts array");

    expect(userMessage.content.some((part) => part.type === "image_url")).toBe(false);
    const text = userMessage.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
    expect(text).toContain("image/png");
  });
});

describe("transcript-only system notices", () => {
  test("system-kind messages never reach the completions wire", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "text", text: "done" }] },
      { kind: "system", content: "learning reconciliation notice" },
      { kind: "user", content: "next" },
    ];

    const out = toChatCompletionsMessages(history, false, openAIResponsesTarget("openrouter", "test-model"));

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("chat-completions stream normalization", () => {
  const info: ModelInfo = {
    provider: "openai", family: "openai", id: "gpt-5", name: "GPT-5", openWeights: false, reasoning: true,
    toolCall: true, attachment: false, temperature: true, contextLimit: 200_000, outputLimit: 64_000,
    cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
    modalities: { input: ["text"], output: ["text"] },
  };
  interface StreamChunk { [key: string]: unknown }
  const modelsClient: ModelsClient = {
    async refresh() {},
    getProviderCatalog(providerIds) {
      return providerIds.includes(info.provider) ? [{
        providerId: info.provider, providerName: info.provider, wireModelId: info.id, metadata: info,
        provenance: "bundled", canonical: { providerId: info.provider, modelId: info.id }, transport: null,
      }] : [];
    },
    getTokenizerIdentity() { return undefined; },
  };

  function clientWithStream(chunks: StreamChunk[], failure?: Error, beforeChunk?: (index: number) => void): OpenAI {
    async function* stream(): AsyncGenerator<StreamChunk> {
      for (const [index, chunk] of chunks.entries()) {
        beforeChunk?.(index);
        yield chunk;
      }
      if (failure) throw failure;
    }
    const client = new OpenAI({ apiKey: "test" });
    Object.defineProperty(client, "chat", {
      value: { completions: { create: async () => stream() } },
    });
    return client;
  }

  async function collect(client: OpenAI, observe?: (event: ProviderStreamEvent) => void): Promise<{ events: ProviderStreamEvent[]; error?: Error }> {
    const adapter = await createOpenAIChatCompletionsAdapter(client, "gpt-5", modelsClient, { resolvedModelMetadata: info });
    const events: ProviderStreamEvent[] = [];
    try {
      for await (const event of adapter.streamWithTools({
        messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt(""),
      })) {
        observe?.(event);
        events.push(event);
      }
      return { events };
    } catch (error) {
      return { events, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  test.each([
    { text: "", tool: false },
    { text: "", tool: true },
    { text: "hello", tool: false },
    { text: "hello", tool: true },
  ])("completes only nonempty text once at the stream or tool boundary: $text, $tool", async ({ text, tool }) => {
    const result = await collect(clientWithStream([
      { choices: [{ index: 0, delta: { content: text.slice(0, 2) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: text.slice(2) }, finish_reason: null }] },
      ...(tool ? [{
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "{}" } }] }, finish_reason: null }],
      }] : []),
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
    ]));

    expect(result.error).toBeUndefined();
    expect(result.events.map((event) => event.kind)).toEqual([
      "stream_attempt_start",
      "provider_response_started",
      ...(text ? ["text_delta", "text_delta", "text_complete"] as const : []),
      ...(tool ? ["tool_input_start", "tool_input_delta", "tool_use"] as const : []),
      "done",
    ]);
    // The attempt stamps the serving access provider on this identity, which history lowering replays to.
    expect(result.events.at(-1)).toMatchObject({ kind: "done", metadata: { api: "openai-responses", provider: "openai", model: "gpt-5" } });
    const deltas = result.events.filter((event) => event.kind === "text_delta");
    expect(deltas.map((event) => event.text).join("")).toBe(text);
    if (text) {
      expect(result.events.find((event) => event.kind === "text_complete")?.blockKey).toBe(deltas[0]?.blockKey);
    }
  });

  test("emits the latest cumulative usage before a terminal stream failure", async () => {
    const result = await collect(clientWithStream([{
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } },
    }], new Error("socket closed")));

    expect(result.error).toBeDefined();
    expect(result.events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({
      inputTokens: 100, outputTokens: 15, cacheReadTokens: 20, reasoningTokens: 5,
    })]);
  });

  test("emits no fabricated usage on failure and emits final usage once on success, with unreported cache reads as null", async () => {
    const failed = await collect(clientWithStream([], new Error("socket closed")));
    expect(failed.events.filter((event) => event.kind === "usage")).toHaveLength(0);

    const succeeded = await collect(clientWithStream([{
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }]));
    expect(succeeded.error).toBeUndefined();
    // The server omitted prompt_tokens_details, so cache reads are unknown and stay inside the input count.
    expect(succeeded.events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ final: true, inputTokens: 1, cacheReadTokens: null })]);
  });

  test.each([
    {
      label: "an initial known name",
      deltas: [
        { index: 0, id: "call_1", function: { name: "edit", arguments: "{\"path\":" } },
        { index: 0, function: { arguments: "\"a.ts\"}" } },
      ],
    },
    {
      label: "an id and index before a late name with same-delta arguments",
      deltas: [
        { index: 0, id: "call_1", function: {} },
        { index: 0, function: { name: "edit", arguments: "{\"path\":\"a.ts\"}" } },
      ],
    },
    {
      label: "arguments before a late name",
      deltas: [
        { index: 0, id: "call_1", function: { arguments: "{\"path\":" } },
        { index: 0, function: { arguments: "\"a.ts\"" } },
        { index: 0, function: { name: "apply_patch", arguments: "}" } },
      ],
    },
    {
      label: "all arguments before a name-only delta",
      deltas: [
        { index: 0, id: "call_1", function: { arguments: "{\"path\":" } },
        { index: 0, function: { arguments: "\"a.ts\"}" } },
        { index: 0, function: { name: "apply_patch" } },
      ],
    },
  ])("emits one named start before all argument bytes for $label", async ({ deltas }) => {
    const finalFunction = deltas.at(-1)?.function;
    const expectedName = finalFunction && "name" in finalFunction ? finalFunction.name : "edit";
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const counted: string[] = [];
    const measurement = createGenerationMeasurement({
      prepare: async () => {},
      tokenizer: () => ({ identity: "O200kBase", count(text) { counted.push(text); return text.length; } }),
    });
    const result = await collect(clientWithStream([
      ...deltas.map((toolCall) => ({
        choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
      })),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ], undefined, (index) => { now = 100 + index * 20; }), (event) => measurement.observe(event, now))
      .finally(() => clock.mockRestore());
    const generatedChunks = deltas.filter((delta) => "arguments" in delta.function && delta.function.arguments).length;
    expect(await measurement.complete()).toMatchObject({
      outputTokens: generatedChunks > 1 ? 15 : 0,
      durationMs: generatedChunks > 1 ? (generatedChunks - 1) * 20 : 0,
      measuredBlocks: generatedChunks > 1 ? 1 : 0,
      excludedBlocks: generatedChunks > 1 ? 0 : 1,
    });
    expect(counted).toEqual(generatedChunks > 1 ? ['{"path":"a.ts"}'] : []);

    expect(result.error).toBeUndefined();
    const streamedToolInput = result.events.filter(
      (event) => event.kind === "tool_input_start" || event.kind === "tool_input_delta",
    );
    expect(streamedToolInput[0]).toEqual({
      kind: "tool_input_start",
      toolUseId: "call_1",
      name: expectedName,
    });
    expect(streamedToolInput.filter((event) => event.kind === "tool_input_start")).toHaveLength(1);
    expect(streamedToolInput.filter((event) => event.kind === "tool_input_delta").map((event) => event.partialJson).join("")).toBe(
      "{\"path\":\"a.ts\"}",
    );
    expect(result.events.find((event) => event.kind === "tool_use")).toEqual({
      kind: "tool_use",
      toolCall: {
        id: "call_1",
        name: expectedName,
        input: { path: "a.ts" },
        providerCallId: "call_1",
      },
    });
  });

  test("retains an unnamed malformed final tool call without emitting a stream start", async () => {
    const result = await collect(clientWithStream([
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_unnamed", function: { arguments: "{" } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]));

    expect(result.events.some(
      (event) => event.kind === "tool_input_start" || event.kind === "tool_input_delta",
    )).toBeFalse();
    // A lone `{` is a cut prefix, so the call carries the refusal the
    // dispatcher answers with instead of executing on empty input.
    expect(result.events.find((event) => event.kind === "tool_use")).toEqual({
      kind: "tool_use",
      toolCall: {
        id: "call_unnamed",
        name: "",
        input: {},
        providerCallId: "call_unnamed",
        inputParseError: expect.stringContaining("incomplete JSON"),
      },
    });
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { openAIResponsesTarget } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
