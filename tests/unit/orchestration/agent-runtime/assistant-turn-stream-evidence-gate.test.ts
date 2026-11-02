import { expect, test } from "bun:test";
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { ContentRefusedError, QuotaExhaustedError, StreamIdleTimeoutError } from "../../../../src/orchestration/agent-runtime/llm/errors.js";
import { ThinkingStallError } from "../../../../src/orchestration/agent-runtime/llm/thinking-stall.js";
import type { ModelClient, ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { chain, fakeAvailability, fakeClient, subscriptionCandidate, textStream } from "./llm/_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

function input(client: ModelClient) {
  return {
    client, interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE, messages: [], tools: [], systemPrompt: stableSystemPrompt("system"),
    reasoningEffort: undefined, signal: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
    providerOptions: undefined, requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
    turn: 1, messageCount: 0, estimatedContextTokens: 0, onEvent: (_event: ProviderStreamEvent) => {},
  };
}

function providers(first: () => AsyncGenerator<ProviderStreamEvent>, builds: string[]) {
  return chain({
    candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
    availability: fakeAvailability({}).availability,
    subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    build: async (provider) => {
      builds.push(provider);
      return fakeClient(provider, provider === "chatgpt" ? first : textStream("replacement"));
    },
  });
}

test.each([
  // A spent quota advances at once; an outage-shaped failure is retried in
  // place four times over, each attempt settled and abandoned the same way.
  ["quota", () => new QuotaExhaustedError("cap"), 1],
  ["idle", () => new StreamIdleTimeoutError("idle", "idle"), 4],
  ["thinking", () => new ThinkingStallError({ elapsedMs: 45000, summary: "stalled" }), 4],
] as const)("settles partial work and clears only previews before %s replacement", async (_name, error, attempts) => {
  const order: string[] = [];
  const builds: string[] = [];
  const turns: AssistantTurnResult[] = [];
  const client = providers(async function* () {
    yield { kind: "text_delta", text: "retained", blockKey: "text" };
    yield { kind: "thinking_delta", text: "unfinished", blockKey: "thought" };
    yield { kind: "tool_input_start", toolUseId: "unfinished", name: "probe" };
    yield { kind: "tool_input_delta", toolUseId: "unfinished", partialJson: "{" };
    throw normalizeProviderAttemptFailure(error());
  }, builds);
  const result = await streamAssistantTurn<AssistantTurnResult>({
    client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
    prepare: () => ({
      input: { ...input(client), onStreamAbandoned: (reason) => { order.push(reason); } },
      execute: (_candidate, fold) => fold({}, async (attempt) => {
        const value = await attempt.stream();
        turns.push(value);
        order.push("canonical");
        await attempt.close();
        order.push("closed");
        return { value, stop: false };
      }),
    }),
  });
  expect(builds).toEqual(["chatgpt", "github_copilot"]);
  expect(turns[0]?.assistantContent).toEqual([{ type: "text", text: "retained" }]);
  expect(turns[0]?.toolCalls).toEqual([]);
  expect(result.assistantContent).toEqual([{ type: "text", text: "replacement" }]);
  expect(order).toEqual([...Array.from({ length: attempts }, () => ["canonical", "closed", "retry"]).flat(), "canonical", "closed"]);
});

test("a failed response that no candidate replaces ends after its settlement", async () => {
  const order: string[] = [];
  const builds: string[] = [];
  const client = providers(async function* () {
    yield { kind: "thinking_delta", text: "unfinished", blockKey: "thought" };
    throw normalizeProviderAttemptFailure(new ContentRefusedError("chatgpt", new Error("400 refused"), { reason: "refused", part: undefined }));
  }, builds);
  const result = await streamAssistantTurn<AssistantTurnResult>({
    client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
    prepare: () => ({
      input: { ...input(client), onStreamAbandoned: (reason) => { order.push(reason); } },
      execute: (_candidate, fold) => fold({}, async (attempt) => {
        const value = await attempt.stream();
        order.push("canonical");
        await attempt.close();
        return { value, stop: false };
      }),
    }),
  });
  expect(result.outcome.kind).toBe("stream_error");
  expect(builds).toEqual(["chatgpt"]);
  expect(order).toEqual(["canonical", "failed"]);
});

test("local forwarding failure settles partial text but never selects another provider", async () => {
  const builds: string[] = [];
  let canonical: AssistantTurnResult | undefined;
  const client = providers(async function* () {
    yield { kind: "text_delta", text: "retained", blockKey: "text" };
    yield { kind: "thinking_delta", text: "next", blockKey: "thought" };
  }, builds);
  await expect(streamAssistantTurn({
    client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
    prepare: () => ({
      input: {
        ...input(client), onEvent: (event) => { if (event.kind === "thinking_delta") throw new Error("local callback failed"); },
      },
      execute: (_candidate, fold) => fold({}, async (attempt) => {
        canonical = await attempt.stream();
        await attempt.close();
        return { value: canonical, stop: false };
      }),
    }),
  })).rejects.toThrow("local callback failed");
  expect(canonical?.assistantContent).toEqual([{ type: "text", text: "retained" }]);
  expect(builds).toEqual(["chatgpt"]);
});

test("aborting after canonical settlement closes accounting and prevents replacement", async () => {
  const builds: string[] = [];
  const controller = new AbortController();
  let closed = false;
  const client = providers(async function* () { throw normalizeProviderAttemptFailure(new QuotaExhaustedError("cap")); }, builds);
  await streamAssistantTurn({
    client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
    prepare: () => ({
      input: { ...input(client), signal: controller.signal },
      execute: (_candidate, fold) => fold({}, async (attempt) => {
        const value = await attempt.stream();
        controller.abort();
        await attempt.close();
        closed = true;
        return { value, stop: true };
      }),
    }),
  });
  expect(closed).toBe(true);
  expect(builds).toEqual(["chatgpt"]);
});
