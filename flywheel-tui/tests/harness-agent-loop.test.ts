import { describe, expect, test } from "bun:test";

import { createTokenCounter } from "../src/orchestration/engines/providers/harness/context/token-counter.js";
import { unwindMessages } from "../src/orchestration/engines/providers/harness/context/summarizer.js";
import { buildHarnessSystemPrompt } from "../src/orchestration/engines/providers/harness/prompt.js";
import { runAgentLoop } from "../src/orchestration/engines/providers/harness/agent-loop.js";
import type { LLMClient, Message, StreamEvent, StreamOptions } from "../src/orchestration/engines/providers/harness/llm/types.js";

function makeFakeLLMClient(
  responses: Array<{ events: StreamEvent[] }>,
): LLMClient {
  let callIndex = 0;

  return {
    provider: "anthropic",
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

    expect(result.contextOverflow).toBe(false);
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

    expect(result.contextOverflow).toBe(false);
    // Turn 1 dispatched a tool, turn 2 returned text-only
    expect(events.filter((e) => e.kind === "tool_result").length).toBe(1);
  });
});

describe("buildHarnessSystemPrompt", () => {
  const allTools = new Set(["bash", "write_handoff", "todo_list", "read_image"]);

  test("deprecated string overload still works", () => {
    const prompt = buildHarnessSystemPrompt("My task prompt", "anthropic");
    expect(prompt).toContain("My task prompt");
    expect(prompt).toContain("evaluated against hidden tests");
  });

  test("includes all sections with full tool set", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task", provider: "anthropic", availableTools: allTools,
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
      provider: "anthropic",
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
      provider: "anthropic",
      projectInstructions: "Project CLAUDE.md content",
      availableTools: new Set(["write_handoff"]),
    });
    expect(prompt).not.toContain("Project CLAUDE.md content");
  });

  test("includes project instructions when bash tool present", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task",
      provider: "anthropic",
      projectInstructions: "Project CLAUDE.md content",
      availableTools: new Set(["bash", "write_handoff"]),
    });
    expect(prompt).toContain("Project CLAUDE.md content");
  });

  test("orchestration prompt comes first (primacy)", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "ORCHESTRATION_START",
      provider: "anthropic",
      availableTools: allTools,
    });
    const orchIdx = prompt.indexOf("ORCHESTRATION_START");
    const shellIdx = prompt.indexOf("EXECUTION ENVIRONMENT");
    expect(orchIdx).toBeLessThan(shellIdx);
  });

  test("uses openai editing for openai provider", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "Task", provider: "openai", availableTools: allTools,
    });
    expect(prompt).toContain("apply_patch");
    expect(prompt).not.toContain("sed -i");
  });
});
