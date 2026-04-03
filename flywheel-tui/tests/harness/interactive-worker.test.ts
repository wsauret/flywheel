import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createInteractiveWorker } from "../../src/harness/interactive-worker.js";
import type { InteractiveWorkerHandle, InteractiveWorkerOptions } from "../../src/harness/interactive-worker.js";

// We need to mock the provider and tools for unit tests.
// The approach: use dependency injection through the options and module-level mocking.

// Since InteractiveWorker internally creates its provider and tools, we test by:
// 1. Testing the public API behavior (creation, shutdown, summary)
// 2. Testing with a real but pre-aborted signal for abort paths
// 3. Testing the conversation summary extraction logic

// ============================================================================
// Helpers
// ============================================================================

const FAKE_API_KEY = "test-key-not-real";

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
      // Save and clear env
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

      // After external abort, sendMessage should throw
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

  describe("getConversationSummary", () => {
    it("returns empty string when no messages", () => {
      const worker = createInteractiveWorker(makeOptions());
      expect(worker.getConversationSummary()).toBe("");
      worker.shutdown();
    });
  });

  describe("no task_complete tool", () => {
    it("does not include task_complete in the tool set", () => {
      // We verify this by checking that createChatTools doesn't include it
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
// Tests: Conversation summary extraction
// ============================================================================

describe("getConversationSummary", () => {
  // To test summary properly, we need to send messages and build up history.
  // Since sendMessage calls the LLM (which we can't easily mock at this level),
  // we test the summary logic through the exposed API with controlled input.

  // The implementation extracts user messages from the history array.
  // We can test it indirectly by checking that new workers return empty summary.
  it("returns empty string for new worker", () => {
    const worker = createInteractiveWorker(makeOptions());
    expect(worker.getConversationSummary()).toBe("");
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
    // Should not throw
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
    // First message preserved
    expect(result[0]).toEqual(messages[0]);
    // Truncation notice inserted
    expect(typeof result[1].content === "string" && result[1].content.includes("removed")).toBe(true);
  });
});

// ============================================================================
// Tests: DoomLoopDetector (integration with interactive worker design)
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

// ============================================================================
// Tests: Serial queue (mutex) behavior
// ============================================================================

describe("serial queue behavior", () => {
  it("mutex serializes async operations", async () => {
    // Test the mutex pattern used in interactive worker
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

    // Start three "operations" concurrently
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
});