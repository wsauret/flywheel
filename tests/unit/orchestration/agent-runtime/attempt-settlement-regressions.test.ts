import { expect, test } from "bun:test";
import { candidateProviderId, type AccessProviderCandidate } from "../../../../src/infra/llm/access-provider.js";
import { computeUsagePrice } from "../../../../src/infra/llm/llm-helpers.js";
import { ANTHROPIC_CACHE_RATES } from "../../../../src/orchestration/agent-runtime/llm/provider-description.js";
import type { ModelCost } from "../../../../src/infra/llm/models.js";
import { decodeUsageEntry, type UsageEntry } from "../../../../src/infra/llm/usage-entry.js";
import { AssistantDraftProjector } from "../../../../src/infra/output/assistant-draft-projector.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { createAssistantAttempt, type AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js";
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { chain, fakeAvailability, fakeClient, preparedRequest, subscriptionCandidate } from "./llm/_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

function attemptInput(overrides: Partial<AssistantAttemptInput> = {}): AssistantAttemptInput {
  return {
    messages: [], interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
    reasoningEffort: undefined, signal: undefined, cacheRetention: undefined,
    providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: undefined,
    staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 0,
    estimatedContextTokens: 1, onEvent() {}, ...overrides,
  };
}

function accounting(calls: string[], usageFailure?: Error, telemetryFailure?: Error) {
  const requestAudit: ProviderRequestAuditWriter = {
    recordRequest: ({ requestId, turn }) => ({ requestId, turn }),
    recordResponse: () => { calls.push("audit"); },
    recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {},
    recordStreamCompleted: () => { calls.push("telemetry"); if (telemetryFailure) throw telemetryFailure; },
  };
  const usageSettlement: NonNullable<AssistantAttemptInput["usageSettlement"]> = {
    profileId: "profile", budgetStreamId: "budget",
    identity: { providerSessionKey: "session", conversationId: "conversation" },
    settlement: {
      async begin() {}, async recover() {},
      async checkpoint(draft) { calls.push(`usage:${draft.entry.coverage === "unmeasured" ? "unmeasured" : draft.entry.tokens.output}`); },
      async settle() { calls.push("settle"); if (usageFailure) throw usageFailure; },
    },
  };
  return { requestAudit, usageSettlement };
}

const usage: ProviderStreamEvent = {
  kind: "usage", final: true, inputTokens: 10, outputTokens: 7, cacheReadTokens: 0,
  cacheCreateTokens: 0, reasoningTokens: 0,
};

/** Settles one attempt whose stream reports `report`, and returns the price and the tokens of each entry the
 *  settlement checkpointed, decoded strictly as a stored entry. */
async function settledPrices(
  report: Extract<ProviderStreamEvent, { kind: "usage" }>,
  candidate: AccessProviderCandidate,
  rateCard: ModelCost = { input: 2, output: 10, highContext: { threshold: 272_000, input: 4, output: 15 } },
  cacheRates?: Parameters<typeof computeUsagePrice>[2],
) {
  const entries: UsageEntry[] = [];
  const client = fakeClient(candidateProviderId(candidate), async function* () {
    yield report;
    yield { kind: "done", stopReason: "end_turn" };
  });
  client.priceFor = (tokens) => computeUsagePrice(tokens, {
    status: "available",
    rateCard,
    provenance: { source: "provider-docs", provider: "openai", model: client.model },
  }, cacheRates);
  const { usageSettlement } = accounting([]);
  usageSettlement.settlement.checkpoint = async (draft) => { entries.push(decodeUsageEntry(draft.entry)); };
  const input = attemptInput({ usageSettlement });
  const serving = { ...client, accessProviderCandidate: candidate, credentialLineage: "00000000-0000-4000-8000-000000000001" };
  const attempt = createAssistantAttempt({
    client, attempt: serving,
    prepared: preparedRequest(serving, { ...input, tools: [], systemPrompt: stableSystemPrompt("") }),
  }, input, undefined);
  await attempt.stream();
  await attempt.close();
  return {
    model: client.model,
    prices: entries.map((entry) => "price" in entry ? entry.price : undefined),
    tokens: entries.map((entry) => "tokens" in entry ? entry.tokens : undefined),
  };
}

