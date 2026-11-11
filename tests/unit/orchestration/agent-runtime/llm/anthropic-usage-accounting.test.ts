/**
 * Anthropic adapter usage accounting and max_tokens clamping.
 *
 * Billing must survive failure: the prompt is charged at message_start, so
 * failed and truncated attempts report usage before their error propagates
 * (pi `anthropic-messages.ts:578-586,:760-769`). max_tokens is
 * clamped to the remaining context window (`simple-options.ts:15-19`), and the
 * 1h cache-write split and thinking-token subset ride the usage event.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { wireResponse } from "./_wire-fixtures.js";
import { Redacted } from "effect";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { join } from "node:path";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { createAnthropicAdapter, HOSTED_MAX_TOKENS, operationsFromAnthropicClient, prepareAnthropicRequest, type AnthropicOperations } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { supportsAdaptiveThinking } from "../../../../../src/orchestration/agent-runtime/llm/model-compat.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import type { LLMClient, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

interface UnknownRecord {
  [key: string]: unknown;
}

const MODEL_INFO: ModelInfo = {
  provider: "anthropic",
  family: "anthropic",
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: true,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 200_000,
  outputLimit: 64_000,
};


let streamEvents: Array<UnknownRecord> = [];
/** Set by a test to make the fake stream die after its events. */
let failStream: (() => void) | undefined;
let lastCreateParams: UnknownRecord | undefined;
let createStreamError: Error | undefined;

const sdkOperations = operationsFromAnthropicClient(new Anthropic({
  apiKey: "test-key",
  maxRetries: 0,
  fetch: async (input, init) => {
    const request = new Request(input, init);
    lastCreateParams = z.record(z.string(), z.unknown()).parse(await request.json());
    let failure: Error | undefined;
    try { failStream?.(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
    }
    return wireResponse(streamEvents, failure);
  },
}));
const fakeAnthropicOperations: AnthropicOperations = {
  ...sdkOperations,
  async createStream(params, options) {
    if (createStreamError) throw new Error("SDK request failed", { cause: createStreamError });
    return sdkOperations.createStream(params, options);
  },
};

function createTestAnthropicAdapter(_apiKey: string, _model: string, info: ModelInfo): Promise<LLMClient> {
  return createAnthropicAdapter(Redacted.make("[redacted secret]"), "claude-opus-4-8", info, { operations: fakeAnthropicOperations });
}

async function collectWithError(
  client: LLMClient,
  overrides: Partial<Parameters<LLMClient["streamWithTools"]>[0]> = {},
): Promise<{ events: ProviderStreamEvent[]; error: Error | undefined }> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      systemPrompt: stableSystemPrompt("system"),
      tools: [],
      reasoningEffort: "off",
      ...overrides,
    })) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { events, error };
  }
}

const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_test",
    usage: {
      input_tokens: 1_000,
      output_tokens: 0,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
    },
  },
};

