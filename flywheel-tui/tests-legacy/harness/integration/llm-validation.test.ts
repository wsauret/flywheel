/**
 * LLM Provider integration tests (@slow).
 *
 * These tests make real API calls and require ANTHROPIC_API_KEY.
 * Skipped in CI — run manually with `bun test tests/harness/integration/llm-validation.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import type { StreamEvent, StreamOptions } from "../../../src/harness/llm.js";
import { AnthropicProvider } from "../../../src/harness/anthropic.js";

describe.skipIf(!process.env.RUN_INTEGRATION)("Anthropic integration (@slow)", () => {
  it("streams a simple text response", async () => {
    const provider = new AnthropicProvider();
    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "You are a helpful assistant. Respond in one sentence.",
      messages: [{ role: "user", content: "What is 2+2?" }],
      maxTokens: 256,
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBeGreaterThan(0);

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBe(1);

    const stopEvents = events.filter((e) => e.type === "message_stop");
    expect(stopEvents.length).toBe(1);
  });

  it("streams with extended thinking enabled", async () => {
    const provider = new AnthropicProvider();
    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "Think step by step.",
      messages: [{ role: "user", content: "What is 15 * 23?" }],
      maxTokens: 16000,
      thinking: { effort: "high" },
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    expect(thinkingEvents.length).toBeGreaterThan(0);
  });

  it("streams with tool definitions", async () => {
    const provider = new AnthropicProvider();
    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "Use the provided tools to answer questions.",
      messages: [{ role: "user", content: "Read the file /tmp/test.txt" }],
      maxTokens: 1024,
      tools: [
        {
          name: "read_file",
          description: "Read a file from disk",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to read" },
            },
            required: ["path"],
          },
        },
      ],
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    expect(toolUseEvents.length).toBeGreaterThan(0);
    if (toolUseEvents[0]!.type === "tool_use") {
      expect(toolUseEvents[0]!.name).toBe("read_file");
    }
  });

  it("reports usage with cache stats", async () => {
    const provider = new AnthropicProvider();
    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 64,
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage") {
      expect(usageEvent.usage.inputTokens).toBeGreaterThan(0);
      expect(usageEvent.usage.outputTokens).toBeGreaterThan(0);
    }
  });

  it("respects abort signal", async () => {
    const provider = new AnthropicProvider();
    const controller = new AbortController();

    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "Write a very long essay about the history of computing.",
      messages: [{ role: "user", content: "Go ahead." }],
      maxTokens: 4096,
      abortSignal: controller.signal,
    };

    const events: StreamEvent[] = [];
    let aborted = false;

    try {
      let count = 0;
      for await (const event of provider.stream(options)) {
        events.push(event);
        count++;
        if (count > 5) {
          controller.abort();
        }
      }
    } catch {
      aborted = true;
    }

    // Either the stream errored or an error event was emitted
    const hasError = aborted || events.some((e) => e.type === "error");
    expect(hasError).toBe(true);
  });
});
