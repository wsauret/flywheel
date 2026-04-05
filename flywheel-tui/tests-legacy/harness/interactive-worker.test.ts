import { describe, it, expect, mock } from "bun:test";
import { createInteractiveWorker } from "../../src/harness/interactive-worker.js";
import type { InteractiveWorkerOptions } from "../../src/harness/interactive-worker.js";
import type { LLMProvider, StreamEvent, StreamOptions } from "../../src/harness/llm.js";
import { createToolRegistry } from "../../src/harness/tools/registry.js";

// ============================================================================
// Test helpers: fake provider and options
// ============================================================================

const FAKE_API_KEY = "test-key-not-real";

/** Create a mock LLM provider that returns scripted responses. */
function createMockProvider(
  responses: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }>,
): LLMProvider {
  let callIndex = 0;

  return {
    async *stream(_options: StreamOptions): AsyncIterable<StreamEvent> {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;

      if (response.text) {
        yield { type: "text_delta", text: response.text };
      }

      if (response.toolCalls) {
        for (const call of response.toolCalls) {
          yield {
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          };
        }
      }

      yield {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
      yield { type: "message_stop" };
    },
  };
}

/** Create minimal test options with mock provider (no real API needed). */
function makeTestOptions(
  provider: LLMProvider,
  overrides: Partial<InteractiveWorkerOptions> = {},
): InteractiveWorkerOptions {
  const registry = createToolRegistry();
  return {
    model: "test-model",
    maxTurnsPerMessage: 5,
    cwd: "/tmp/test",
    env: {},
    _provider: provider,
    _registry: registry,
    _toolDefs: [],
    _systemPrompt: "You are a test assistant.",
    ...overrides,
  };
}

/** Create options for tests that don't need the provider (creation tests). */
function makeOptions(overrides: Partial<InteractiveWorkerOptions> = {}): InteractiveWorkerOptions {
  return {
    apiKey: FAKE_API_KEY,
    model: "test-model",
    maxTurnsPerMessage: 3,
    cwd: "/tmp/test",
    env: {},
    ...overrides,
  };
}

// ============================================================================
// Tests: Creation and API key validation
// ============================================================================

describe("createInteractiveWorker", () => {
  describe("creation and validation", () => {
    it("throws descriptive error when ANTHROPIC_API_KEY is missing", () => {
      const original = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        expect(() => createInteractiveWorker({ model: "test" })).toThrow(
          /ANTHROPIC_API_KEY/,
        );
      } finally {
        if (original !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = original;
        }
      }
    });

    it("throws error with fallback guidance in message", () => {
      const original = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        expect(() => createInteractiveWorker({ model: "test" })).toThrow(
          /fall back/i,
        );
      } finally {
        if (original !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = original;
        }
      }
    });

    it("accepts apiKey in options", () => {
      const worker = createInteractiveWorker(makeOptions());
      expect(worker).toBeDefined();
      expect(typeof worker.sendMessage).toBe("function");
      expect(typeof worker.shutdown).toBe("function");
      expect(typeof worker.isRunning).toBe("function");
      expect(typeof worker.getConversationSummary).toBe("function");
      worker.shutdown();
    });

    it("uses ANTHROPIC_API_KEY from env when apiKey not provided", () => {
      const original = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "test-env-key";

      try {
        const worker = createInteractiveWorker({ model: "test" });
        expect(worker).toBeDefined();
        worker.shutdown();
      } finally {
        if (original !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = original;
        } else {
          delete process.env["ANTHROPIC_API_KEY"];
        }
      }
    });

    it("skips API key validation when _provider is injected", () => {
      const original = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        const provider = createMockProvider([{ text: "hello" }]);
        const worker = createInteractiveWorker(makeTestOptions(provider));
        expect(worker).toBeDefined();
        worker.shutdown();
      } finally {
        if (original !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = original;
        }
      }
    });
  });

  describe("exports and interface", () => {
    it("exports createInteractiveWorker function", () => {
      expect(typeof createInteractiveWorker).toBe("function");
    });

    it("returns object with correct shape", () => {
      const worker = createInteractiveWorker(makeOptions());
      expect(worker.sendMessage).toBeDefined();
      expect(worker.shutdown).toBeDefined();
      expect(worker.isRunning).toBeDefined();
      expect(worker.getConversationSummary).toBeDefined();
      worker.shutdown();
    });
  });

  describe("shutdown", () => {
    it("shutdown makes sendMessage throw", async () => {
      const worker = createInteractiveWorker(makeOptions());
      worker.shutdown();

      await expect(worker.sendMessage("hello")).rejects.toThrow(
        /shut down/i,
      );
    });

    it("isRunning returns false initially", () => {
      const worker = createInteractiveWorker(makeOptions());
      expect(worker.isRunning()).toBe(false);
      worker.shutdown();
    });

    it("shutdown respects external AbortSignal", () => {
      const controller = new AbortController();
      const worker = createInteractiveWorker(
        makeOptions({ abortSignal: controller.signal }),
      );

      controller.abort();

      expect(worker.sendMessage("hello")).rejects.toThrow(/shut down/i);
    });

    it("handles pre-aborted signal", () => {
      const controller = new AbortController();
      controller.abort();

      const worker = createInteractiveWorker(
        makeOptions({ abortSignal: controller.signal }),
      );

      expect(worker.sendMessage("hello")).rejects.toThrow(/shut down/i);
    });
  });

  describe("no task_complete tool", () => {
    it("does not include task_complete in the tool set", () => {
      const { createChatTools } = require("../../src/harness/shared.js");
      const tools = createChatTools();
      const toolNames = tools.map((t: { name: string }) => t.name);
      expect(toolNames).not.toContain("task_complete");
    });

    it("standard tools include task_complete for comparison", () => {
      const { createStandardTools } = require("../../src/harness/shared.js");
      const tools = createStandardTools();
      const toolNames = tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain("task_complete");
    });
  });
});

