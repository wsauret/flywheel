import { describe, expect, test } from "bun:test";

import { createTokenCounter } from "../src/orchestration/engines/providers/harness/context/token-counter.js";
import { unwindMessages } from "../src/orchestration/engines/providers/harness/context/summarizer.js";
import { buildHarnessSystemPrompt } from "../src/orchestration/engines/providers/harness/prompt.js";
import { runAgentLoop } from "../src/orchestration/engines/providers/harness/agent-loop.js";
import type { LLMClient, Message, StreamEvent, StreamOptions, ContentBlock } from "../src/orchestration/engines/providers/harness/llm/types.js";

function makeFakeLLMClient(
  responses: Array<{ events: StreamEvent[] }>,
): LLMClient {
  let callIndex = 0;

  return {
    model: "claude-sonnet-4-5",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,

    async *streamWithTools(_options: StreamOptions): AsyncGenerator<StreamEvent> {
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      for (const event of response.events) {
        yield event;
      }
    },

    async complete(_messages: Message[]): Promise<string> {
      return "mock completion";
    },

    costFor() {
      return 0;
    },
  };
}

describe("token counter", () => {
  test("counts text messages correctly (~4 chars/token)", () => {
    const counter = createTokenCounter();
    counter.addMessage({ role: "user", content: "hello world!" });
    // "hello world!" = 12 chars -> Math.ceil(12/4) = 3 tokens
    expect(counter.total).toBe(3);
  });

  test("handles tool_use blocks (stringified JSON counted via text blocks)", () => {
    const counter = createTokenCounter();
    const toolInput = JSON.stringify({ command: "echo hello", timeout: 30 });
    counter.addMessage({
      role: "assistant",
      content: [{ type: "text", text: `[tool_use: bash] ${toolInput}` }],
    });
    const expectedChars = `[tool_use: bash] ${toolInput}`.length;
    expect(counter.total).toBe(Math.ceil(expectedChars / 4));
  });

  test("maintains running total (no recomputation)", () => {
    const counter = createTokenCounter();
    counter.addMessage({ role: "user", content: "abcd" }); // 4 chars -> 1 token
    expect(counter.total).toBe(1);

    counter.addMessage({ role: "assistant", content: "efghijkl" }); // 8 chars -> 2 tokens
    expect(counter.total).toBe(3); // running total: 1 + 2

    counter.addToolResult("mnopqrstuvwx"); // 12 chars -> 3 tokens
    expect(counter.total).toBe(6); // running total: 3 + 3
  });

  test("handles image blocks by counting base64 data", () => {
    const counter = createTokenCounter();
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYA"; // 36 chars
    counter.addMessage({
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: imageData }],
    });
    expect(counter.total).toBe(Math.ceil(36 / 4));
  });

  test("handles mixed block types in single message", () => {
    const counter = createTokenCounter();
    counter.addMessage({
      role: "user",
      content: [
        { type: "text", text: "describe this:" }, // 14 chars
        { type: "image", mediaType: "image/png", data: "AAAA" }, // 4 chars
      ],
    });
    // 14 + 4 = 18 chars -> Math.ceil(18/4) = 5 tokens
    expect(counter.total).toBe(5);
  });
});

describe("unwindMessages", () => {
  test("removes from index 1, keeps index 0", () => {
    const messages: Message[] = [
      { role: "user", content: "A".repeat(400) },   // index 0: task instruction
      { role: "assistant", content: "B".repeat(400) }, // index 1
      { role: "user", content: "C".repeat(400) },     // index 2
      { role: "assistant", content: "D".repeat(400) }, // index 3
      { role: "user", content: "E".repeat(400) },     // index 4
    ];
    // 5 messages * 400 chars = 2000 chars -> ~500 tokens
    // contextLimit = 200, so we need to reduce until 200 - tokens >= 4000
    // That's impossible in this test, so it should reduce to just index 0
    unwindMessages(messages, 200);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("A".repeat(400));
  });

  test("on empty array does nothing", () => {
    const messages: Message[] = [];
    unwindMessages(messages, 200);
    expect(messages.length).toBe(0);
  });

  test("on single-message array does nothing", () => {
    const messages: Message[] = [
      { role: "user", content: "task instruction" },
    ];
    unwindMessages(messages, 200);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("task instruction");
  });

  test("preserves index 0 even when context is tight", () => {
    const messages: Message[] = [
      { role: "user", content: "A".repeat(100) },
      { role: "assistant", content: "B".repeat(100) },
      { role: "user", content: "C".repeat(100) },
    ];
    // 300 chars -> 75 tokens. contextLimit = 50 -> free = 50-75 = -25 < 4000
    // Should remove pairs from index 1 until only index 0 remains
    unwindMessages(messages, 50);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("A".repeat(100));
  });
});

