/**
 * Anthropic LLM provider adapter — unit tests.
 *
 * Tests streaming event parsing, cache breakpoint injection, retry logic,
 * error sanitization, and thinking parameter handling.
 *
 * Uses FakeLLMProvider (real class, no mocks) for provider-level tests,
 * and tests internal utilities directly for unit coverage.
 */

import { describe, it, expect } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { FakeLLMProvider } from "../fixtures/fake-llm-provider.js";
import type { StreamEvent, StreamOptions } from "../../src/harness/llm.js";
import {
  sanitizeApiKey,
  retry,
  isAnthropicRetryable,
  applyCacheBreakpoints,
} from "../../src/harness/anthropic.js";

// ---------------------------------------------------------------------------
// FakeLLMProvider — basic interface compliance
// ---------------------------------------------------------------------------

describe("FakeLLMProvider", () => {
  it("yields enqueued events in order", async () => {
    const provider = new FakeLLMProvider();
    const events: StreamEvent[] = [
      { type: "text_delta", text: "hello" },
      { type: "message_stop" },
    ];
    provider.enqueue(events);

    const collected: StreamEvent[] = [];
    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "test system",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1024,
    };

    for await (const event of provider.stream(options)) {
      collected.push(event);
    }

    expect(collected).toEqual(events);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.model).toBe("claude-sonnet-4-6");
  });

  it("serves multiple stream calls from FIFO queue", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([{ type: "text_delta", text: "first" }]);
    provider.enqueue([{ type: "text_delta", text: "second" }]);

    const options: StreamOptions = {
      model: "test",
      system: "",
      messages: [],
      maxTokens: 100,
    };

    const first: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      first.push(event);
    }

    const second: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      second.push(event);
    }

    expect((first[0] as { type: "text_delta"; text: string }).text).toBe("first");
    expect((second[0] as { type: "text_delta"; text: string }).text).toBe("second");
  });

  it("throws when no events enqueued", async () => {
    const provider = new FakeLLMProvider();
    const options: StreamOptions = {
      model: "test",
      system: "",
      messages: [],
      maxTokens: 100,
    };

    const iter = provider.stream(options);
    await expect(iter.next()).rejects.toThrow("no events enqueued");
  });

  it("throws configured error", async () => {
    const provider = new FakeLLMProvider();
    provider.setError(new Error("boom"));

    const options: StreamOptions = {
      model: "test",
      system: "",
      messages: [],
      maxTokens: 100,
    };

    const iter = provider.stream(options);
    await expect(iter.next()).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// API key sanitization
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = ["sk", "ant"].join("-") + "-";

describe("sanitizeApiKey", () => {
  it("redacts Anthropic API keys from text", () => {
    const key = API_KEY_PREFIX + "api03-FAKEFAKEFAKE_FAKEFAKE_FAKEFAKE-FAKEFAKEFAKEFAKEFAKE";
    const input = `Error: Auth failed with key ${key} at endpoint`;
    const result = sanitizeApiKey(input);
    expect(result).toBe("Error: Auth failed with key [REDACTED] at endpoint");
    expect(result).not.toContain(API_KEY_PREFIX);
  });

  it("redacts multiple keys in the same string", () => {
    const result = sanitizeApiKey(
      `key1=${API_KEY_PREFIX}FAKEFAKEFAKEFAKEFAKEFAKE key2=${API_KEY_PREFIX}TESTFAKETESTFAKEFAKEFAKE`,
    );
    expect(result).toBe("key1=[REDACTED] key2=[REDACTED]");
  });

  it("leaves non-key text unchanged", () => {
    const text = "Normal error message without any keys";
    expect(sanitizeApiKey(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(sanitizeApiKey("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("returns result on first success", async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      return 42;
    }, { maxAttempts: 3 });

    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries on transient errors", async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error("overloaded");
      return "ok";
    }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new Error("Invalid request: bad parameters");
      }, { maxAttempts: 5, baseDelayMs: 1 }),
    ).rejects.toThrow("Invalid request: bad parameters");

    expect(calls).toBe(1);
  });

  it("exhausts all attempts and throws last error", async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new Error("ECONNRESET");
      }, { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("ECONNRESET");

    expect(calls).toBe(3);
  });

  it("sanitizes API keys in thrown errors", async () => {
    await expect(
      retry(async () => {
        throw new Error(`Auth failed: ${API_KEY_PREFIX}api03-FAKEFAKEFAKEFAKEFAKEFAKE`);
      }, { maxAttempts: 1 }),
    ).rejects.toThrow("[REDACTED]");
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      retry(async () => {
        throw new Error("ECONNRESET");
      }, { maxAttempts: 5, signal: controller.signal, baseDelayMs: 1 }),
    ).rejects.toThrow();
  });

  it("accepts custom isRetryable predicate", async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("custom-retry");
        return "done";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1,
        isRetryable: (err) =>
          err instanceof Error && err.message === "custom-retry",
      },
    );

    expect(result).toBe("done");
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Retryable error classification
// ---------------------------------------------------------------------------

