import { describe, expect, test } from "bun:test";

import { getEngine, registerEngine } from "../src/orchestration/engines/core/registry";
import { HarnessRunner } from "../src/orchestration/engines/providers/harness/runner";
import { emitAssistant, emitToolResult, emitContentBlockDelta, emitResult } from "../src/orchestration/engines/providers/harness/emit";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { RunnerOptions } from "../src/orchestration/engines/core/types";

// Force engine registration
import "../src/orchestration/engines/providers/harness/register";

describe("harness engine registration", () => {
  test("getEngine('harness') returns engine with correct metadata", () => {
    const engine = getEngine("harness");
    expect(engine.metadata.id).toBe("harness");
    expect(engine.metadata.name).toBe("Flywheel Harness");
    expect(engine.metadata.defaultModel).toBe("claude-opus-4-7");
    expect(engine.metadata.description).toBe("Direct LLM API engine (Anthropic + OpenAI)");
  });

  test("engine has createRunner method", () => {
    const engine = getEngine("harness");
    expect(typeof engine.createRunner).toBe("function");
  });
});

describe("HarnessRunner", () => {
  function makeOptions(overrides?: Partial<RunnerOptions>): RunnerOptions {
    return {
      model: "claude-haiku-4-5-20251001",
      cwd: "/tmp",
      onEvent: () => {},
      ...overrides,
    };
  }

  function makeFakeClientFactory() {
    return () => {
      throw new Error("Client should not be created in this test");
    };
  }

  test("constructor generates sessionId starting with 'harness-'", () => {
    const runner = new HarnessRunner(makeOptions(), makeFakeClientFactory());
    expect(runner.sessionId).toMatch(/^harness-[0-9a-f-]{36}$/);
  });

  test("sessionId is unique across instances", () => {
    const a = new HarnessRunner(makeOptions(), makeFakeClientFactory());
    const b = new HarnessRunner(makeOptions(), makeFakeClientFactory());
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("abort() causes done to resolve with aborted failure", async () => {
    const events: NDJSONEvent[] = [];
    let rejectStream!: (err: Error) => void;

    const runner = new HarnessRunner(
      makeOptions({
        onEvent: (e) => events.push(e),
      }),
      () => ({
        provider: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        costFor() { return 0; },
        async *streamWithTools() {
          // Block until externally rejected (simulating a real API stream)
          await new Promise<void>((_, reject) => {
            rejectStream = reject;
          });
        },
        async complete() {
          return "";
        },
      }),
    );

    runner.send("test instruction");
    // Let the loop enter streamWithTools
    await new Promise((r) => setTimeout(r, 30));

    // Abort triggers the controller, then reject the stream to unblock
    runner.abort();
    rejectStream(new DOMException("aborted", "AbortError"));

    const result = await runner.done;
    expect(result.failure).toBeDefined();
    expect(result.failure!.kind).toBe("aborted");
    expect(result.sessionId).toBe(runner.sessionId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("done promise exists immediately after construction", () => {
    const runner = new HarnessRunner(makeOptions(), makeFakeClientFactory());
    expect(runner.done).toBeInstanceOf(Promise);
  });
});

describe("emit helpers", () => {
  test("emitAssistant creates assistant event with content and usage", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitAssistant(emit, [{ type: "text", text: "hello" }], { input_tokens: 100 });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("assistant");
    expect(events[0]!.data.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(events[0]!.data.message.usage.input_tokens).toBe(100);
  });

  test("emitToolResult creates tool_result event", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitToolResult(emit, "tool-123", "result text", false);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_result");
    expect(events[0]!.data.tool_use_id).toBe("tool-123");
    expect(events[0]!.data.content).toBe("result text");
    expect(events[0]!.data.is_error).toBe(false);
  });

  test("emitContentBlockDelta creates content_block_delta event", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitContentBlockDelta(emit, { type: "text_delta", text: "chunk" });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("content_block_delta");
    expect(events[0]!.data.delta.type).toBe("text_delta");
    expect(events[0]!.data.delta.text).toBe("chunk");
  });

  test("emitResult includes total_cost_usd for budget tracker", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitResult(emit, {
      totalCostUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      sessionId: "harness-abc",
      contextWindow: 200_000,
    });

    expect(events).toHaveLength(1);
    const data = events[0]!.data;
    expect(data.type).toBe("result");
    expect(data.total_cost_usd).toBe(0.05);
    expect(data.usage.input_tokens).toBe(1000);
    expect(data.usage.output_tokens).toBe(500);
    expect(data.modelUsage).toEqual({ default: { contextWindow: 200_000 } });
  });

  test("emitResult omits modelUsage when no contextWindow", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitResult(emit, {
      totalCostUsd: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      sessionId: "harness-abc",
    });

    expect(events[0]!.data.modelUsage).toBeUndefined();
  });

  test("emitResult event passes ResultCostSchema validation", () => {
    // Import the schema used by the budget tracker
    const { ResultCostSchema } = require("../src/orchestration/session/budget-tracker-types");

    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitResult(emit, {
      totalCostUsd: 0.123,
      inputTokens: 2000,
      outputTokens: 800,
      sessionId: "harness-test",
    });

    const parsed = ResultCostSchema.safeParse(events[0]!.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.total_cost_usd).toBe(0.123);
  });

  test("emitResult lazy raw serialization works", () => {
    const events: NDJSONEvent[] = [];
    const emit = (e: NDJSONEvent) => events.push(e);

    emitResult(emit, {
      totalCostUsd: 0.05,
      inputTokens: 100,
      outputTokens: 50,
      sessionId: "harness-raw",
    });

    const raw = events[0]!.raw;
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("result");
    expect(parsed.total_cost_usd).toBe(0.05);
  });
});
