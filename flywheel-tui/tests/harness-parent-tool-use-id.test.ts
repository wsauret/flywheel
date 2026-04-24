import { describe, expect, test } from "bun:test";

import { HarnessRunner } from "../src/orchestration/engines/providers/harness/runner";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { RunnerOptions } from "../src/orchestration/engines/core/types";
import type { LLMClient } from "../src/orchestration/engines/providers/harness/llm/types";

function makeOptions(overrides?: Partial<RunnerOptions>): RunnerOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    cwd: "/tmp",
    onEvent: () => {},
    ...overrides,
  };
}

function makeFakeClient(): LLMClient {
  return {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    costFor({ input, output }) { return (input + output) / 1000; },
    async *streamWithTools() {
      // Emit one of every event type that flows through the onEvent handler.
      yield { kind: "text_delta", text: "streamed text" } as const;
      yield {
        kind: "tool_result",
        toolCallId: "tc-from-stream",
        content: "bogus",
      } as const;
      yield { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    },
    async complete() {
      return "";
    },
  };
}

describe("HarnessRunner parentToolUseId threading", () => {
  test("tags every nested event with parent_tool_use_id when set", async () => {
    const events: NDJSONEvent[] = [];
    const runner = new HarnessRunner(
      makeOptions({
        parentToolUseId: "parent-abc",
        onEvent: (e) => events.push(e),
      }),
      () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const assistantEvents = events.filter((e) => e.type === "assistant");
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    const contentBlockDeltaEvents = events.filter((e) => e.type === "content_block_delta");
    const resultEvents = events.filter((e) => e.type === "result");

    expect(assistantEvents.length).toBeGreaterThan(0);
    expect(toolResultEvents.length).toBeGreaterThan(0);
    expect(contentBlockDeltaEvents.length).toBeGreaterThan(0);
    expect(resultEvents.length).toBe(1);

    for (const e of assistantEvents) {
      expect(e.data.message?.parent_tool_use_id).toBe("parent-abc");
    }
    for (const e of toolResultEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
    for (const e of contentBlockDeltaEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
    for (const e of resultEvents) {
      expect(e.data.parent_tool_use_id).toBe("parent-abc");
    }
  });

  test("user events never carry parent_tool_use_id even when set", async () => {
    const events: NDJSONEvent[] = [];
    const runner = new HarnessRunner(
      makeOptions({
        parentToolUseId: "parent-abc",
        onEvent: (e) => events.push(e),
      }),
      () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const userEvents = events.filter((e) => e.type === "user");
    expect(userEvents.length).toBeGreaterThan(0);
    for (const e of userEvents) {
      const content = e.data as { parent_tool_use_id?: string };
      expect(content.parent_tool_use_id).toBeUndefined();
    }
  });

  test("omits parent_tool_use_id when parentToolUseId is not set", async () => {
    const events: NDJSONEvent[] = [];
    const runner = new HarnessRunner(
      makeOptions({
        onEvent: (e) => events.push(e),
      }),
      () => makeFakeClient(),
    );

    runner.send("instruction");
    await runner.done;

    const assistantEvents = events.filter((e) => e.type === "assistant");
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    const contentBlockDeltaEvents = events.filter((e) => e.type === "content_block_delta");
    const resultEvents = events.filter((e) => e.type === "result");

    for (const e of assistantEvents) {
      expect(e.data.message?.parent_tool_use_id).toBeUndefined();
    }
    for (const e of toolResultEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
    for (const e of contentBlockDeltaEvents) {
      expect(e.data.parent_tool_use_id).toBeUndefined();
    }
    for (const e of resultEvents) {
      expect((e.data as { parent_tool_use_id?: string }).parent_tool_use_id).toBeUndefined();
    }
  });
});

describe("HarnessRunner maxLLMCalls and agentRegistry options", () => {
  test("honors maxLLMCalls by forcing a final summary turn", async () => {
    const events: NDJSONEvent[] = [];
    let streamInvocations = 0;
    const runner = new HarnessRunner(
      makeOptions({
        maxLLMCalls: 1,
        onEvent: (e) => events.push(e),
      }),
      () => ({
        accessProvider: "anthropic_api",
        modelFamily: "anthropic",
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        costFor() { return 0; },
        async *streamWithTools() {
          streamInvocations++;
          if (streamInvocations > 3) {
            throw new Error("maxLLMCalls=1 did not cap stream invocations");
          }
          yield {
            kind: "tool_use",
            toolCall: { id: `t${streamInvocations}`, name: "todo_list", input: { operation: "read" } },
          } as const;
          yield { kind: "done", stopReason: "tool_use" } as const;
        },
        async complete() {
          return "";
        },
      }),
    );

    runner.send("instruction");
    const result = await runner.done;

    // maxLLMCalls=1 lets the first turn stream normally, then the next loop
    // iteration enters the budget-exhausted branch which makes a final summary
    // call with tools=[]. So at most 2 stream invocations under the cap.
    expect(streamInvocations).toBeLessThanOrEqual(2);
    expect(result.failure?.kind).toBe("budget_exhausted");
  });

  test("skips loadAgentRegistry when agentRegistry is supplied", async () => {
    const events: NDJSONEvent[] = [];
    const registry = new Map();
    const runner = new HarnessRunner(
      makeOptions({
        agentRegistry: registry,
        projectInstructions: "pre-resolved instructions",
        onEvent: (e) => events.push(e),
      }),
      () => makeFakeClient(),
    );

    runner.send("instruction");
    const result = await runner.done;

    expect(result.failure).toBeUndefined();
    // The runner should complete normally — no filesystem rescan required.
    expect(events.length).toBeGreaterThan(0);
  });
});
