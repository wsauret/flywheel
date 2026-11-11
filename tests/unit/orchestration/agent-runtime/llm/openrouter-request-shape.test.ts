/**
 * Chat-completions request assembly for OpenRouter and Copilot.
 *
 * OpenRouter needs the Anthropic cache_control markers for anthropic/ models
 * (pi `openai-completions.ts:894-996,:1443`), a nested reasoning
 * object with an explicit off (`:784-793`), and `tools: []` when the history
 * carries tool traffic (`:730-733`). Usage reads the cache-write and
 * reasoning-token fields (`:1326-1362`), and an unexpected finish_reason
 * throws instead of finalizing a broken turn as success (`:1364-1388`).
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { openRouterReportedChargeUsd } from "../../../../../src/orchestration/modules/provider-openrouter/usage-charge.js";

/** The provider module passes the wire id it resolved from its catalog; the
 *  adapter never folds one itself. */
const OPENROUTER = { accessProvider: "openrouter", providerHint: "openrouter", wireModelId: "anthropic/claude-opus-4.8", reportedChargeUsd: openRouterReportedChargeUsd } as const;
import type { ConversationMessage, ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";

interface UnknownRecord { [key: string]: unknown }
import { wireClient } from "./_wire-fixtures.js";

const REASONING_INFO: ModelInfo = {
  provider: "openrouter",
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

interface Capture { params?: UnknownRecord; invocationOrder?: string[]; iteratorError?: Error }

function capturingClient(capture: Capture, chunks: Array<UnknownRecord>): OpenAI {
  return wireClient(chunks, (params) => {
    capture.invocationOrder?.push("sdk");
    capture.params = params;
  }, capture.iteratorError);
}

const FINISH_CHUNK = {
  id: "chatcmpl_1",
  choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
};

async function drain(
  client: Awaited<ReturnType<typeof createOpenAIChatCompletionsAdapter>>,
  overrides: Partial<StreamOptions> = {},
): Promise<{ events: ProviderStreamEvent[]; error: Error | undefined }> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      tools: [],
      systemPrompt: stableSystemPrompt("sys"),
      ...overrides,
    })) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

test("OpenAI Completions settles dispatch before SDK invocation and rejection prevents invocation", async () => {
  const capture: Capture = { invocationOrder: [] };
  const adapter = await createOpenAIChatCompletionsAdapter(capturingClient(capture, [FINISH_CHUNK]), "claude-opus-4-8", REASONING_INFO, OPENROUTER);

  await drain(adapter, { onDispatch: async () => { capture.invocationOrder?.push("settled"); } });
  expect(capture.invocationOrder).toEqual(["settled", "sdk"]);

  capture.invocationOrder = [];
  const result = await drain(adapter, { onDispatch: async () => { throw new Error("dispatch rejected"); } });
  expect(result.error?.message).toBe("dispatch rejected");
  expect(capture.invocationOrder).toEqual([]);
});

test.each([
  ["openrouter" as const, "openrouter"],
  ["github_copilot" as const, "github-copilot"],
])("%s projects apply_patch through its function presenter and wire serializer", async (accessProvider, providerHint) => {
  const capture: Capture = {};
  const adapter = await createOpenAIChatCompletionsAdapter(
    capturingClient(capture, [FINISH_CHUNK]),
    "claude-opus-4-8",
    REASONING_INFO,
    { accessProvider, providerHint },
  );
  const applyPatch = {
    name: "apply_patch",
    description: "A FREEFORM tool",
    input_schema: { type: "object", properties: { input: { type: "string" } } },
    wire: { kind: "custom" as const, grammar: { syntax: "lark" as const, definition: "start: \"*** Begin Patch\"" }, functionDescription: "Put the patch in the input string" },
  };

  expect(adapter.toolPresentation.present(applyPatch)).toEqual({ kind: "function", description: "Put the patch in the input string", inputFormat: applyPatch.input_schema });
  await drain(adapter, { tools: [applyPatch] });
  expect(capture.params?.tools).toEqual([expect.objectContaining({
    type: "function",
    function: { name: "apply_patch", description: "Put the patch in the input string", parameters: applyPatch.input_schema },
  })]);
});