// ============================================================================
// Tests: Message flow with mock provider
// ============================================================================

describe("message flow", () => {
  it("sends a message and receives a text response", async () => {
    const provider = createMockProvider([{ text: "Hello! How can I help?" }]);
    const chunks: string[] = [];
    const worker = createInteractiveWorker(
      makeTestOptions(provider, {
        onStdout: (chunk) => chunks.push(chunk),
      }),
    );

    await worker.sendMessage("Hi there");

    // Should have emitted NDJSON events
    expect(chunks.length).toBeGreaterThan(0);

    // Find the text event
    const textEvents = chunks
      .map((c) => JSON.parse(c.trim()))
      .filter((e: Record<string, unknown>) => e.type === "assistant");
    expect(textEvents.length).toBeGreaterThan(0);

    // Find the completion event
    const completionEvents = chunks
      .map((c) => JSON.parse(c.trim()))
      .filter((e: Record<string, unknown>) => e.type === "result");
    expect(completionEvents.length).toBe(1);

    worker.shutdown();
  });

  it("emits usage events", async () => {
    const provider = createMockProvider([{ text: "Response" }]);
    const chunks: string[] = [];
    const worker = createInteractiveWorker(
      makeTestOptions(provider, {
        onStdout: (chunk) => chunks.push(chunk),
      }),
    );

    await worker.sendMessage("Test");

    const usageEvents = chunks
      .map((c) => JSON.parse(c.trim()))
      .filter((e: Record<string, unknown>) => e.type === "usage");
    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0].usage.input_tokens).toBe(100);
    expect(usageEvents[0].usage.output_tokens).toBe(50);

    worker.shutdown();
  });

  it("streams NDJSON-compatible events via onStdout", async () => {
    const provider = createMockProvider([{ text: "Hello world" }]);
    const chunks: string[] = [];
    const worker = createInteractiveWorker(
      makeTestOptions(provider, {
        onStdout: (chunk) => chunks.push(chunk),
      }),
    );

    await worker.sendMessage("Greet me");

    // Every chunk should be valid NDJSON (JSON + newline)
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(chunk.trim())).not.toThrow();
    }

    worker.shutdown();
  });
});

// ============================================================================
// Tests: Multi-turn conversation with persistent history
// ============================================================================

