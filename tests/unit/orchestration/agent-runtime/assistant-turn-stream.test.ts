import { describe, expect, test } from "bun:test";

import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream";
import { ProviderRequestValidationError, QuotaExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import type { ProviderRequestAuditHandle, ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ModelClient, type ProviderStreamEvent, type ServingAttempt, type StreamOptions, type StreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types";
import { handleAnthropicDelta } from "../../../../src/orchestration/agent-runtime/llm/anthropic";
import { asModelClient, ownHistoryTarget, withRequestAdmission } from "./_model-client";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { pricedUsage } from "../../../helpers/usage-price-fixtures.js";
import { chain, fakeAvailability } from "./llm/_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

type TurnInput = Parameters<typeof streamAssistantTurn>[0];

const runTurn = (input: Omit<TurnInput, "executionCwd" | "interactionProfile" | "staleMasking" | "requestContext"> & Partial<Pick<TurnInput, "interactionProfile" | "staleMasking" | "requestContext">>) => streamAssistantTurn({
  executionCwd: "/scratch",
  interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
  staleMasking: undefined,
  requestContext: undefined,
  ...input,
});


function fakeClient(
  stream: (opts: StreamOptions) => AsyncGenerator<ProviderStreamEvent>,
  observe?: (opts: StreamOptions) => void,
  priceFor: LLMClient["priceFor"] = () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
): ModelClient {
  return asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor,
    streamWithTools(opts: StreamOptions) {
      observe?.(opts);
      return stream(opts);
    },
  });
}

function fakeAttempt(
  accessProvider: ServingAttempt["accessProvider"],
  model: string,
  priceFor: ServingAttempt["priceFor"] = () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  spendMode: "included" | "direct_api" = "direct_api",
): ServingAttempt {
  return {
    accessProvider,
    accessProviderCandidate: spendMode === "included"
      ? { kind: "subscription", providerId: accessProvider, instanceId: "seat", spendMode }
      : { kind: "singleton", providerId: accessProvider, spendMode },
    modelFamily: accessProvider === "anthropic_api" ? "anthropic" : "openai",
    model,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor,
  };
}


describe("streamAssistantTurn canonical shell identity", () => { test("uses canonical bash for definitions and current calls", async () => {
    const captured: StreamOptions[] = []; const auditTools: StreamOptions["tools"][] = []; const normalizedNames: unknown[] = []; const forwardedNames: string[] = [];
    const client = withRequestAdmission({
      model: "gpt-6.1-sol", modelFamily: "openai",
      plannedAttempt: async () => fakeAttempt("openai_api", "gpt-6.1-sol"), async *streamWithTools(options) {
        captured.push(options);
        yield { kind: "tool_input_start", toolUseId: "call-1", name: "Bash" }; yield { kind: "tool_use", toolCall: { id: "call-1", name: "Bash", input: { command: "pwd" } } }; yield { kind: "done", stopReason: "tool_use" };
      },
    });
    const requestAudit: ProviderRequestAuditWriter = { recordRequest(input) { auditTools.push(input.tools); return { requestId: "request-1", turn: input.turn }; },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {},
      recordStreamEvent(_handle, event) { if (event.source === "normalized" && (event.kind === "tool_input_start" || event.kind === "tool_use")) normalizedNames.push(event.metadata.name); },
      recordStreamCompleted() {} };
    const result = await runTurn({
      client, messages: [], tools: [{ name: "bash", description: "shell", input_schema: { type: "object", properties: { background: { type: "boolean" } } } }], systemPrompt: stableSystemPrompt("system"),
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit,
      staleMasking: undefined, turn: 1, messageCount: 0, estimatedContextTokens: 0,
      canonicalizeToolCall: (call) => call.name === "Bash" ? { ...call, name: "bash", repairedFrom: call.name } : call,
      canonicalizeToolName: (name) => name === "Bash" ? "bash" : name,
      onEvent: (event) => { if (event.kind === "tool_input_start" || event.kind === "tool_use") forwardedNames.push(event.kind === "tool_input_start" ? event.name : event.toolCall.name); },
    });
    expect(captured[0]?.tools[0]?.name).toBe("bash"); expect(auditTools[0]?.[0]?.name).toBe("bash"); expect(captured[0]?.tools[0]).not.toHaveProperty("promptGuidelines");
    expect(result.toolCalls[0]).toMatchObject({ name: "bash", repairedFrom: "Bash" });
    expect(normalizedNames).toEqual(["bash", "bash"]); expect(forwardedNames).toEqual(["bash", "bash"]);
  }); });

  test("leaves an unadvertised exec call noncanonical", async () => {
    const result = await runTurn({
      client: fakeClient(async function* () {
        yield { kind: "tool_use", toolCall: { id: "call-exec", name: "exec", input: { command: "pwd" } } };
        yield { kind: "done", stopReason: "tool_use" };
      }),
      messages: [], tools: [{ name: "bash", description: "shell", input_schema: {} }], systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit: undefined, staleMasking: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 0,
      canonicalizeToolCall: (call) => call,
      onEvent: () => {},
    });

    expect(result.toolCalls[0]).toEqual({ id: "call-exec", name: "exec", input: { command: "pwd" } });
  });