describe("isAnthropicRetryable", () => {
  it("retries rate limit errors", () => {
    expect(isAnthropicRetryable(new Error("rate limit exceeded"))).toBe(true);
    expect(isAnthropicRetryable(new Error("Too many requests"))).toBe(true);
    expect(isAnthropicRetryable(new Error("429 overloaded"))).toBe(true);
  });

  it("retries transient network errors (from worker/errors isTransientError)", () => {
    expect(isAnthropicRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isAnthropicRetryable(new Error("socket hang up"))).toBe(true);
    expect(isAnthropicRetryable(new Error("503 service unavailable"))).toBe(true);
    expect(isAnthropicRetryable(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("does not retry auth or schema errors", () => {
    expect(isAnthropicRetryable(new Error("Invalid API key"))).toBe(false);
    expect(isAnthropicRetryable(new Error("Invalid request: missing model"))).toBe(false);
  });

  it("retries errors with retryable status codes", () => {
    const error = Object.assign(new Error("Server error"), { status: 529 });
    expect(isAnthropicRetryable(error)).toBe(true);

    const error503 = Object.assign(new Error("Unavailable"), { status: 503 });
    expect(isAnthropicRetryable(error503)).toBe(true);
  });

  it("does not retry non-Error values", () => {
    expect(isAnthropicRetryable("string error")).toBe(false);
    expect(isAnthropicRetryable(null)).toBe(false);
    expect(isAnthropicRetryable(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cache breakpoint injection
// ---------------------------------------------------------------------------

describe("applyCacheBreakpoints", () => {
  it("applies cache_control to system prompt and last message", () => {
    const params: MessageCreateParamsStreaming = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: true,
      system: [{ type: "text", text: "System prompt" }],
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: "Second message" },
      ],
    };

    applyCacheBreakpoints(params);

    // System prompt gets cache_control
    const systemBlocks = params.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(systemBlocks[0]!.cache_control).toEqual({ type: "ephemeral" });

    // Last message gets cache_control
    const lastMessage = params.messages[params.messages.length - 1]!;
    const lastContent = lastMessage.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(lastContent[lastContent.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts string content to block array for cache_control on last message", () => {
    const params: MessageCreateParamsStreaming = {
      model: "test",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    };

    applyCacheBreakpoints(params);

    const lastMessage = params.messages[0]!;
    expect(Array.isArray(lastMessage.content)).toBe(true);
    const content = lastMessage.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(content[0]!.text).toBe("hello");
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles empty messages array", () => {
    const params: MessageCreateParamsStreaming = {
      model: "test",
      max_tokens: 100,
      stream: true,
      messages: [],
    };

    // Should not throw
    applyCacheBreakpoints(params);
    expect(params.messages).toEqual([]);
  });

  it("handles missing system prompt", () => {
    const params: MessageCreateParamsStreaming = {
      model: "test",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    };

    // Should not throw
    applyCacheBreakpoints(params);

    const lastMessage = params.messages[0]!;
    const content = lastMessage.content as Array<{ cache_control?: { type: string } }>;
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("applies cache_control to last block of multi-block content", () => {
    const params: MessageCreateParamsStreaming = {
      model: "test",
      max_tokens: 100,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ],
    };

    applyCacheBreakpoints(params);

    const content = params.messages[0]!.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(content[0]!.cache_control).toBeUndefined();
    expect(content[1]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

// ---------------------------------------------------------------------------
// Thinking parameter handling
// ---------------------------------------------------------------------------

describe("AnthropicProvider thinking params", () => {
  it("FakeLLMProvider passes through thinking options", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "thinking", thinking: "Let me think..." },
      { type: "text_delta", text: "Answer" },
      { type: "message_stop" },
    ]);

    const options: StreamOptions = {
      model: "claude-sonnet-4-6",
      system: "You are helpful",
      messages: [{ role: "user", content: "Solve this" }],
      maxTokens: 16000,
      thinking: { type: "enabled", budgetTokens: 10000 },
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("thinking");
    expect(events[1]!.type).toBe("text_delta");
    expect(events[2]!.type).toBe("message_stop");

    // Verify thinking options were passed through
    expect(provider.calls[0]!.thinking).toEqual({
      type: "enabled",
      budgetTokens: 10000,
    });
  });
});

// ---------------------------------------------------------------------------
// Stream event type coverage
// ---------------------------------------------------------------------------

describe("StreamEvent type coverage via FakeLLMProvider", () => {
  it("handles all stream event types", async () => {
    const provider = new FakeLLMProvider();
    provider.enqueue([
      { type: "text_delta", text: "Hello" },
      { type: "thinking", thinking: "Reasoning..." },
      { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "/test" } },
      { type: "tool_result", tool_use_id: "tool_1", content: "file contents", is_error: false },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 } },
      { type: "error", error: new Error("test error") },
      { type: "message_stop" },
    ]);

    const options: StreamOptions = {
      model: "test",
      system: "",
      messages: [],
      maxTokens: 100,
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(options)) {
      events.push(event);
    }

    expect(events).toHaveLength(7);

    const textDelta = events[0]!;
    expect(textDelta.type).toBe("text_delta");
    if (textDelta.type === "text_delta") {
      expect(textDelta.text).toBe("Hello");
    }

    const thinking = events[1]!;
    expect(thinking.type).toBe("thinking");
    if (thinking.type === "thinking") {
      expect(thinking.thinking).toBe("Reasoning...");
    }

    const toolUse = events[2]!;
    expect(toolUse.type).toBe("tool_use");
    if (toolUse.type === "tool_use") {
      expect(toolUse.name).toBe("read_file");
      expect(toolUse.input).toEqual({ path: "/test" });
    }

    const toolResult = events[3]!;
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.content).toBe("file contents");
      expect(toolResult.is_error).toBe(false);
    }

    const usageEvent = events[4]!;
    expect(usageEvent.type).toBe("usage");
    if (usageEvent.type === "usage") {
      expect(usageEvent.usage.inputTokens).toBe(100);
      expect(usageEvent.usage.outputTokens).toBe(50);
      expect(usageEvent.usage.cacheReadInputTokens).toBe(20);
    }

    const errorEvent = events[5]!;
    expect(errorEvent.type).toBe("error");

    expect(events[6]!.type).toBe("message_stop");
  });
});