describe("agent loop", () => {
  test("exits on text-only response (no tools)", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "Task is complete." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: [],
      systemPrompt: "You are a helpful assistant.",
      instruction: "Do something",
      cwd: "/tmp",
      onEvent: (e) => events.push(e),
    });

    expect(result.outcome).toBe("ok");
    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  test("dispatches tools and loops", async () => {
    const toolExecutions: string[] = [];
    const client = makeFakeLLMClient([
      {
        events: [
          {
            kind: "tool_use",
            toolCall: { id: "tc_1", name: "bash", input: { command: "echo hello" } },
          },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Done." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      systemPrompt: "You are a helpful assistant.",
      instruction: "Run a command",
      cwd: "/tmp",
      onEvent: (e) => {
        events.push(e);
        if (e.kind === "tool_result") toolExecutions.push(e.content);
      },
    });

    expect(result.outcome).toBe("ok");
    // Turn 1 dispatched a tool, turn 2 returned text-only
    expect(events.filter((e) => e.kind === "tool_result").length).toBe(1);
  });
});

describe("buildHarnessSystemPrompt", () => {
  const allTools = new Set(["bash", "write_handoff", "todo_list", "read"]);

  test("includes all sections with full tool set", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task", model: "claude-sonnet-4-5", availableTools: allTools,
    });
    expect(prompt).toContain("EXECUTION ENVIRONMENT");
    expect(prompt).toContain("cat > path/to/file");
    expect(prompt).toContain("evaluated against hidden tests");
    expect(prompt).toContain("todo_list(read)");
    expect(prompt).toContain("IRREVERSIBLE AND FINAL");
    expect(prompt).toContain("numeric values");
  });

  test("handoff-only tools omit shell, editing, verification, todo, generalization", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Dispatcher task",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["write_handoff"]),
    });
    expect(prompt).toContain("Dispatcher task");
    expect(prompt).toContain("IRREVERSIBLE AND FINAL");
    expect(prompt).not.toContain("EXECUTION ENVIRONMENT");
    expect(prompt).not.toContain("cat > path/to/file");
    expect(prompt).not.toContain("evaluated against hidden tests");
    expect(prompt).not.toContain("todo_list(read)");
    expect(prompt).not.toContain("numeric values");
  });

  test("omits project instructions when no bash tool", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      projectInstructions: "Project CLAUDE.md content",
      availableTools: new Set(["write_handoff"]),
    });
    expect(prompt).not.toContain("Project CLAUDE.md content");
  });

  test("includes project instructions when bash tool present", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      projectInstructions: "Project CLAUDE.md content",
      availableTools: new Set(["bash", "write_handoff"]),
    });
    expect(prompt).toContain("Project CLAUDE.md content");
  });

  test("orchestration prompt precedes tool sections", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "ORCHESTRATION_START",
      model: "claude-sonnet-4-5",
      availableTools: allTools,
    });
    const orchIdx = prompt.indexOf("ORCHESTRATION_START");
    const shellIdx = prompt.indexOf("EXECUTION ENVIRONMENT");
    expect(orchIdx).toBeLessThan(shellIdx);
  });

  test("uses openai editing for openai provider", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task", model: "gpt-4o", availableTools: allTools,
    });
    expect(prompt).toContain("apply_patch");
    expect(prompt).not.toContain("sed -i");
  });

  test("includes tool usage rules when both bash and read are available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["bash", "read"]),
    });
    expect(prompt).toContain("TOOL USAGE");
    expect(prompt).toContain("`read` tool (not cat/head/tail)");
    expect(prompt).toContain("2>&1");
    expect(prompt).toContain("2>/dev/null");
    expect(prompt).toContain("head/tail");
  });

  test("omits tool usage rules when read tool is absent", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).not.toContain("TOOL USAGE");
  });

  test("omits tool usage rules when bash tool is absent", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["read"]),
    });
    expect(prompt).not.toContain("TOOL USAGE");
  });

  test("todo_list usage includes granular operations, user visibility, and rules", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["todo_list"]),
    });
    expect(prompt).toContain("todo_list(complete)");
    expect(prompt).toContain("todo_list(start)");
    expect(prompt).toContain("todo_list(abandon)");
    expect(prompt).toContain("in_progress");
    expect(prompt).toContain("rendered to the user in real time");
    expect(prompt).toContain("user is watching");
    expect(prompt).toContain("context recovery");
    expect(prompt).toContain("3+ distinct steps");
  });
});