describe("OpenRouter anthropic cache_control", () => {
  test.each([["1h", 3], ["5m", 0]] as const)("marks the system prompt, last tool, and last message for anthropic/ models with lifetime %s", async (cacheRetention, oneHourMarks) => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter, {
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
      cacheRetention,
    });

    const markers = JSON.stringify(capture.params).match(/"cache_control"/g) ?? [];
    expect(markers).toHaveLength(3);
    expect(JSON.stringify(capture.params).match(/"ttl":"1h"/g) ?? []).toHaveLength(oneHourMarks);
  });

  test("sends no markers for a non-anthropic OpenRouter model", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "gemini-3.5-flash",
      { ...REASONING_INFO, id: "gemini-3.5-flash" },
      { ...OPENROUTER, wireModelId: "google/gemini-3.5-flash" },
    );

    await drain(adapter);

    expect(JSON.stringify(capture.params)).not.toContain("cache_control");
  });

  test("sends no markers when caching is disabled", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter, { cacheRetention: "none" });

    expect(JSON.stringify(capture.params)).not.toContain("cache_control");
  });
});

describe("OpenRouter reasoning params", () => {
  test("sends a nested reasoning object when reasoning is on", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter, { reasoningEffort: "high" });

    expect(capture.params?.reasoning).toEqual({ effort: "high" });
    expect(capture.params?.reasoning_effort).toBeUndefined();
  });

  test("sends an explicit off so default-on mirrors actually disable reasoning", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter, { reasoningEffort: "off" });

    expect(capture.params?.reasoning).toEqual({ effort: "none" });
  });

  test("omits reasoning entirely for an always-thinking model", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-fable-5",
      { ...REASONING_INFO, id: "claude-fable-5" },
      OPENROUTER,
    );

    await drain(adapter, { reasoningEffort: "off" });

    expect(capture.params?.reasoning).toBeUndefined();
  });

  test("non-OpenRouter endpoints keep the flat reasoning_effort field", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "gpt-5.5",
      { ...REASONING_INFO, provider: "openai", id: "gpt-5.5" },
      { accessProvider: "openai_api" },
    );

    await drain(adapter, { reasoningEffort: "high" });

    expect(capture.params?.reasoning_effort).toBe("high");
    expect(capture.params?.reasoning).toBeUndefined();
  });

  test("a model that declares its tiers gets the nearest declared tier, so max stays max", async () => {
    const deepseek = { ...REASONING_INFO, provider: "opencode-go", id: "deepseek-v4.1-flash", reasoningEfforts: ["low", "high", "max"] } as const;
    const sent = async (reasoningEffort: "max" | "ultra" | "xhigh") => {
      const capture: Capture = {};
      const adapter = await createOpenAIChatCompletionsAdapter(capturingClient(capture, [FINISH_CHUNK]), "deepseek-v4.1-flash", deepseek, { accessProvider: "opencode_go" });
      await drain(adapter, { reasoningEffort });
      return capture.params?.reasoning_effort;
    };

    expect(await sent("max")).toBe("max");
    expect(await sent("ultra")).toBe("max");
    // A tie rounds down, as on the Responses path.
    expect(await sent("xhigh")).toBe("high");
  });
});

