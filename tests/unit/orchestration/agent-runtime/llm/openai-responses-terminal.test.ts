/**
 * Terminal-frame handling on the OpenAI Responses stream.
 *
 * The API-key path receives the SDK's `response.incomplete` event for a
 * truncated or filtered response; the ChatGPT backend SSE path receives the
 * backend wire's legacy `response.done` / `response.incomplete` frames, which
 * the boundary mapper normalizes to `response.completed`. Both must finalize
 * the response (usage, stop reason) instead of falling through to a bogus
 * "stream closed before response.completed" transient error.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Redacted } from "effect";
import type { OpenAIAuth } from "../../../../../src/infra/auth/openai-auth-types.js";
import type { LLMClient, StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { collectStreamEvents, installChatGptAdapterModuleMocks, state, stubModelsClient } from "./_openai-chatgpt-adapter-fixtures.js";

installChatGptAdapterModuleMocks();

const API_KEY_AUTH: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") };
const CHATGPT_AUTH: OpenAIAuth = {
  kind: "chatgpt",
  accessToken: Redacted.make("test-access"),
  refreshToken: Redacted.make("test-refresh"),
  expiresAtMs: Date.now() + 3_600_000,
};

const USAGE = {
  input_tokens: 900,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 42,
  output_tokens_details: { reasoning_tokens: 0 },
};

function incompleteResponse(reason: "max_output_tokens" | "content_filter") {
  return {
    id: "resp_incomplete",
    status: "incomplete",
    incomplete_details: { reason },
    usage: USAGE,
    output: [],
  };
}

async function collectWithError(
  client: LLMClient,
): Promise<{ events: StreamEvent[]; error: Error | undefined }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      tools: [],
      systemPrompt: stableSystemPrompt(""),
    })) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

describe("OpenAI Responses terminal frames", () => {
  let createOpenAIAdapter: typeof import("../../../../../src/orchestration/agent-runtime/llm/openai.js").createOpenAIAdapter;

  beforeEach(async () => {
    state.streamEvents = [];
    state.webSocketStreamEvents = undefined;
    state.lastResponsesCreateParams = undefined;
    state.ensureFreshCalls = [];
    state.invocationOrder = [];
    state.ensureFreshImpl = undefined;
    const mod = await import("../../../../../src/orchestration/agent-runtime/llm/openai.js");
    createOpenAIAdapter = mod.createOpenAIAdapter;
  });

  // Only a stated minimum lifetime is retention evidence; the echoed retention policy bounds only the maximum.
  it.each([
    ["ttl 30m", { prompt_cache_options: { ttl: "30m" } }, 1_800_000],
    ["ttl 12h", { prompt_cache_options: { ttl: "12h" } }, 43_200_000],
    ["ttl 30m beside policy 24h", { prompt_cache_options: { ttl: "30m" }, prompt_cache_retention: "24h" }, 1_800_000],
    ["policy 24h alone", { prompt_cache_retention: "24h" }, null],
    ["policy in_memory alone", { prompt_cache_retention: "in_memory" }, null],
    ["unknown ttl", { prompt_cache_options: { ttl: "5m" } }, null],
    ["explicit mode", { prompt_cache_options: { mode: "explicit" } }, null],
  ] as const)("reads cache retention only from a stated lifetime: %s", async (_name, fields, retentionMs) => {
    state.streamEvents = [{
      type: "response.completed",
      response: { id: "retention", status: "completed", usage: USAGE, output: [], ...fields },
    }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());
    const events = await collectStreamEvents(client);
    const usage = events.find((event) => event.kind === "usage");
    expect(usage?.kind === "usage" ? usage.cacheRetentionMs : undefined).toBe(retentionMs);
    expect(usage).toMatchObject({ final: true, inputTokens: 800, cacheReadTokens: 100 });
  });

  it("reports cache reads that a gateway omitted as null inside the input count, never as zero", async () => {
    const { input_tokens_details: _details, ...unreported } = USAGE;
    state.streamEvents = [{ type: "response.completed", response: { id: "unreported", status: "completed", usage: unreported, output: [] } }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());
    const events = await collectStreamEvents(client);
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ final: true, inputTokens: 900, cacheReadTokens: null })]);
  });

  it("settles dispatch before OpenAI Responses SSE invocation and rejects before invocation", async () => {
    state.streamEvents = [{ type: "response.completed", response: { id: "resp", status: "completed", usage: USAGE, output: [] } }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    await collectStreamEvents(client, { onDispatch: async () => { state.invocationOrder.push("settled"); } });
    expect(state.invocationOrder).toEqual(["settled", "sse"]);

    state.invocationOrder = [];
    await expect(collectStreamEvents(client, { onDispatch: async () => { throw new Error("dispatch rejected"); } })).rejects.toThrow("dispatch rejected");
    expect(state.invocationOrder).toEqual([]);
  });

  it("settles dispatch before OpenAI Responses WebSocket invocation and rejects before invocation", async () => {
    state.webSocketStreamEvents = [{ type: "response.completed", response: { id: "resp", status: "completed", usage: USAGE, output: [] } }];
    const client = await createOpenAIAdapter(CHATGPT_AUTH, "gpt-5.4", stubModelsClient());

    await collectStreamEvents(client, { onDispatch: async () => { state.invocationOrder.push("settled"); } });
    expect(state.invocationOrder).toEqual(["settled", "websocket"]);

    state.invocationOrder = [];
    state.webSocketStreamEvents = [{ type: "response.completed", response: { id: "unused", status: "completed", usage: USAGE, output: [] } }];
    await expect(collectStreamEvents(client, { onDispatch: async () => { throw new Error("dispatch rejected"); } })).rejects.toThrow("dispatch rejected");
    expect(state.invocationOrder).toEqual([]);
  });

  it("API-key path: response.incomplete (max_output_tokens) emits usage then OutputLengthExceededError", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_incomplete" } },
      { type: "response.output_text.delta", delta: "partial", output_index: 0 },
      { type: "response.incomplete", response: incompleteResponse("max_output_tokens") },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events, error } = await collectWithError(client);

    expect(error).toMatchObject({ name: "ProviderAttemptFailure", failure: { _tag: "OutputOverflowFailure" } });
    const usage = events.find((event) => event.kind === "usage");
    expect(usage).toMatchObject({
      inputTokens: 800,
      outputTokens: 42,
      cacheReadTokens: 100,
    });
  });

  it("response.failed emits its final usage before the terminal error", async () => {
    state.streamEvents = [{
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        usage: USAGE,
        output: [],
        error: { code: "server_error", message: "failed after billing" },
      },
    }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events, error } = await collectWithError(client);

    expect(error).toBeDefined();
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ inputTokens: 800, outputTokens: 42 })]);
  });

  it("response.failed emits no usage when the provider omits usage", async () => {
    state.streamEvents = [{
      type: "response.failed",
      response: { id: "resp_failed", status: "failed", output: [], error: { code: "server_error", message: "failed" } },
    }];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events } = await collectWithError(client);

    expect(events.filter((event) => event.kind === "usage")).toHaveLength(0);
  });

  it("API-key path: response.incomplete (content_filter) finalizes with stopReason content_filter", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_incomplete" } },
      { type: "response.incomplete", response: incompleteResponse("content_filter") },
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const done = events.find((event) => event.kind === "done");
    expect(done).toMatchObject({ stopReason: "content_filter" });
    expect(events.some((event) => event.kind === "usage")).toBe(true);
  });

  it("ChatGPT SSE path: legacy response.done frame finalizes as a completed response", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_done" } },
      { type: "response.output_text.delta", delta: "hello", output_index: 0 },
      {
        type: "response.done",
        response: { id: "resp_done", status: "completed", usage: USAGE, output: [] },
      },
    ];
    const client = await createOpenAIAdapter(CHATGPT_AUTH, "gpt-5.4", stubModelsClient());

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const done = events.find((event) => event.kind === "done");
    expect(done).toMatchObject({ stopReason: "end_turn" });
    expect(events.some((event) => event.kind === "usage")).toBe(true);
  });

  it("a caller abort that tears the stream surfaces as an abort, not a transient failure", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_aborted" } },
      { type: "response.output_text.delta", delta: "partial", output_index: 0 },
      // No terminal frame: the abort tore the stream down mid-response.
    ];
    const client = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", stubModelsClient());

    const controller = new AbortController();
    const events: StreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of client.streamWithTools({
        messages: [{ kind: "user", content: "hi" }],
        tools: [],
        systemPrompt: stableSystemPrompt(""),
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.kind === "text_delta") controller.abort();
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect(events).toContainEqual(expect.objectContaining({ kind: "text_delta", text: "partial" }));
    if (caught instanceof DOMException) expect(caught.name).toBe("AbortError");
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