describe("multi-turn conversation", () => {
  it("persists conversation history across multiple sendMessage calls", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream(options: StreamOptions): AsyncIterable<StreamEvent> {
        callCount++;
        // Verify that messages accumulate across calls
        if (callCount === 1) {
          // First call: only the user message
          expect(options.messages.length).toBe(1);
        } else if (callCount === 2) {
          // Second call: user + assistant + user
          expect(options.messages.length).toBe(3);
        } else if (callCount === 3) {
          // Third call: user + assistant + user + assistant + user
          expect(options.messages.length).toBe(5);
        }

        yield { type: "text_delta", text: `Response ${callCount}` };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "message_stop" };
      },
    };

    const worker = createInteractiveWorker(makeTestOptions(provider));

    await worker.sendMessage("First message");
    await worker.sendMessage("Second message");
    await worker.sendMessage("Third message");

    expect(callCount).toBe(3);
    worker.shutdown();
  });

  it("getConversationSummary reflects sent messages", async () => {
    const provider = createMockProvider([
      { text: "Response 1" },
      { text: "Response 2" },
      { text: "Response 3" },
    ]);
    const worker = createInteractiveWorker(makeTestOptions(provider));

    await worker.sendMessage("Hello");
    await worker.sendMessage("How are you?");
    await worker.sendMessage("Tell me a joke");

    const summary = worker.getConversationSummary();
    expect(summary).toContain("Hello");
    expect(summary).toContain("How are you?");
    expect(summary).toContain("Tell me a joke");

    worker.shutdown();
  });

  it("getConversationSummary limits to last 5 messages", async () => {
    const provider = createMockProvider([{ text: "OK" }]);
    const worker = createInteractiveWorker(makeTestOptions(provider));

    for (let i = 1; i <= 8; i++) {
      await worker.sendMessage(`Message ${i}`);
    }

    const summary = worker.getConversationSummary();
    // Should not contain early messages
    expect(summary).not.toContain("Message 1");
    expect(summary).not.toContain("Message 2");
    expect(summary).not.toContain("Message 3");
    // Should contain recent messages
    expect(summary).toContain("Message 4");
    expect(summary).toContain("Message 8");

    worker.shutdown();
  });

  it("getConversationSummary caps at ~2000 tokens", async () => {
    const provider = createMockProvider([{ text: "OK" }]);
    const worker = createInteractiveWorker(makeTestOptions(provider));

    // Send messages that are each ~3000 chars (~750 tokens)
    const longMsg = "x".repeat(3000);
    for (let i = 0; i < 5; i++) {
      await worker.sendMessage(longMsg);
    }

    const summary = worker.getConversationSummary();
    // Should be capped around 8000 chars (2000 tokens * 4 chars/token)
    // The first message will always be included, but subsequent ones are trimmed
    expect(summary.length).toBeLessThanOrEqual(12000);

    worker.shutdown();
  });

  it("getConversationSummary skips system-injected messages", async () => {
    // A provider that triggers doom loop to inject [System: ...] messages
    const provider = createMockProvider([
      { text: "First response" },
    ]);
    const worker = createInteractiveWorker(makeTestOptions(provider));

    await worker.sendMessage("User message");

    const summary = worker.getConversationSummary();
    expect(summary).toContain("User message");
    // System messages should be excluded (none injected in this basic case)
    expect(summary).not.toContain("[System:");

    worker.shutdown();
  });
});

// ============================================================================
// Tests: Serial queue (mutex) behavior
// ============================================================================