describe("DeepSeek thinking params", () => {
  const deepseek = { ...REASONING_INFO, provider: "deepseek", id: "deepseek-v4-pro", reasoningEfforts: ["low", "high", "max"] } as const;
  const sent = async (overrides: Partial<StreamOptions>) => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(capturingClient(capture, [FINISH_CHUNK]), "deepseek-v4-pro", deepseek, { accessProvider: "deepseek" });
    await drain(adapter, overrides);
    return capture.params;
  };
  const record = { name: "record", description: "Record a number", input_schema: { type: "object" } };

  test("effort on enables thinking and sends the nearest declared tier", async () => {
    const params = await sent({ reasoningEffort: "medium" });
    expect(params?.thinking).toEqual({ type: "enabled" });
    expect(params?.reasoning_effort).toBe("low");
  });

  test("effort off sends an explicit disable, because DeepSeek thinks by default", async () => {
    const params = await sent({ reasoningEffort: "off" });
    expect(params?.thinking).toEqual({ type: "disabled" });
    expect(params?.reasoning_effort).toBeUndefined();
  });

  test.each([
    ["a named tool", { type: "tool", name: "record" } as const],
    ["any tool", "any" as const],
  ])("forcing %s disables thinking whatever the effort", async (_label, toolChoice) => {
    const params = await sent({ reasoningEffort: "low", tools: [record], toolChoice });
    expect(params?.thinking).toEqual({ type: "disabled" });
    expect(params?.reasoning_effort).toBeUndefined();
  });

  test("an automatic tool choice keeps thinking on", async () => {
    const params = await sent({ reasoningEffort: "high", tools: [record] });
    expect(params?.thinking).toEqual({ type: "enabled" });
    expect(params?.tool_choice).toBe("auto");
  });

  test("sends the output cap as max_tokens", async () => {
    const params = await sent({ outputTokenLimit: 1_500 });
    expect(params?.max_tokens).toBe(1_500);
    expect(params?.max_completion_tokens).toBeUndefined();
  });
});

describe("OpenRouter provider routing", () => {
  const routing = {
    allow_fallbacks: true,
    data_collection: "deny" as const,
    order: ["Anthropic"],
    sort: { by: "price", partition: null },
    max_price: { prompt: "1", completion: 2 },
    preferred_min_throughput: { p90: 20 },
    preferred_max_latency: 500,
  };

  test("maps the routing shape unchanged to the top-level provider field", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]), "claude-opus-4-8", REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter, { providerOptions: { openrouter: routing } });

    expect(capture.params?.provider).toEqual(routing);
  });

  test("does not map OpenRouter routing for another access provider", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]), "gpt-5.5",
      { ...REASONING_INFO, provider: "openai", id: "gpt-5.5" },
      { accessProvider: "openai_api" },
    );

    await drain(adapter, { providerOptions: { openrouter: routing } });

    expect(capture.params?.provider).toBeUndefined();
  });

  test("transmits the provider-owned output cap used by admission", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]), "claude-opus-4-8", REASONING_INFO,
      { ...OPENROUTER, providerOutputCap: 12_345 },
    );

    await drain(adapter);

    expect(capture.params?.max_completion_tokens).toBe(12_345);
  });
});

describe("chat-completions request invariants", () => {
  test("sends tools:[] when history carries tool traffic but no tools are offered", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );
    const messages: ConversationMessage[] = [
      { kind: "user", content: "go" },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "ok" }] },
    ];

    await drain(adapter, { messages });

    expect(capture.params?.tools).toEqual([]);
  });

  test("omits tools when the history has no tool traffic", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [FINISH_CHUNK]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    await drain(adapter);

    expect(capture.params?.tools).toBeUndefined();
  });
});

