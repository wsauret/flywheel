import { describe, expect, it } from "bun:test";
import { executeTurn } from "../../src/harness/turn-executor.js";
import type {
  CollectedToolCall,
  ToolCallResult,
  TurnExecutorOptions,
} from "../../src/harness/turn-executor.js";
import { FakeLLMProvider } from "../fixtures/fake-llm-provider.js";
import { createToolRegistry } from "../../src/harness/tools/registry.js";
import type { HarnessTool, ToolContext, ToolResult } from "../../src/harness/tools/types.js";
import type { StreamEvent, StreamOptions } from "../../src/harness/llm.js";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeToolContext(): ToolContext {
  return { cwd: "/tmp/test", env: {} };
}

function makeStreamOptions(): StreamOptions {
  return {
    model: "test-model",
    system: "You are a test agent.",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 1024,
  };
}

function makeEchoTool(): HarnessTool {
  return {
    name: "echo",
    description: "Echoes input back",
    inputSchema: z.object({
      text: z.string(),
    }),
    concurrency: "shared",
    async execute(input: unknown): Promise<ToolResult> {
      const parsed = input as { text: string };
      return { content: `Echo: ${parsed.text}` };
    },
  };
}

function makeFailingTool(): HarnessTool {
  return {
    name: "fail_tool",
    description: "Always fails",
    inputSchema: z.object({
      reason: z.string(),
    }),
    concurrency: "shared",
    async execute(): Promise<ToolResult> {
      return { content: "Something went wrong", isError: true };
    },
  };
}