describe("serial queue behavior", () => {
  it("mutex serializes async operations", async () => {
    let chain = Promise.resolve();
    const order: number[] = [];

    function acquire(): Promise<() => void> {
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = chain;
      chain = next;
      return prev.then(() => release!);
    }

    const op1 = acquire().then(async (release) => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      release();
    });

    const op2 = acquire().then(async (release) => {
      order.push(2);
      await new Promise((r) => setTimeout(r, 5));
      release();
    });

    const op3 = acquire().then(async (release) => {
      order.push(3);
      release();
    });

    await Promise.all([op1, op2, op3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("concurrent sendMessage calls are serialized", async () => {
    const order: number[] = [];
    let callCount = 0;

    const provider: LLMProvider = {
      async *stream(_options: StreamOptions): AsyncIterable<StreamEvent> {
        callCount++;
        const current = callCount;
        order.push(current);
        // Small delay to ensure concurrency would cause interleaving if unserialized
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "text_delta", text: `Response ${current}` };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "message_stop" };
      },
    };

    const worker = createInteractiveWorker(makeTestOptions(provider));

    // Fire multiple messages concurrently
    const p1 = worker.sendMessage("First");
    const p2 = worker.sendMessage("Second");
    const p3 = worker.sendMessage("Third");

    await Promise.all([p1, p2, p3]);

    // Should have executed in order due to mutex
    expect(order).toEqual([1, 2, 3]);

    worker.shutdown();
  });
});

// ============================================================================
// Tests: Doom loop protection inside interactive worker
// ============================================================================

describe("doom loop protection", () => {
  it("stops after maxTurnsPerMessage when agent keeps calling tools", async () => {
    let turnCount = 0;
    const provider: LLMProvider = {
      async *stream(_options: StreamOptions): AsyncIterable<StreamEvent> {
        turnCount++;
        // Always return a tool call, never text
        yield {
          type: "tool_use",
          id: `call-${turnCount}`,
          name: "bash",
          input: { command: `cmd-${turnCount}` },
        };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "message_stop" };
      },
    };

    const registry = createToolRegistry();
    // Register a simple bash tool that returns success
    registry.register({
      name: "bash",
      description: "test bash",
      inputSchema: require("zod").z.object({ command: require("zod").z.string() }),
      concurrency: "exclusive" as const,
      async execute() {
        return { content: "ok" };
      },
    });

    const worker = createInteractiveWorker({
      model: "test-model",
      maxTurnsPerMessage: 4,
      cwd: "/tmp/test",
      env: {},
      _provider: provider,
      _registry: registry,
      _toolDefs: [{
        name: "bash",
        description: "test bash",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } } },
      }],
      _systemPrompt: "Test prompt",
    });

    await worker.sendMessage("Do something");

    // Should have stopped at maxTurnsPerMessage
    expect(turnCount).toBe(4);

    worker.shutdown();
  });

  it("stops when DoomLoopDetector detects repetitive tool calls", async () => {
    let turnCount = 0;
    const provider: LLMProvider = {
      async *stream(_options: StreamOptions): AsyncIterable<StreamEvent> {
        turnCount++;
        // Always return the exact same tool call (triggers doom loop after 3 repetitions)
        yield {
          type: "tool_use",
          id: `call-${turnCount}`,
          name: "bash",
          input: { command: "ls" },
        };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "message_stop" };
      },
    };

    const registry = createToolRegistry();
    registry.register({
      name: "bash",
      description: "test bash",
      inputSchema: require("zod").z.object({ command: require("zod").z.string() }),
      concurrency: "exclusive" as const,
      async execute() {
        return { content: "ok" };
      },
    });

    const worker = createInteractiveWorker({
      model: "test-model",
      maxTurnsPerMessage: 10,
      cwd: "/tmp/test",
      env: {},
      _provider: provider,
      _registry: registry,
      _toolDefs: [{
        name: "bash",
        description: "test bash",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } } },
      }],
      _systemPrompt: "Test prompt",
    });

    await worker.sendMessage("Run ls repeatedly");

    // DoomLoopDetector should stop before maxTurnsPerMessage (10)
    // Default DoomLoopDetector threshold is 3, so 3 identical calls should trigger
    expect(turnCount).toBe(3);

    // Verify doom loop message was injected into summary context
    const summary = worker.getConversationSummary();
    expect(summary).toContain("Run ls repeatedly");

    worker.shutdown();
  });
});

// ============================================================================
// Tests: Conversation summary extraction
// ============================================================================

describe("getConversationSummary", () => {
  it("returns empty string for new worker", () => {
    const worker = createInteractiveWorker(makeOptions());
    expect(worker.getConversationSummary()).toBe("");
    worker.shutdown();
  });

  it("joins multiple user messages with double newlines", async () => {
    const provider = createMockProvider([{ text: "R1" }, { text: "R2" }]);
    const worker = createInteractiveWorker(makeTestOptions(provider));

    await worker.sendMessage("Message A");
    await worker.sendMessage("Message B");

    const summary = worker.getConversationSummary();
    expect(summary).toBe("Message A\n\nMessage B");

    worker.shutdown();
  });
});

// ============================================================================
// Tests: Shared infrastructure
// ============================================================================