describe("chat-completions usage and finish reasons", () => {
  test("normalizes an iterator failure at the provider attempt boundary", async () => {
    const capture: Capture = { iteratorError: new Error("socket hang up") };
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, []),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { error } = await drain(adapter);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    if (!(error instanceof ProviderAttemptFailure)) throw new Error("expected ProviderAttemptFailure");
    expect(error.failure._tag).toBe("TransientNetworkFailure");
    expect(error.cause).toBe(capture.iteratorError);
  });

  test("reads cache-write and reasoning token fields", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [{
        id: "chatcmpl_1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events } = await drain(adapter);

    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheCreateTokens: 300,
      reasoningTokens: 40,
    });
  });

  test.each([
    { label: "the charge the response reports", usage: { cost: 0.0012, is_byok: false, cost_details: { upstream_inference_cost: 0.0011 } }, reportedChargeUsd: 0.0012 },
    { label: "the fee plus the upstream cost when the request used the account's own provider key", usage: { cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } }, reportedChargeUsd: 0.0021 },
    { label: "a charge of zero for a request that cost nothing", usage: { cost: 0, is_byok: false }, reportedChargeUsd: 0 },
    { label: "no charge when the response reports none", usage: {}, reportedChargeUsd: undefined },
  ])("the usage event carries $label", async ({ usage, reportedChargeUsd }) => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [{ ...FINISH_CHUNK, usage: { ...FINISH_CHUNK.usage, ...usage } }]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events } = await drain(adapter);

    const usageEvent = events.find((event) => event.kind === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.kind !== "usage") throw new Error("expected a usage event");
    if (reportedChargeUsd === undefined) expect(usageEvent).not.toHaveProperty("reportedChargeUsd");
    else expect(usageEvent.reportedChargeUsd).toBeCloseTo(reportedChargeUsd, 12);
  });

  test("finish_reason length is an output overflow, not a completed max_tokens turn", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [
        { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_cut", function: { name: "write", arguments: "{\"path\":\"a.ts\",\"content\":\"cut" } }] }, finish_reason: null }] },
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events, error } = await drain(adapter);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    if (!(error instanceof ProviderAttemptFailure)) throw new Error("expected ProviderAttemptFailure");
    expect(error.failure._tag).toBe("OutputOverflowFailure");
    // The cut call is still observed, but refused: its input is empty and
    // carries the parse error the dispatcher answers with.
    const toolUse = events.find((event) => event.kind === "tool_use");
    expect(toolUse).toMatchObject({ toolCall: { id: "call_cut", input: {} } });
    expect(toolUse && "toolCall" in toolUse ? toolUse.toolCall.inputParseError : undefined).toContain("incomplete JSON");
    expect(events.some((event) => event.kind === "done")).toBe(false);
  });

  test("an unexpected finish_reason throws instead of finalizing as end_turn", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [{
        id: "chatcmpl_1",
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      }]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events, error } = await drain(adapter);

    expect(error?.message).toContain("unexpected finish_reason");
    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    if (!(error instanceof ProviderAttemptFailure)) throw new Error("expected ProviderAttemptFailure");
    expect(error.cause).toBeInstanceOf(LlmStreamError);
    expect(events.some((event) => event.kind === "done")).toBe(false);
  });
});

describe("chat-completions tool-call delta assembly", () => {
  test("assembles a tool call whose id and name arrive in later deltas", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [
        { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"pa" } }] }, finish_reason: null }] },
        { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_late", function: { name: "read", arguments: "th\":\"a\"}" } }] }, finish_reason: null }] },
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events, error } = await drain(adapter);

    expect(error).toBeUndefined();
    const toolUse = events.find((event) => event.kind === "tool_use");
    expect(toolUse).toMatchObject({ toolCall: { name: "read", input: { path: "a" } } });
  });

  test("assembles a tool call from deltas that carry no index", async () => {
    const capture: Capture = {};
    const adapter = await createOpenAIChatCompletionsAdapter(
      capturingClient(capture, [
        { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ id: "call_x", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] },
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      "claude-opus-4-8",
      REASONING_INFO,
      OPENROUTER,
    );

    const { events, error } = await drain(adapter);

    expect(error).toBeUndefined();
    expect(events.filter((event) => event.kind === "tool_use")).toHaveLength(1);
    expect(events.find((event) => event.kind === "tool_use")).toMatchObject({ toolCall: { id: "call_x", name: "read" } });
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