// The rate card of Claude Opus 5.5 that models.dev states: input 4, output 20, cache read 0.2, five-minute write 5 per
// million. Anthropic's cache rates add the one-hour write at two times input, 8 per million.
const OPUS: ModelCost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

test("usage settlement records the one-hour part of the cache writes and prices it at the one-hour rate", async () => {
  const report = { ...usage, inputTokens: 0, outputTokens: 0, cacheCreateTokens: 30_000, cacheCreate1hTokens: 10_000 };
  const { prices, tokens } = await settledPrices(report, subscriptionCandidate("claude_agent_sdk"), OPUS, ANTHROPIC_CACHE_RATES);

  expect(tokens).toEqual([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 30_000, cacheWrite1h: 10_000, reasoning: 0 }]);
  // 20,000 five-minute tokens at 5 and 10,000 one-hour tokens at 8 per million.
  expect(prices[0]).toMatchObject({ kind: "priced", estimatedUsd: 0.18 });
});

test("usage settlement prices cache writes without a reported split at the five-minute rate", async () => {
  const report = { ...usage, inputTokens: 0, outputTokens: 0, cacheCreateTokens: 30_000, cacheCreate1hTokens: 0 };
  const { prices, tokens } = await settledPrices(report, subscriptionCandidate("claude_agent_sdk"), OPUS, ANTHROPIC_CACHE_RATES);

  expect(tokens).toEqual([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 30_000, reasoning: 0 }]);
  expect(prices[0]).toMatchObject({ kind: "priced", estimatedUsd: 0.15 });
});