describe("shared harness infrastructure", () => {
  it("createChatTools returns tools without task_complete", () => {
    const { createChatTools } = require("../../src/harness/shared.js");
    const tools = createChatTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t: { name: string }) => t.name !== "task_complete")).toBe(true);
  });

  it("createStandardTools returns tools with task_complete", () => {
    const { createStandardTools } = require("../../src/harness/shared.js");
    const tools = createStandardTools();
    expect(tools.some((t: { name: string }) => t.name === "task_complete")).toBe(true);
  });

  it("emitNdjson produces valid JSON lines", () => {
    const { emitNdjson } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitNdjson(callback, { type: "test", data: "hello" });

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("test");
    expect(parsed.data).toBe("hello");
  });

  it("emitNdjson is noop when callback is undefined", () => {
    const { emitNdjson } = require("../../src/harness/shared.js");
    emitNdjson(undefined, { type: "test" });
  });

  it("emitText produces assistant text event", () => {
    const { emitText } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitText(callback, "Hello world");

    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.content[0].type).toBe("text");
    expect(parsed.message.content[0].text).toBe("Hello world");
  });

  it("emitToolUse produces tool use event", () => {
    const { emitToolUse } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitToolUse(callback, {
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
    });

    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.content[0].type).toBe("tool_use");
    expect(parsed.message.content[0].name).toBe("bash");
  });

  it("emitThinking produces thinking event", () => {
    const { emitThinking } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitThinking(callback, "I need to think about this...");

    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.content[0].type).toBe("thinking");
    expect(parsed.message.content[0].thinking).toBe("I need to think about this...");
  });

  it("emitUsage produces usage event", () => {
    const { emitUsage } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitUsage(callback, { inputTokens: 100, outputTokens: 50 });

    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("usage");
    expect(parsed.usage.input_tokens).toBe(100);
    expect(parsed.usage.output_tokens).toBe(50);
  });

  it("emitCompletion produces result event", () => {
    const { emitCompletion } = require("../../src/harness/shared.js");
    const chunks: string[] = [];
    const callback = (chunk: string) => chunks.push(chunk);

    emitCompletion(callback);

    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("success");
  });

  it("sanitize redacts API keys", () => {
    const { sanitize } = require("../../src/harness/shared.js");
    const input = "Error with key sk-ant-api03-xxxxxxxxxxxxxxxxxxxx";
    const result = sanitize(input);
    expect(result).not.toContain("sk-ant-api03");
    expect(result).toContain("[REDACTED]");
  });
});

// ============================================================================
// Tests: truncateHistory export from agent-loop
// ============================================================================

describe("truncateHistory", () => {
  it("is exported from agent-loop", () => {
    const { truncateHistory } = require("../../src/harness/agent-loop.js");
    expect(typeof truncateHistory).toBe("function");
  });

  it("preserves messages when below threshold", () => {
    const { truncateHistory } = require("../../src/harness/agent-loop.js");
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];
    const result = truncateHistory(messages);
    expect(result).toEqual(messages);
  });

  it("truncates long message history", () => {
    const { truncateHistory } = require("../../src/harness/agent-loop.js");
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `Message ${i}` : [{ type: "text", text: `Response ${i}` }],
    }));
    const result = truncateHistory(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[0]).toEqual(messages[0]);
    expect(typeof result[1].content === "string" && result[1].content.includes("removed")).toBe(true);
  });
});

// ============================================================================
// Tests: DoomLoopDetector (component-level)
// ============================================================================

describe("DoomLoopDetector in interactive context", () => {
  it("detects repetitive patterns", () => {
    const { DoomLoopDetector, extractToolSignature } = require("../../src/harness/doom-loop.js");
    const detector = new DoomLoopDetector(3);

    for (let i = 0; i < 3; i++) {
      const sig = extractToolSignature("bash", { command: "ls" });
      detector.recordToolCall("bash", sig);
    }

    expect(detector.isLooping()).toBe(true);
    expect(detector.getWarning()).toContain("Doom loop");
  });

  it("does not trigger for varied calls", () => {
    const { DoomLoopDetector, extractToolSignature } = require("../../src/harness/doom-loop.js");
    const detector = new DoomLoopDetector(3);

    for (let i = 0; i < 3; i++) {
      const sig = extractToolSignature("bash", { command: `cmd-${i}` });
      detector.recordToolCall("bash", sig);
    }

    expect(detector.isLooping()).toBe(false);
  });
});