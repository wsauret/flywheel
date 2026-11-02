import { describe, expect, test } from "bun:test";

import { newTestRunner } from "../../../helpers/agent-runner.js";
import { testDirectories } from "../../../helpers/directories.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types";
import type { ConnectionState } from "../../../../src/infra/output-blocks";
import type { ModelClient, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types";
import { asModelClient } from "./_model-client";
import { pricedUsage } from "../../../helpers/usage-price-fixtures.js";

function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    ...testDirectories("/scratch"),
    onEvent: () => {},
    runtimeSurfaces: {},
    purpose: { kind: "interactive-chat" },
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    ...overrides,
  };
}

function makeFakeClient(): ModelClient {
  return asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor(tokens) { return pricedUsage(1 / 1000, tokens); },
    async *streamWithTools() {
      // Emit one of every event type that flows through the onEvent handler.
      // tool_result events are emitted by the dispatcher, not by providers —
      // covered in dispatcher-focused tests.
      yield { kind: "text_delta", text: "streamed text", blockKey: "text" } as const;
      yield { kind: "usage", final: true, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    },
  });
}

describe("LiveAgent parentToolUseId threading", () => {
  test("tags every nested event with parent_tool_use_id when set", async () => {
    const events: RuntimeEvent[] = [];
    const runner = newTestRunner(
      makeOptions({
        purpose: { kind: "subagent", renderAs: "chat", parentToolUseId: "parent-abc" },
        onEvent: (e) => events.push(e),
      }),
      async () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const assistantEvents = events.filter((e) => e.type === "model.assistant_message.recorded");
    const contentBlockDeltaEvents = events.filter((e) => e.type === "model.content.delta");
    const resultEvents = events.filter((e) => e.type === "model.turn.completed");

    expect(assistantEvents.length).toBeGreaterThan(0);
    expect(contentBlockDeltaEvents.length).toBeGreaterThan(0);
    expect(resultEvents.length).toBe(1);

    for (const e of assistantEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
    for (const e of contentBlockDeltaEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
    for (const e of resultEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
  });

  test("user events carry parent_tool_use_id when set", async () => {
    const events: RuntimeEvent[] = [];
    const runner = newTestRunner(
      makeOptions({
        purpose: { kind: "subagent", renderAs: "chat", parentToolUseId: "parent-abc" },
        onEvent: (e) => events.push(e),
      }),
      async () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const userEvents = events.filter((e) => e.type === "model.user_message.recorded");
    expect(userEvents.length).toBeGreaterThan(0);
    for (const e of userEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
  });

  test("omits parent_tool_use_id when parentToolUseId is not set", async () => {
    const events: RuntimeEvent[] = [];
    const runner = newTestRunner(
      makeOptions({
        onEvent: (e) => events.push(e),
      }),
      async () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const assistantEvents = events.filter((e) => e.type === "model.assistant_message.recorded");
    const toolResultEvents = events.filter((e) => e.type === "tool.result.recorded");
    const contentBlockDeltaEvents = events.filter((e) => e.type === "model.content.delta");
    const resultEvents = events.filter((e) => e.type === "model.turn.completed");

    for (const e of assistantEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
    for (const e of toolResultEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
    for (const e of contentBlockDeltaEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
    for (const e of resultEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
  });
});

describe("LiveAgent maxLLMCalls and agentRegistry options", () => {
  test("honors maxLLMCalls by forcing a final summary turn", async () => {
    const events: RuntimeEvent[] = [];
    let streamInvocations = 0;
    const runner = newTestRunner(
      makeOptions({
        maxLLMCalls: 1,
        onEvent: (e) => events.push(e),
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api",
        modelFamily: "anthropic",
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools() {
          streamInvocations++;
          if (streamInvocations > 5) {
            throw new Error("too many stream invocations");
          }
          if (streamInvocations === 1) {
            yield {
              kind: "tool_use",
              toolCall: { id: `t${streamInvocations}`, name: "noop_tool", input: {} },
            } as const;
          } else {
            yield { kind: "text_delta", text: "Budget summary", blockKey: "text" } as const;
          }
          yield { kind: "done", stopReason: streamInvocations === 1 ? "tool_use" : "end_turn" } as const;
        },
      }),
    );

    runner.send("instruction");
    const result = await runner.done;

    // maxLLMCalls=1 lets the first turn stream normally, then the next loop
    // iteration enters the budget-exhausted branch which makes a final summary
    // call with tools=[]. So at most 2 stream invocations under the cap.
    expect(streamInvocations).toBeLessThanOrEqual(2);
    expect(result.terminal).toEqual({ kind: "budget_exhausted" });
  });

});

// Characterization tests that pin the runner's pre-phase-3 behavior so the
// runtime-assembly / assistant-turn-stream refactor cannot drift.
describe("LiveAgent runtime assembly + stream characterization", () => {
  test("priorMessages skips instruction seeding", async () => {
    const observedMessages: ReadonlyArray<{ kind: string; content: unknown }>[] = [];
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        // Chat path: trailing-user IS the current instruction; no seed.
        conversation: { kind: "replay", priorMessages: [{ kind: "user", content: "external history user" }] },
        onEvent: () => {},
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(opts: StreamOptions) {
          observedMessages.push(opts.messages.map((m) => ({ kind: m.kind, content: m.content })));
          yield { kind: "done", stopReason: "end_turn" } as const;
        },
      }),
    );

    runner.send("instruction");
    await runner.done;

    // Exactly one streamed turn. The model saw priorMessages and no
    // instruction-seed turn was appended.
    expect(observedMessages.length).toBe(1);
    const turn = observedMessages[0]!;
    expect(turn.length).toBe(1);
    expect(turn[0]).toEqual({ kind: "user", content: "external history user" });
  });

  test("provider receives a session identity equal to the runtime conversation id", async () => {
    let observedCacheKey: string | undefined;
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        onEvent: () => {},
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(opts: StreamOptions) {
          observedCacheKey = opts.providerSessionKey;
          yield { kind: "done", stopReason: "end_turn" } as const;
        },
      }),
    );

    runner.send("hi");
    await runner.done;
    expect(observedCacheKey).toBe(runner.providerSessionKey);
  });

  test("provider request identity equals the providerSessionKey when one is supplied", async () => {
    let observedCacheKey: string | undefined;
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        conversation: { kind: "replay", priorMessages: [], providerSessionKey: "resume-xyz" },
        onEvent: () => {},
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(opts: StreamOptions) {
          observedCacheKey = opts.providerSessionKey;
          yield { kind: "done", stopReason: "end_turn" } as const;
        },
      }),
    );

    runner.send("hi");
    await runner.done;
    expect(observedCacheKey).toBe("resume-xyz");
    expect(runner.providerSessionKey).toBe("resume-xyz");
  });

  test("stream retry updates connection state without producing a render content_block_delta", async () => {
    const events: RuntimeEvent[] = [];
    const connectionStates: ConnectionState[] = [];
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        onEvent: (e) => events.push(e),
        lifecycle: { kind: "one-shot", onConnectionState: (s) => connectionStates.push(s) },
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools() {
          // One transient retry, then the next adapter stream starts silently before real text arrives.
          yield { kind: "stream_retry", attempt: 1, maxAttempts: 3, reason: "boom", delayMs: 1, error: { message: "boom" } } as const;
          yield { kind: "stream_attempt_start", attempt: 1, maxAttempts: 1, isRetry: false, isFinalAttempt: true, sawThinkingStall: false, disableReasoning: false } as const;
          yield { kind: "text_delta", text: "ok", blockKey: "text" } as const;
          yield { kind: "done", stopReason: "end_turn" } as const;
        },
      }),
    );

    runner.send("hi");
    await runner.done;

    expect(connectionStates).toContain("retrying");
    expect(connectionStates).toContain("connected");

    // No content_block_delta event was produced for the retry — only the real
    // text_delta that followed should surface as a delta.
    const deltas = events.filter((e) => e.type === "model.content.delta");
    expect(deltas.length).toBe(1);
  });

  test("interrupt during stream retry clears retrying connection state", async () => {
    const connectionStates: ConnectionState[] = [];
    let markRetrying: () => void = () => {};
    const retrying = new Promise<void>((resolve) => { markRetrying = resolve; });
    const runner = newTestRunner(
      makeOptions({
        agentRegistry: new Map(),
        agentsMd: "",
        onEvent: () => {},
        lifecycle: {
          kind: "one-shot",
          onConnectionState: (s) => {
            connectionStates.push(s);
            if (s === "retrying") markRetrying();
          },
        },
      }),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        promptNotes: { progress: "", modelNotes: "" },
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
        async *streamWithTools(options: StreamOptions) {
          yield { kind: "stream_retry", attempt: 1, maxAttempts: 3, reason: "boom", delayMs: 30_000, error: { message: "boom" } } as const;
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) { resolve(); return; }
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw options.signal?.reason;
        },
      }),
    );

    runner.send("hi");
    await retrying;

    expect(runner.interruptGeneration()).toBe(true);
    const result = await runner.done;

    // A per-turn interrupt with no park destination is the interrupted
    // terminal, no longer collapsed into aborted.
    expect(result.terminal.kind).toBe("interrupted");
    expect(connectionStates).toEqual(["retrying"]);
  });
});