// A reported charge of zero is a charge, not a missing one: the rate card must not price it.
test.each([0.00042, 0])("usage settlement records the charge the provider reports (%p) in place of the rate-card estimate", async (reportedChargeUsd) => {
  const { model, prices } = await settledPrices({ ...usage, reportedChargeUsd }, { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" });

  expect(prices).toEqual([{
    kind: "priced",
    estimatedUsd: reportedChargeUsd,
    rateCard: {},
    provenance: JSON.stringify({ source: "provider-response", provider: "openrouter", model }),
  }]);
});

test("usage settlement preserves standard and high-context rate cards", async () => {
  const { model, prices } = await settledPrices({ ...usage, inputTokens: 300_000 }, subscriptionCandidate("chatgpt"));
  expect(prices).toHaveLength(1);
  expect(prices[0]).toEqual({
    kind: "priced",
    estimatedUsd: 1.200105,
    rateCard: {
      "standard.input": 2, "standard.output": 10, "standard.cacheRead": 0,
      "standard.cacheWrite": 0, "standard.cacheWrite1h": 0, "standard.reasoning": 10,
      "highContext.input": 4, "highContext.output": 15, "highContext.cacheRead": 0,
      "highContext.cacheWrite": 0, "highContext.cacheWrite1h": 0, "highContext.reasoning": 15,
    },
    provenance: JSON.stringify({ source: "provider-docs", provider: "openai", model }),
  });
});

for (const terminal of ["local", "cancel", "done"] as const) {
  test(`cancellation drains catch-path usage and retains ${terminal} settlement`, async () => {
    const controller = new AbortController();
    const localError = new Error("local audit callback failed");
    const calls: string[] = [];
    const events: string[] = [];
    const client = fakeClient("chatgpt", async function* () {
      yield { kind: "text_delta", text: "kept", blockKey: "text" };
      controller.abort(new Error("cancelled"));
      yield usage;
      yield { kind: "text_delta", text: "suppressed", blockKey: "text" };
      yield { kind: "tool_use", toolCall: { id: "late", name: "read", input: {} } };
      calls.push("drained");
      if (terminal === "local") throw localError;
      if (terminal === "cancel") throw controller.signal.reason;
      yield { kind: "done", stopReason: "end_turn" };
    });
    const input = attemptInput({
      ...accounting(calls, terminal === "local" ? new Error("later settlement failure") : undefined),
      signal: controller.signal, onEvent: (event) => { events.push(event.kind); },
      canonicalizeToolCall() { throw new Error("cancelled tool must not dispatch"); },
    });
    const serving = { ...client, accessProviderCandidate: subscriptionCandidate("chatgpt"), credentialLineage: "lineage" };
    const attempt = createAssistantAttempt({
      client, attempt: serving,
      prepared: preparedRequest(serving, { ...input, tools: [], systemPrompt: stableSystemPrompt("") }),
    }, input, undefined);
    const result = await attempt.stream();
    calls.push("canonical");
    if (terminal === "local") await expect(attempt.close()).rejects.toBe(localError);
    else await attempt.close();
    expect(result.outcome.kind).toBe(terminal === "local" ? "stream_error" : "aborted");
    expect(result.toolCalls).toEqual([]);
    expect(events).toEqual(["text_delta", "usage"]);
    expect(calls).toEqual(["usage:7", "drained", "settle", "telemetry", "canonical", "audit"]);
    expect(attempt.failure()).toBeUndefined();
  });
}

test("usage failure does not skip telemetry or audit and never advances a candidate", async () => {
  const calls: string[] = [];
  const visits: string[] = [];
  const usageError = new Error("usage publication failed");
  const client = chain({
    availability: fakeAvailability({}).availability,
    build: async (provider) => fakeClient(provider, async function* () {
      visits.push(provider);
      yield { kind: "text_delta", text: "partial", blockKey: "text" };
      throw normalizeProviderAttemptFailure(new Error("provider disconnected"));
    }),
  });
  await expect(streamAssistantTurn({ client, executionCwd: "/scratch", ...attemptInput(accounting(calls, usageError, new Error("telemetry failed"))) })).rejects.toBe(usageError);
  expect(calls).toEqual(["settle", "telemetry", "audit"]);
  expect(visits).toEqual(["chatgpt"]);
});

test("an internal stop silently removes a failed preview without trying another candidate", async () => {
  const projector = new OutputProjector({ executionCwd: "/project" });
  const reasons: string[] = [];
  const visits: string[] = [];
  const client = chain({
    availability: fakeAvailability({}).availability,
    build: async (provider) => fakeClient(provider, async function* () {
      visits.push(provider);
      yield { kind: "tool_input_start", toolUseId: "preview", name: "read" };
      throw normalizeProviderAttemptFailure(new Error("provider disconnected"));
    }),
  });
  const value = await streamAssistantTurn({
    client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
    prepare: () => ({
      input: attemptInput({
        onEvent(event) {
          if (event.kind === "tool_input_start") projector.apply({ type: "tool-use", toolUseId: event.toolUseId, name: event.name, input: {}, timestamp: 1 });
        },
        onStreamAbandoned(reason) {
          reasons.push(reason);
          projector.apply({ type: "abandon-tool-inputs", reason });
        },
      }),
      execute: (_candidate, fold) => fold({}, async (attempt) => {
        await attempt.stream();
        await attempt.close();
        return { value: "continue local loop", stop: true };
      }),
    }),
  });
  expect(value).toBe("continue local loop");
  expect(reasons).toEqual(["retry"]);
  expect(visits).toEqual(["chatgpt"]);
  expect(projector.getBlocks()).toEqual([]);
});

test("partial canonical settlement retracts unfinished thinking no part claims, and retry cleanup keeps the settled rows", () => {
  const projector = new OutputProjector({ executionCwd: "/project" });
  const draft = new AssistantDraftProjector(projector);
  draft.streamThinking("entry:0", "completed reasoning", 1, undefined);
  draft.streamThinking("unfinished", "unfinished reasoning", 2, undefined);
  draft.streamText("entry:1", "retained text", 3);
  projector.apply({ type: "push-thinking", text: "sibling reasoning", blockKey: "sibling", timestamp: 4 });
  draft.settle([
    { type: "thinking", thinking: "completed reasoning", signature: "signature" },
    { type: "text", text: "retained text" },
    { type: "tool_use", id: "actual", name: "read", input: { path: "file" } },
  ], undefined, 5, "entry");
  // The unfinished thought is in no persisted part, so a reopened transcript
  // would lack it; settlement removes it rather than leaving it to the retry.
  const settled = projector.getBlocks();
  expect(settled.some((block) => block.kind === "thinking" && block.id === "unfinished")).toBe(false);
  draft.endResponse(6);
  expect(projector.getBlocks()).toEqual(settled);
  expect(projector.getBlocks().some((block) => block.kind === "thinking" && block.id === "entry:0")).toBe(true);
  expect(projector.getBlocks().some((block) => block.kind === "text" && block.id === "entry:1")).toBe(true);
  expect(projector.getBlocks().some((block) => block.kind === "thinking" && block.id === "sibling")).toBe(true);
});