function makeCaptureClient(responses: Array<{ events: StreamEvent[] }>) {
  let callIndex = 0;
  const capturedMessages: Message[][] = [];

  const client: LLMClient = {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      capturedMessages.push([...options.messages]);
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      for (const event of response.events) yield event;
    },
    async complete(_messages: Message[]): Promise<string> {
      return "mock completion";
    },
    costFor() {
      return 0;
    },
  };
  return { client, capturedMessages };
}

describe("per-turn budget injection", () => {
  test("appends budget line to observation messages after tool results", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo hi" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Done." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "do something",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 200,
    });

    expect(capturedMessages.length).toBe(2);
    const secondCallMessages = capturedMessages[1]!;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastUserMsg.role).toBe("user");
    expect(Array.isArray(lastUserMsg.content)).toBe(true);
    const blocks = lastUserMsg.content as ContentBlock[];
    const budgetBlock = blocks.find((b) => b.type === "text" && b.text.includes("[Budget:"));
    expect(budgetBlock).toBeDefined();
    expect((budgetBlock as { type: "text"; text: string }).text).toContain("1/200 calls used");
    expect((budgetBlock as { type: "text"; text: string }).text).toContain("199 remaining");
  });

  test("budget format is [Budget: X/Y calls used, Z remaining]", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo 1" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_2", name: "bash", input: { command: "echo 2" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Done." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "do things",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 50,
    });

    const thirdCallMsgs = capturedMessages[2]!;
    const lastMsg = thirdCallMsgs[thirdCallMsgs.length - 1]!;
    const blocks = lastMsg.content as ContentBlock[];
    const budgetBlock = blocks.find((b) => b.type === "text" && b.text.includes("[Budget:"));
    expect(budgetBlock).toBeDefined();
    expect((budgetBlock as { type: "text"; text: string }).text).toContain("2/50 calls used");
    expect((budgetBlock as { type: "text"; text: string }).text).toContain("48 remaining");
  });

  test("first turn (initial instruction) has no budget line", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "text_delta", text: "Hello" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "say hello",
      cwd: "/tmp",
      onEvent: () => {},
    });

    const firstCallMsgs = capturedMessages[0]!;
    const lastMsg = firstCallMsgs[firstCallMsgs.length - 1]!;
    expect(typeof lastMsg.content).toBe("string");
    expect(lastMsg.content).not.toContain("[Budget:");
  });
});

describe("agent loop safety limits", () => {
  test("terminates after exceeding maxLLMCalls", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo 1" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_2", name: "bash", input: { command: "echo 2" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_3", name: "bash", input: { command: "echo 3" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Summary of progress." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "loop forever",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 3,
    });

    expect(result.outcome).toBe("budget_exhausted");
    expect(capturedMessages.length).toBe(4);
    const finalCallMsgs = capturedMessages[3]!;
    const lastMsg = finalCallMsgs[finalCallMsgs.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(typeof lastMsg.content).toBe("string");
    expect(lastMsg.content).toContain("Budget exhausted");
  });

  test("result outcome is budget_exhausted when limit hit", async () => {
    const { client } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Final." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "work",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 1,
    });

    expect(result.outcome).toBe("budget_exhausted");
  });

  test("budget exhausted message gives model a final response opportunity", async () => {
    const events: StreamEvent[] = [];
    const { client } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Here is my final summary." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "work",
      cwd: "/tmp",
      onEvent: (e) => events.push(e),
      maxLLMCalls: 1,
    });

    expect(events.some((e) => e.kind === "text_delta" && e.text === "Here is my final summary.")).toBe(true);
  });

  test("final call passes tools: [] to prevent further tool use", async () => {
    let finalCallTools: unknown[] | undefined;
    let callIndex = 0;
    const responses = [
      {
        events: [
          { kind: "tool_use" as const, toolCall: { id: "tc_1", name: "bash", input: { command: "echo" } } },
          { kind: "done" as const, stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta" as const, text: "Done." },
          { kind: "done" as const, stopReason: "end_turn" },
        ],
      },
    ];

    const client: LLMClient = {
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      async *streamWithTools(opts: StreamOptions): AsyncGenerator<StreamEvent> {
        if (callIndex === 1) finalCallTools = opts.tools;
        const response = responses[callIndex++];
        if (!response) throw new Error("No more mock responses");
        for (const event of response.events) yield event;
      },
      async complete(): Promise<string> { return ""; },
      costFor() { return 0; },
    };

    await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "work",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 1,
    });

    expect(finalCallTools).toEqual([]);
  });

  test("outcome is ok when loop exits normally", async () => {
    const { client } = makeCaptureClient([
      {
        events: [
          { kind: "text_delta", text: "All done." },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: "test",
      instruction: "do something",
      cwd: "/tmp",
      onEvent: () => {},
      maxLLMCalls: 200,
    });

    expect(result.outcome).toBe("ok");
  });
});
