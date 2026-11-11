import { describe, expect, spyOn, test } from "bun:test";
import { APIUserAbortError } from "openai";
import { EventBus, createEmit } from "../../../../src/infra/event-bus.js";
import { Log } from "../../../../src/infra/log.js";

import { createAssistantAttempt } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js";
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import { ApiOverloaded, ContextOverflow, OutputOverflow, toFailureReason, TransientDisconnect } from "../../../../src/orchestration/agent-runtime/errors.js";
import { describeAgentFailure } from "../../../../src/orchestration/agent-runtime/failure-message.js";
import { ContentFilteredError, ContentRefusedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withStreamAttempt } from "../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import { planHistoryLowering } from "../../../../src/orchestration/agent-runtime/llm/provider-history.js";
import { type ConversationMessage, FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { preparedRequest } from "./llm/_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "./_model-client.js";

type TurnInput = Parameters<typeof createAssistantAttempt>[1];
type TurnResult = AssistantTurnResult;

async function runTurn(client: LLMClient, input: Omit<TurnInput, "interactionProfile" | "staleMasking" | "requestContext"> & Partial<Pick<TurnInput, "interactionProfile" | "staleMasking" | "requestContext">>): Promise<TurnResult> {
  const actual = {
    interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
    staleMasking: undefined,
    requestContext: undefined,
    ...input,
  };
  const attempt = createAssistantAttempt({
    attempt: client, client,
    prepared: preparedRequest(client, { ...actual, tools: actual.tools ?? [], systemPrompt: actual.systemPrompt ?? stableSystemPrompt("") }),
  }, actual, undefined);
  const result = await attempt.stream();
  await attempt.close();
  return result;
}

function fakeClient(stream: (opts: StreamOptions) => AsyncGenerator<ProviderStreamEvent>): LLMClient {
  return { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    streamWithTools: stream,
  };
}

const baseInput = () => ({
  messages: [],
  tools: [],
  systemPrompt: stableSystemPrompt(""),
  reasoningEffort: undefined,
  signal: undefined,
  cacheRetention: "1h" as const,
  providerSessionKey: undefined, promptCacheKey: undefined,
  providerOptions: undefined,
  requestAudit: undefined,
  turn: 1,
  messageCount: 0,
  estimatedContextTokens: 0,
  onEvent: () => {},
});

describe("streamAssistantTurn outcome tagging", () => {
  test("pauses the provider iterator while downstream event delivery is full", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let produced = 0;
    const client = fakeClient(async function* () {
      for (let index = 0; index < 3; index++) {
        produced++;
        yield { kind: "text_delta" as const, text: "chunk", blockKey: "text" };
      }
      yield { kind: "done" as const, stopReason: "end_turn" as const };
    });
    const running = runTurn(client, {
      ...baseInput(),
      waitForEventCapacity: () => { entered(); return blocked; },
    });
    try {
      await Promise.race([waiting, running]);
      expect(produced).toBe(1);
    } finally {
      release();
      await running;
    }
  });

  test("interruption releases event pressure and still consumes terminal usage", async () => {
    const bus = new EventBus({ capacity: 1 });
    const blocked = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: ProviderStreamEvent[] = [];
    let closed = false;
    bus.subscribeToType("agent.run.started", () => blocked.promise);
    const emit = createEmit(bus);
    const client = fakeClient(async function* () {
      try {
        yield { kind: "text_delta" as const, text: "first", blockKey: "text" };
        yield { kind: "usage" as const, final: true, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };
        yield { kind: "done" as const, stopReason: "end_turn" as const };
      } finally { closed = true; }
    });
    const running = runTurn(client, {
      ...baseInput(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "text_delta") emit("agent.run.started", { sessionId: "parent", data: { stepIndex: 0 } });
      },
      waitForEventCapacity: (signal) => { waiting.resolve(); return bus.waitForCapacity(signal); },
    });
    try {
      await waiting.promise;
      controller.abort(new Error("stop"));
      expect((await running).outcome.kind).toBe("aborted");
      expect(events.map((event) => event.kind)).toEqual(["text_delta", "usage"]);
      expect(closed).toBe(true);
      expect(await bus.drain({ timeoutMs: 1 })).toEqual({ kind: "timed_out", pending: 1 });
    } finally {
      blocked.resolve();
      await running;
      await bus.dispose();
    }
  });

  test("ContextOverflow returns context_overflow outcome with error tag", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      throw normalizeProviderAttemptFailure(new ContextOverflow());
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome.kind).toBe("context_overflow");
    expect(result.assistantMetadata?.stopReason).toBe("error");
  });

  test("a failed chat-completions turn carries its access provider, so another access provider serving the same model withholds its reasoning", async () => {
    const served = { accessProvider: "custom-a", provider: "openai", api: "openai-responses", model: "shared-model", sharedHost: false } as const;
    const client = { ...fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      yield { kind: "thinking_complete", thinking: "private reasoning", signature: "reasoning_content" };
      yield { kind: "text_delta", text: "partial", blockKey: "text" };
      throw normalizeProviderAttemptFailure(new TransientDisconnect({ message: "drop" }));
    }), accessProvider: "custom-a", modelFamily: "openai" as const, model: "shared-model", historyTarget: () => served };
    const result = await runTurn(client, baseInput());
    expect(result.assistantMetadata).toMatchObject({ accessProvider: "custom-a", api: "openai-responses", model: "shared-model", stopReason: "error" });
    const history: ConversationMessage[] = [
      { kind: "user", content: "hi" },
      { kind: "assistant", content: result.assistantContent, incomplete: true, ...result.assistantMetadata },
    ];
    expect(planHistoryLowering(history, { ...served, accessProvider: "custom-b" })).toEqual([{ at: 1, block: 0, reason: "foreign-deliberation" }]);
  });

  test("OutputOverflow returns output_overflow outcome", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      throw normalizeProviderAttemptFailure(new OutputOverflow());
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome.kind).toBe("output_overflow");
  });

  test("TransientDisconnect returns stream_error outcome", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      throw normalizeProviderAttemptFailure(new TransientDisconnect({ message: "drop" }));
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome.kind).toBe("stream_error");
  });

  test("ApiOverloaded returns stream_error outcome", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      throw normalizeProviderAttemptFailure(new ApiOverloaded({ message: "overloaded" }));
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome.kind).toBe("stream_error");
  });

  test("a provider content refusal returns stream_error outcome with error tag ContentRefused", async () => {
    const refusal = new ContentRefusedError("anthropic", new Error("400 Could not process image"), { reason: "Could not process image", part: undefined });
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      throw normalizeProviderAttemptFailure(refusal);
    });
    const result = await runTurn(client, baseInput());
    if (result.outcome.kind !== "stream_error") throw new Error(`expected stream_error, got ${result.outcome.kind}`);
    expect(result.outcome.error._tag).toBe("ContentRefused");
  });

  test("a content filter error settles ok with stop reason content_filter and keeps the streamed content", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      yield { kind: "text_delta", text: "partial", blockKey: "text" };
      throw normalizeProviderAttemptFailure(new ContentFilteredError("Output blocked by content filtering policy"));
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome).toEqual({ kind: "ok", stopReason: "content_filter" });
    expect(result.assistantMetadata?.stopReason).toBe("content_filter");
    expect(result.assistantContent).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
  });

  test.each([
    {
      identity: { name: "QA Stub", credential: "api_key" } as const,
      raw: "401 Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.",
      message: "The QA Stub API key was rejected. This is a configuration problem, not a connection error.",
      guidance: "Verify a valid API key is configured for QA Stub and retry.",
    },
    {
      identity: { name: "ChatGPT", credential: "oauth" } as const,
      raw: "ChatGPT token refresh failed (401)",
      message: "ChatGPT sign-in is required. This is a sign-in problem, not a connection error.",
      guidance: "Run /auth and reconnect ChatGPT, then send a message to retry.",
    },
  ])("a rejected credential names $identity.name, the provider that served the attempt, whatever the error text names", async ({ identity, raw, message, guidance }) => {
    const failures = spyOn(Log.create({ service: "assistant-turn-stream" }), "error").mockImplementation(() => {});
    try {
      const client = { ...fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
        throw normalizeProviderAttemptFailure(Object.assign(new Error(raw), { status: 401 }));
      }), providerIdentity: identity };
      const result = await runTurn(client, baseInput());
      if (result.outcome.kind !== "stream_error") throw new Error(`expected stream_error, got ${result.outcome.kind}`);
      expect(describeAgentFailure(toFailureReason(result.outcome.error))).toMatchObject({ title: "Authentication failed", message, guidance });
      // A rejected credential needs a person, so no unattended run retries it.
      expect(toFailureReason(result.outcome.error)).toMatchObject({ kind: "api_error", recovery: { kind: "none" } });
    } finally {
      failures.mockRestore();
    }
  });

  test("a request its caller aborts ends aborted with no failure record, whatever error the provider SDK raised; a real failure records at ERROR", async () => {
    const failures = spyOn(Log.create({ service: "assistant-turn-stream" }), "error").mockImplementation(() => {});
    try {
      // A planned replacement's cut aborts the turn while the provider
      // request still waits for its response, and the SDK rejects it with
      // an error of its own rather than the signal's reason.
      const cut = new AbortController();
      const aborted = fakeClient(async function* (options) {
        yield* withStreamAttempt<ProviderStreamEvent>(async function* () {
          cut.abort(new DOMException("planned cut", "AbortError"));
          throw new APIUserAbortError();
        }, { signal: options.signal });
      });
      expect((await runTurn(aborted, { ...baseInput(), signal: cut.signal })).outcome.kind).toBe("aborted");
      expect(failures).not.toHaveBeenCalled();

      const failed = fakeClient(async function* (options) {
        yield* withStreamAttempt<ProviderStreamEvent>(async function* () {
          throw normalizeProviderAttemptFailure(Object.assign(new Error("invalid request"), { status: 400 }));
        }, { signal: options.signal });
      });
      expect((await runTurn(failed, baseInput())).outcome.kind).toBe("stream_error");
      expect(failures.mock.calls.map(([message]) => message)).toEqual(["assistant turn stream failed (fatal)"]);
    } finally {
      failures.mockRestore();
    }
  });

  test("ok outcome carries the provider's completed stop reason", async () => {
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      yield { kind: "text_delta", text: "hi", blockKey: "text" };
      yield { kind: "done", stopReason: "stop_sequence" };
    });
    const result = await runTurn(client, baseInput());
    expect(result.outcome).toEqual({ kind: "ok", stopReason: "stop_sequence" });
  });
});