describe("Anthropic usage accounting", () => {
  beforeEach(() => {
    streamEvents = [];
    failStream = undefined;
    lastCreateParams = undefined;
    createStreamError = undefined;
  });

  it.each([
    { source: "start", value: 400, fiveMinutes: 100, count: 400, retention: 3_600_000 },
    { source: "start", value: "400", fiveMinutes: 100, count: 400, retention: 3_600_000 },
    { source: "start", value: true, fiveMinutes: 100, count: 0, retention: null },
    { source: "start", value: 0, fiveMinutes: 100, count: 0, retention: 300_000 },
    { source: "start", value: 0, fiveMinutes: 0, count: 0, retention: undefined },
    { source: "start", value: 0, fiveMinutes: "100", count: 0, retention: 300_000 },
    { source: "start", value: 0, fiveMinutes: true, count: 0, retention: null },
    { source: "delta", value: "400", fiveMinutes: 100, count: 400, retention: 3_600_000 },
    { source: "delta", value: true, fiveMinutes: 100, count: 0, retention: null },
    { source: "delta", value: 0, fiveMinutes: 100, count: 0, retention: 300_000 },
  ])("normalizes the $source cache-write split before reporting retention", async ({ source, value, fiveMinutes, count, retention }) => {
    streamEvents = [
      {
        ...MESSAGE_START,
        message: {
          ...MESSAGE_START.message,
          usage: {
            ...MESSAGE_START.message.usage,
            cache_creation: { ephemeral_5m_input_tokens: fiveMinutes, ephemeral_1h_input_tokens: source === "start" ? value : 400 },
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 30 },
          ...(source === "delta" ? { cache_creation: { ephemeral_5m_input_tokens: fiveMinutes, ephemeral_1h_input_tokens: value } } : {}),
        },
      },
      { type: "message_stop" },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const usages = events.filter((event) => event.kind === "usage");
    expect(usages.length).toBe(1);
    expect(usages.at(-1)).toMatchObject({
      final: true,
      inputTokens: 1_000,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreateTokens: 500,
      cacheCreate1hTokens: count,
      reasoningTokens: 30,
    });
    expect(usages.at(-1)?.cacheRetentionMs).toBe(retention);
  });

  it("reports usage for a truncated (max_tokens) attempt before the error propagates", async () => {
    streamEvents = [
      MESSAGE_START,
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64_000 } },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toMatchObject({ name: "ProviderAttemptFailure", failure: { _tag: "OutputOverflowFailure" } });
    const usage = events.filter((event) => event.kind === "usage").at(-1);
    // message_delta carried the terminal report, so the truncated attempt's usage is final.
    expect(usage).toMatchObject({ final: true, inputTokens: 1_000, outputTokens: 64_000 });
  });

  it("reports usage for an attempt that dies on a non-retryable stream error", async () => {
    streamEvents = [MESSAGE_START];
    failStream = () => { throw new Anthropic.BadRequestError(400, { error: { message: "prompt is too long" } }, "prompt is too long", new Headers()); };
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "ContextOverflowFailure" } });
    const usage = events.filter((event) => event.kind === "usage").at(-1);
    // Only message_start was seen, so the report is not the provider's final one and settles as partial.
    expect(usage).toMatchObject({ final: false, inputTokens: 1_000, cacheCreateTokens: 500 });
  });

  it("emits no usage when a failed attempt reports no provider usage", async () => {
    failStream = () => { throw new Anthropic.BadRequestError(400, { error: { message: "prompt is too long" } }, "prompt is too long", new Headers()); };
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "ContextOverflowFailure" } });
    expect(events.filter((event) => event.kind === "usage")).toHaveLength(0);
  });

  it("normalizes a wrapped SDK quota error at the send boundary", async () => {
    const quota = new Anthropic.APIError(
      429,
      { error: { message: "Quota exceeded for premium requests on this account." } },
      "Quota exceeded for premium requests on this account.",
      new Headers(),
    );
    createStreamError = new Error("Anthropic SDK request failed", { cause: quota });
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(events.filter((event) => event.kind === "usage")).toHaveLength(0);
    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure", cause: expect.any(QuotaExhaustedError) } });
  });

  it("normalizes an external error frame and retains observed usage", async () => {
    streamEvents = [
      MESSAGE_START,
      { type: "error", error: { type: "overloaded_error", message: "Anthropic is overloaded" } },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "OverloadedFailure" } });
    expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
  });

  it("hands a transport's context to the attempt as its own event, also when the service's stream then fails", async () => {
    streamEvents = [
      MESSAGE_START,
      { type: "error", error: { type: "overloaded_error", message: "Anthropic is overloaded" } },
    ];
    const context = { identity: "claude-engine", additions: [{ part: "system", kind: "billing", at: 0 }], hiddenRequests: [], notRecorded: [] } as const;
    const operations: AnthropicOperations = {
      ...fakeAnthropicOperations,
      async createStream(params, options) {
        const sent = await fakeAnthropicOperations.createStream(params, options);
        const events = sent.data;
        async function* withContext() {
          yield { type: "transport_context", context } as const;
          yield* events;
        }
        return { ...sent, data: Object.assign(withContext(), { controller: events.controller }) };
      },
    };
    const client = await createAnthropicAdapter(Redacted.make("[redacted secret]"), "claude-opus-4-8", MODEL_INFO, { operations });

    const { events, error } = await collectWithError(client);

    expect(events.filter((event) => event.kind === "transport_context")).toEqual([{ kind: "transport_context", context }]);
    expect(error).toMatchObject({ failure: { _tag: "OverloadedFailure" } });
  });

  it("lets local telemetry conversion failures escape untouched", async () => {
    streamEvents = [MESSAGE_START];
    const localFailure = new Error("local telemetry failed");
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { error } = await collectWithError(client, {
      telemetry: { observe() { throw localFailure; } },
    });

    expect(error).toBe(localFailure);
  });

  it("maps model_context_window_exceeded to max_tokens truncation semantics", async () => {
    streamEvents = [
      MESSAGE_START,
      { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 10 } },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { error } = await collectWithError(client);

    expect(error).toMatchObject({ name: "ProviderAttemptFailure", failure: { _tag: "OutputOverflowFailure" } });
  });

  it("maps an unknown stop_reason to \"unknown\" instead of leaking the raw wire value", async () => {
    streamEvents = [
      MESSAGE_START,
      { type: "message_delta", delta: { stop_reason: "some_future_reason" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const done = events.find((event) => event.kind === "done");
    expect(done).toMatchObject({ stopReason: "unknown" });
  });

  it("surfaces the refusal explanation as a provider_status notice", async () => {
    streamEvents = [
      MESSAGE_START,
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { explanation: "cannot help with that request" } },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const status = events.find((event) => event.kind === "provider_status");
    expect(status).toMatchObject({ level: "error" });
    expect(status?.kind === "provider_status" && status.message).toContain("cannot help with that request");
    const done = events.find((event) => event.kind === "done");
    expect(done).toMatchObject({ stopReason: "content_filter" });
  });

  it("does not report an empty stream as successful after caller cancellation", async () => {
    const caller = new AbortController();
    failStream = () => { caller.abort(new Error("caller cancelled")); };
    const client = await createTestAnthropicAdapter("[redacted secret]", "claude-opus-4-8", MODEL_INFO);

    const { events, error } = await collectWithError(client, { signal: caller.signal });

    expect(error?.message).toBe("caller cancelled");
    expect(events.some((event) => event.kind === "done")).toBe(false);
  });
});

describe("Anthropic max_tokens context clamp", () => {
  const directory = temporaryDirectories();
  beforeEach(() => {
    streamEvents = [
      MESSAGE_START,
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    failStream = undefined;
    lastCreateParams = undefined;
  });

  it("keeps the throughput cap when the context window has room", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    await collectWithError(client, { estimatedContextTokens: 10_000 });

    expect(lastCreateParams?.max_tokens).toBe(32_000);
  });

  it("clamps max_tokens to the remaining context window near the limit", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    await collectWithError(client, { estimatedContextTokens: 190_000 });

    // 200_000 - 190_000 - 4_096 safety = 5_904
    expect(lastCreateParams?.max_tokens).toBe(5_904);
  });

  it("sends the hosted cap for every adaptive Claude model of the bundled catalog, also near the context limit", () => {
    // A shared engine agent host fixes max_tokens at launch, so the hosted cap may not vary by model or context:
    // the model's output limit bounds it, and no adaptive model of the catalog has a smaller one.
    const rows = createModelsClient(join(directory("hosted-cap-"), "models.json")).getProviderCatalog(["anthropic"], 1_000)
      .filter((row) => supportsAdaptiveThinking(row.wireModelId, row.metadata));
    expect(rows.length).toBeGreaterThan(0);
    for (const { wireModelId, metadata } of rows) {
      const contextLimit = metadata.contextLimit ?? 200_000;
      const prepare = (hostedMaxTokens: boolean) => prepareAnthropicRequest({
        accessProvider: "claude-agent-sdk", model: wireModelId, wireModel: wireModelId, info: metadata, contextLimit, hosted: hostedMaxTokens,
        options: { messages: [{ kind: "user", content: "hi" }], systemPrompt: stableSystemPrompt("system"), tools: [], estimatedContextTokens: contextLimit - 10_000 },
      }).params.max_tokens;
      expect({ wireModelId, maxTokens: prepare(true) }).toEqual({ wireModelId, maxTokens: HOSTED_MAX_TOKENS });
      expect(prepare(false)).toBeLessThan(HOSTED_MAX_TOKENS);
    }
  });

  it("keeps the cap when no context estimate is provided", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-opus-4-8", MODEL_INFO);

    await collectWithError(client);

    expect(lastCreateParams?.max_tokens).toBe(32_000);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