function makeOptions(
  provider: FakeLLMProvider,
  tools: HarnessTool[] = [],
  callbacks: Partial<TurnExecutorOptions> = {},
): TurnExecutorOptions {
  const registry = createToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return {
    provider,
    registry,
    streamOptions: makeStreamOptions(),
    toolContext: makeToolContext(),
    ...callbacks,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Text collection
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — text collection", () => {
  it("collects text deltas from stream", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "message_stop" },
    ]);

    const result = await executeTurn(makeOptions(provider));

    expect(result.textContent).toBe("Hello world");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolResults).toHaveLength(0);
    expect(result.completionAttempt).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("collects thinking content", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "thinking", thinking: "Let me think..." },
      { type: "thinking", thinking: " about this." },
      { type: "text_delta", text: "Answer" },
      { type: "message_stop" },
    ]);

    const result = await executeTurn(makeOptions(provider));

    expect(result.thinkingContent).toBe("Let me think... about this.");
    expect(result.textContent).toBe("Answer");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool dispatch
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — tool dispatch", () => {
  it("collects tool calls and dispatches them", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { text: "hello" },
      },
      { type: "message_stop" },
    ]);

    const echoTool = makeEchoTool();
    const result = await executeTurn(makeOptions(provider, [echoTool]));

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("echo");
    expect(result.toolCalls[0]!.input).toEqual({ text: "hello" });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.content).toBe("Echo: hello");
    expect(result.toolResults[0]!.isError).toBe(false);
    expect(result.toolResults[0]!.toolCallId).toBe("call_1");
  });

  it("handles tool execution errors", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "fail_tool",
        input: { reason: "broken" },
      },
      { type: "message_stop" },
    ]);

    const failTool = makeFailingTool();
    const result = await executeTurn(makeOptions(provider, [failTool]));

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toBe("Something went wrong");
  });

  it("handles unknown tool gracefully", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "nonexistent_tool",
        input: {},
      },
      { type: "message_stop" },
    ]);

    const result = await executeTurn(makeOptions(provider));

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toContain("Unknown tool");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Intent extraction
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — intent extraction", () => {
  it("strips intent (_i) from tool inputs before execution", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { text: "hello", _i: "Testing the echo tool" },
      },
      { type: "message_stop" },
    ]);

    let executedInput: unknown = null;
    const echoTool: HarnessTool = {
      name: "echo",
      description: "Echoes input",
      inputSchema: z.object({ text: z.string() }),
      concurrency: "shared",
      async execute(input: unknown): Promise<ToolResult> {
        executedInput = input;
        return { content: "ok" };
      },
    };

    const result = await executeTurn(makeOptions(provider, [echoTool]));

    expect(result.toolCalls[0]!.intent).toBe("Testing the echo tool");
    // The _i field should have been removed from input before execution
    expect(result.toolCalls[0]!.input).not.toHaveProperty("_i");
    // The tool received input without _i
    expect(executedInput).toEqual({ text: "hello" });
  });

  it("handles missing intent gracefully", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { text: "no intent here" },
      },
      { type: "message_stop" },
    ]);

    const result = await executeTurn(makeOptions(provider, [makeEchoTool()]));

    expect(result.toolCalls[0]!.intent).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Task completion detection
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — task_complete detection", () => {
  it("detects task_complete and extracts handoff without dispatching", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_completion",
        name: "task_complete",
        input: {
          summary: "Task completed successfully with all tests passing and verified.",
        },
      },
      { type: "message_stop" },
    ]);

    // Register a dummy task_complete tool (shouldn't be called via registry)
    const registry = createToolRegistry();

    const result = await executeTurn({
      provider,
      registry,
      streamOptions: makeStreamOptions(),
      toolContext: makeToolContext(),
    });

    expect(result.completionAttempt).toEqual({
      summary: "Task completed successfully with all tests passing and verified.",
    });

    // task_complete tool results should have a placeholder
    const completionResult = result.toolResults.find(
      (r) => r.name === "task_complete",
    );
    expect(completionResult).toBeDefined();
    expect(completionResult!.content).toContain("Completion request received");
    expect(completionResult!.isError).toBe(false);
  });

  it("separates task_complete from regular tool calls", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { text: "before completion" },
      },
      {
        type: "tool_use",
        id: "call_2",
        name: "task_complete",
        input: {
          summary: "Done with the work, everything is verified and tested.",
        },
      },
      { type: "message_stop" },
    ]);

    const result = await executeTurn(makeOptions(provider, [makeEchoTool()]));

    // Regular tool call was dispatched
    const echoResult = result.toolResults.find((r) => r.name === "echo");
    expect(echoResult).toBeDefined();
    expect(echoResult!.content).toBe("Echo: before completion");

    // task_complete was intercepted
    expect(result.completionAttempt).toEqual({
      summary: "Done with the work, everything is verified and tested.",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Output truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — output truncation", () => {
  it("applies output truncation to large tool results", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      {
        type: "tool_use",
        id: "call_1",
        name: "big_output",
        input: {},
      },
      { type: "message_stop" },
    ]);

    // Tool that produces a very large output (> 50KB)
    const bigTool: HarnessTool = {
      name: "big_output",
      description: "Produces large output",
      inputSchema: z.object({}),
      concurrency: "shared",
      async execute(): Promise<ToolResult> {
        return { content: "x".repeat(100_000) };
      },
    };

    const result = await executeTurn(makeOptions(provider, [bigTool]));

    expect(result.toolResults[0]!.content.length).toBeLessThan(100_000);
    expect(result.toolResults[0]!.content).toContain("truncated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Callbacks
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — callbacks", () => {
  it("calls event callbacks during execution", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "text_delta", text: "Hello" },
      { type: "thinking", thinking: "thinking..." },
      {
        type: "tool_use",
        id: "call_1",
        name: "echo",
        input: { text: "test" },
      },
      { type: "message_stop" },
    ]);

    const textDeltas: string[] = [];
    const thinkingChunks: string[] = [];
    const toolUses: CollectedToolCall[] = [];
    const toolResults: ToolCallResult[] = [];

    await executeTurn(
      makeOptions(provider, [makeEchoTool()], {
        onTextDelta: (text) => textDeltas.push(text),
        onThinking: (thinking) => thinkingChunks.push(thinking),
        onToolUse: (call) => toolUses.push(call),
        onToolResult: (result) => toolResults.push(result),
      }),
    );

    expect(textDeltas).toEqual(["Hello"]);
    expect(thinkingChunks).toEqual(["thinking..."]);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.name).toBe("echo");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.content).toBe("Echo: test");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stream errors
// ═══════════════════════════════════════════════════════════════════════════

describe("executeTurn — stream errors", () => {
  it("throws on stream error events", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "text_delta", text: "partial" },
      { type: "error", error: new Error("Stream failed") },
    ]);

    await expect(
      executeTurn(makeOptions(provider)),
    ).rejects.toThrow("Stream failed");
  });

  it("throws when provider.stream() itself throws", async () => {
    const provider = new FakeLLMProvider();
    provider.setError(new Error("Connection refused"));

    await expect(
      executeTurn(makeOptions(provider)),
    ).rejects.toThrow("Connection refused");
  });
});