describe("streamAssistantTurn usage attribution stamping", () => {
  test("stamps usage events and the turn with the serving provider, following failover", async () => {
    const usage = {
      kind: "usage" as const, final: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
    };
    // A chain that loses its first candidate to a terminal quota failure: the
    // second attempt prepares itself, so the usage after it belongs to the
    // provider that sent that request.
    const client = chain({
      candidates: ["anthropic_api", "openai_api"],
      availability: fakeAvailability({}).availability,
      build: async (provider) => ({ historyTarget: ownHistoryTarget,
        ...fakeAttempt(provider, provider === "anthropic_api" ? "test-model" : "fallback-model"),
        async *streamWithTools() {
          yield usage;
          if (provider === "anthropic_api") throw normalizeProviderAttemptFailure(new QuotaExhaustedError("spent"));
          yield { kind: "text_delta", text: "fallback answer", blockKey: "provider-text" };
          // A chat-completions adapter names no access provider on its turn (`openai-completions.ts`).
          yield { kind: "done", stopReason: "end_turn", metadata: { api: "openai-responses", provider: "openai", model: "fallback-model", timestamp: 1 } };
        },
      }),
    });

    const forwarded: StreamEvent[] = [];
    const reservations: string[] = [];
    const released: string[] = [];
    const result = await runTurn({
      client,
      messages: [{ kind: "user", content: "hello" }],
      tools: [],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "5m",
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: undefined,
      staleMasking: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 0,
      reserveMessageId: async () => {
        const id = `entry-${reservations.length + 1}`;
        reservations.push(id);
        return id;
      },
      releaseMessageId: id => { released.push(id); },
      onEvent: (event) => forwarded.push(event),
    });

    const usages = forwarded.filter((event) => event.kind === "usage");
    expect(usages.map((event) => event.accessProvider)).toEqual(["anthropic_api", "openai_api"]);
    expect(usages.map((event) => event.accessProviderCandidate)).toEqual([
      { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
      { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
    ]);
    expect(reservations).toEqual(["entry-1", "entry-2"]);
    expect(new Set(released)).toEqual(new Set(["entry-1"]));
    expect(forwarded.find(event => event.kind === "text_delta")?.outputIdentity).toEqual({ entryId: "entry-2", blockKey: "entry-2:0" });
    expect(result).toMatchObject({ entryId: "entry-2", assistantMetadata: { accessProvider: "openai_api", api: "openai-responses", model: "fallback-model" } });
  });
});

describe("Anthropic block identity minting", () => {
  test("the same provider index under different runIds produces distinct blockKeys", () => {
    const first = [...handleAnthropicDelta(
      { index: 0, delta: { type: "text_delta", text: "first" } },
      new Map(),
      new Map(),
      "run-a",
    )];
    const second = [...handleAnthropicDelta(
      { index: 0, delta: { type: "text_delta", text: "second" } },
      new Map(),
      new Map(),
      "run-b",
    )];

    expect(first[0]).toMatchObject({ kind: "text_delta", blockKey: "run-a:0" });
    expect(second[0]).toMatchObject({ kind: "text_delta", blockKey: "run-b:0" });
    if (first[0]?.kind !== "text_delta" || second[0]?.kind !== "text_delta") throw new Error("expected text deltas");
    expect(first[0].blockKey).not.toBe(second[0].blockKey);
  });
});

describe("Anthropic redacted-thinking token estimates", () => {
  test("thinking_delta with estimated_tokens and no text yields estimatedTokens", () => {
    const thinkingBuffers = new Map<number, { thinking: string; signature: string }>();
    thinkingBuffers.set(0, { thinking: "", signature: "" });
    const delta = { type: "thinking_delta" as const, thinking: "", estimated_tokens: 128 };
    const events = [...handleAnthropicDelta(
      { index: 0, delta },
      new Map(),
      thinkingBuffers,
      "run-a",
    )];

    expect(events[0]).toEqual({ kind: "thinking_delta", text: "", blockKey: "run-a:0", estimatedTokens: 128 });
    expect(thinkingBuffers.get(0)?.thinking).toBe("");
  });

  test("thinking_delta with visible text carries no estimatedTokens and accumulates", () => {
    const thinkingBuffers = new Map<number, { thinking: string; signature: string }>();
    thinkingBuffers.set(0, { thinking: "", signature: "" });
    const events = [...handleAnthropicDelta(
      { index: 0, delta: { type: "thinking_delta", thinking: "deep thought" } },
      new Map(),
      thinkingBuffers,
      "run-a",
    )];

    expect(events[0]).toEqual({ kind: "thinking_delta", text: "deep thought", blockKey: "run-a:0" });
    expect(thinkingBuffers.get(0)?.thinking).toBe("deep thought");
  });
});

describe("streamAssistantTurn provider request audit", () => {
  test("records request/response facts and causally tags model-emitted tool events", async () => {
    const requests: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0][] = [];
    const responses: Array<{
      handle: ProviderRequestAuditHandle;
      input: Parameters<ProviderRequestAuditWriter["recordResponse"]>[1];
    }> = [];
    const usages: Array<{
      handle: ProviderRequestAuditHandle;
      input: Parameters<ProviderRequestAuditWriter["recordUsage"]>[1];
    }> = [];
    const streamStarts: ProviderRequestAuditHandle[] = [];
    const streamEvents: Array<{
      handle: ProviderRequestAuditHandle;
      input: Parameters<ProviderRequestAuditWriter["recordStreamEvent"]>[1];
    }> = [];
    const streamCompletions: Array<{
      handle: ProviderRequestAuditHandle;
      input: Parameters<ProviderRequestAuditWriter["recordStreamCompleted"]>[1];
    }> = [];
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) {
        requests.push(input);
        return { requestId: input.requestId, turn: input.turn };
      },
      recordResponse(handle, input) {
        responses.push({ handle, input });
      },
      recordUsage(handle, input) {
        usages.push({ handle, input });
      },
      recordStreamStarted(handle) {
        streamStarts.push(handle);
      },
      recordStreamEvent(handle, input) {
        streamEvents.push({ handle, input });
      },
      recordStreamCompleted(handle, input) {
        streamCompletions.push({ handle, input });
      },
    };

    const seen: ProviderStreamEvent[] = [];
    const client = fakeClient(async function* (opts) {
      await opts.telemetry?.observe({ source: "provider", kind: "ping", metadata: { heartbeat: true } });
      yield { kind: "tool_input_start", toolUseId: "tool-1", name: "read" };
      yield { kind: "tool_input_delta", toolUseId: "tool-1", partialJson: "{\"path\"" };
      yield { kind: "tool_use", toolCall: { id: "tool-1", name: "read", input: { path: "a.ts" } } };
      yield { kind: "usage", final: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreateTokens: 10, reasoningTokens: 5 };
      yield {
        kind: "done",
        stopReason: "tool_use",
        metadata: {
          api: "anthropic-messages",
          provider: "anthropic",
          model: "test-model",
          timestamp: 100,
          stopReason: "tool_use",
          responseId: "resp-1",
        },
      };
    }, undefined, (tokens) => pricedUsage(1 / 1000, tokens));

    const result = await runTurn({
      client,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "x" }],
      tools: [{ name: "read", description: "Read files", input_schema: {} }],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: "medium",
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: "conv-abc", promptCacheKey: "conv-abc",
      providerOptions: undefined,
      requestAudit,
      turn: 3,
      messageCount: 5,
      estimatedContextTokens: 1234,
      onEvent: (event) => { seen.push(event); },
    });

    expect(requests).toEqual([{
      requestContext: undefined,
      requestId: requests[0]!.requestId,
      turn: 3,
      interactionProfileId: "default",
      attemptStaticTokens: 17,
      attribution: { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000 },
      systemPrompt: "system",
      messages: [{ kind: "user", content: "x" }],
      tools: [{ name: "read", registrationId: "read", executableId: "read", description: "Read files", input_schema: {} }],
      omittedTools: [],
      messageCount: 5,
      estimatedContextTokens: 1234,
      reasoningEffort: "medium",
      cacheRetention: "1h",
      cacheKey: "conv-abc",
      providerOptions: undefined,
      staleMasking: undefined,
    }]);
    expect(responses).toEqual([{
      handle: { requestId: requests[0]!.requestId, turn: 3 },
      input: { outcome: "ok", stopReason: "tool_use", responseId: "resp-1" },
    }]);
    expect(usages).toEqual([]);
    expect(streamStarts).toEqual([{ requestId: requests[0]!.requestId, turn: 3 }]);
    expect(streamEvents.map((event) => ({
      source: event.input.source,
      kind: event.input.kind,
    }))).toEqual([
      { source: "provider", kind: "ping" },
      { source: "normalized", kind: "tool_input_start" },
      { source: "normalized", kind: "tool_input_delta" },
      { source: "normalized", kind: "tool_use" },
      { source: "normalized", kind: "usage" },
      { source: "normalized", kind: "done" },
    ]);
    expect(streamEvents[0]?.input.metadata).toEqual({ heartbeat: true });
    expect(streamCompletions).toEqual([{
      handle: { requestId: requests[0]!.requestId, turn: 3 },
      input: { durationMs: expect.any(Number), eventCount: 6, outcome: "ok", lastEventKind: "done", stallCount: 0 },
    }]);
    expect(seen[0]).toEqual({ kind: "tool_input_start", toolUseId: "tool-1", name: "read", modelRequestId: requests[0]!.requestId });
    expect(seen[1]).toEqual({ kind: "tool_input_delta", toolUseId: "tool-1", partialJson: "{\"path\"", modelRequestId: requests[0]!.requestId });
    expect(result.toolCalls[0]?.modelRequestId).toBe(requests[0]!.requestId);
  });

  test("stamps modelRequestId onto the tool call before canonicalization dispatches it", async () => {
    // canonicalizeToolCall hands the call to the tool dispatcher, and every
    // durable fact the executing call emits (tool.result.recorded,
    // tool.execution_output.recorded) reads identity from that call. A call
    // dispatched before stamping writes identity-less follow-up facts.
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest: (input) => ({ requestId: input.requestId, turn: input.turn }),
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    };
    const dispatched: (string | undefined)[] = [];
    await runTurn({
      client: fakeClient(async function* () {
        yield { kind: "tool_use", toolCall: { id: "tool-1", name: "read", input: { path: "a.ts" } } };
        yield { kind: "done", stopReason: "tool_use" };
      }),
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [], tools: [{ name: "read", description: "Read files", input_schema: {} }], systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, staleMasking: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 0,
      canonicalizeToolCall: (call) => { dispatched.push(call.modelRequestId); return call; },
      onEvent: () => {},
    });
    expect(dispatched[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("awaits stream telemetry before forwarding or consuming the next provider delta", async () => {
    let releaseTelemetry: (() => void) | undefined; let yieldedSecond = false;
    const seen: ProviderStreamEvent["kind"][] = [];
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest: (input) => ({ requestId: "request-pressure", turn: input.turn }),
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamCompleted() {},
      recordStreamEvent: (_handle, input) => input.kind === "text_delta" ? new Promise<void>((resolve) => { releaseTelemetry = resolve; }) : undefined,
    };
    const promise = runTurn({
      client: fakeClient(async function* () { yield { kind: "text_delta", text: "first", blockKey: "text" }; yieldedSecond = true; yield { kind: "done", stopReason: "end_turn" }; }),
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "x" }], tools: [], systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, turn: 1, messageCount: 1, estimatedContextTokens: 0,
      onEvent: (event) => { seen.push(event.kind); },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = { seen: [...seen], yieldedSecond };
    expect(releaseTelemetry).toBeDefined(); releaseTelemetry?.(); await promise;
    expect(before).toEqual({ seen: [], yieldedSecond: false });
    expect(seen).toEqual(["text_delta"]);
  });

  test("a request abandoned on a quota failure keeps its own usage; the fallback record gets none", async () => {
    const usages: Array<{
      requestId: string;
      input: Parameters<ProviderRequestAuditWriter["recordUsage"]>[1];
    }> = [];
    const requests: Array<{ requestId: string; accessProvider: string }> = [];
    let nextRequest = 0;
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) {
        nextRequest += 1;
        const handle = { requestId: input.requestId, turn: input.turn };
        requests.push({ requestId: handle.requestId, accessProvider: input.attribution.accessProvider });
        return handle;
      },
      recordResponse() {},
      recordAbandonedResponse() { return Promise.resolve(); },
      recordUsage(handle, input) {
        usages.push({ requestId: handle.requestId, input });
      },
      recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    };

    // The chain's failover shape: the first provider reports usage, dies on a
    // terminal quota failure with no durable content, and the fallback serves
    // the turn without reporting usage of its own.
    const client = chain({
      candidates: ["anthropic_api", "openai_api"],
      availability: fakeAvailability({}).availability,
      build: async (provider) => ({ historyTarget: ownHistoryTarget,
        ...fakeAttempt(provider, provider === "anthropic_api" ? "test-model" : "fallback-model", (tokens) => pricedUsage(0.25, tokens)),
        async *streamWithTools() {
          if (provider === "anthropic_api") {
            yield { kind: "usage", final: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreateTokens: 10, reasoningTokens: 5 };
            throw normalizeProviderAttemptFailure(new QuotaExhaustedError("spent"));
          }
          yield { kind: "text_delta", text: "served", blockKey: "text" };
          yield { kind: "done", stopReason: "end_turn" };
        },
      }),
    });

    const result = await runTurn({
      client,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [], tools: [], systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit, staleMasking: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 0,
      onEvent: () => {},
    });

    expect(result.outcome).toEqual({ kind: "ok", stopReason: "end_turn" });
    expect(requests).toEqual([
      { requestId: requests[0]!.requestId, accessProvider: "anthropic_api" },
      { requestId: requests[1]!.requestId, accessProvider: "openai_api" },
    ]);
    // Exactly one usage record: the abandoned request's own, priced by the
    // provider that reported it. Nothing is written under request-2.
    expect(usages).toEqual([]);
  });

  test("a request the provider rejects settles as a stream error instead of walking the chain", async () => {
    const prepared: string[] = [];
    const client = chain({
      candidates: ["anthropic_api", "openai_api"],
      availability: fakeAvailability({}).availability,
      build: async (provider) => ({ historyTarget: ownHistoryTarget,
        ...fakeAttempt(provider, "test-model"),
        async *streamWithTools() {
          prepared.push(provider === "anthropic_api" ? "first" : "fallback");
          throw normalizeProviderAttemptFailure(new ProviderRequestValidationError("anthropic", "input is required"));
        },
      }),
    });

    const result = await runTurn({
      client, messages: [], tools: [], systemPrompt: stableSystemPrompt("system"), reasoningEffort: undefined,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
      requestAudit: undefined, staleMasking: undefined, turn: 1, messageCount: 0, estimatedContextTokens: 0,
      onEvent: () => {},
    });

    expect(result.outcome).toMatchObject({ kind: "stream_error", error: { _tag: "ApiError", message: expect.stringContaining("input is required") } });
    expect(prepared).toEqual(["first"]);
  });

  test("propagates strict abandonment failure before fallback preparation", async () => {
    const appendFailure = new Error("abandonment append failed");
    const prepared: string[] = [];
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest: (input) => ({ requestId: input.requestId, turn: input.turn }),
      recordResponse: async () => { throw appendFailure; },
      recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    };
    const client = chain({
      candidates: ["anthropic_api", "openai_api"],
      availability: fakeAvailability({}).availability,
      build: async (provider) => ({ historyTarget: ownHistoryTarget,
        ...fakeAttempt(provider, "test-model"),
        async *streamWithTools() {
          prepared.push(provider === "anthropic_api" ? "first" : "fallback");
          throw normalizeProviderAttemptFailure(new QuotaExhaustedError("spent"));
        },
      }),
    });

    const turn = runTurn({
      client, messages: [], tools: [], systemPrompt: stableSystemPrompt("system"), reasoningEffort: undefined,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      signal: undefined, cacheRetention: "1h", providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined,
      requestAudit, staleMasking: undefined, turn: 1, messageCount: 0, estimatedContextTokens: 0,
      onEvent: () => {},
    });

    await expect(turn).rejects.toMatchObject({ _tag: "ProviderAuditSettlementError", message: appendFailure.message });
    expect(prepared).toEqual(["first"]);
  });
});

describe("streamAssistantTurn incremental event forwarding", () => {
  test("an early provider stream event reaches onEvent before the assistant-turn promise resolves", async () => {
    const seen: ProviderStreamEvent["kind"][] = [];
    let earlyEventSeenWhilePromisePending = false;

    let resolveDone: (() => void) | undefined;
    const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });

    const client = fakeClient(async function* () {
      yield { kind: "text_delta", text: "hello", blockKey: "text" };
      // Pause until the test signals the stream to complete.
      await donePromise;
      yield { kind: "done", stopReason: "end_turn" };
    });

    const promise = runTurn({
      client,
      messages: [{ kind: "user", content: "x" }],
      tools: [],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 0,
      onEvent: (e) => {
        seen.push(e.kind);
        if (e.kind === "text_delta") earlyEventSeenWhilePromisePending = true;
      },
    });

    // Yield to the event loop so the generator advances to the first yield.
    await new Promise((r) => setTimeout(r, 5));
    expect(earlyEventSeenWhilePromisePending).toBe(true);
    expect(seen).toContain("text_delta");

    // Release the pause so the turn completes. The terminal event is retained on
    // the result for the settlement coordinator, never forwarded here.
    resolveDone!();
    const result = await promise;
    expect(seen).not.toContain("done");
    expect(result.terminalEvent?.stopReason).toBe("end_turn");
  });
});

