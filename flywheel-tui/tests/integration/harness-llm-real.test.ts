/**
 * Integration tests for the harness LLM layer with real API calls.
 * Tests both Anthropic and OpenAI providers with streaming.
 *
 * Requires ANTHROPIC_API_KEY and OPENAI_API_KEY env vars.
 */
import { describe, it, expect } from "bun:test";
import { createModelsClient } from "../../src/orchestration/engines/providers/harness/llm/models";
import { createClient } from "../../src/orchestration/engines/providers/harness/llm/client-factory";
import type { StreamEvent, Message } from "../../src/orchestration/engines/providers/harness/llm/types";

const messages: Message[] = [
  { role: "user", content: "Say exactly: hello world" },
];

describe("Anthropic streaming (real API)", () => {
  it("streams text deltas from Claude haiku", async () => {
    const modelsClient = createModelsClient();
    const client = createClient("claude-haiku-4-5-20251001", modelsClient);

    const events: StreamEvent[] = [];
    for await (const event of client.streamWithTools({
      messages,
      tools: [],
      systemPrompt: "Respond in exactly 2 words.",
      model: "claude-haiku-4-5-20251001",
    })) {
      events.push(event);
    }

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const doneEvents = events.filter((e) => e.kind === "done");
    const usageEvents = events.filter((e) => e.kind === "usage");

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(doneEvents.length).toBe(1);
    expect(usageEvents.length).toBeGreaterThan(0);

    const fullText = textDeltas.map((e) => e.kind === "text_delta" ? e.text : "").join("");
    expect(fullText.toLowerCase()).toContain("hello");
  }, 30_000);

  it("complete() returns non-streaming response", async () => {
    const modelsClient = createModelsClient();
    const client = createClient("claude-haiku-4-5-20251001", modelsClient);

    const result = await client.complete(messages);
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain("hello");
  }, 15_000);
});

describe("OpenAI streaming (real API)", () => {
  it("streams text deltas from GPT-4o-mini", async () => {
    const modelsClient = createModelsClient();
    const client = createClient("gpt-4o-mini", modelsClient);

    const events: StreamEvent[] = [];
    for await (const event of client.streamWithTools({
      messages,
      tools: [],
      systemPrompt: "Respond in exactly 2 words.",
      model: "gpt-4o-mini",
    })) {
      events.push(event);
    }

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const doneEvents = events.filter((e) => e.kind === "done");

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(doneEvents.length).toBe(1);

    const fullText = textDeltas.map((e) => e.kind === "text_delta" ? e.text : "").join("");
    expect(fullText.toLowerCase()).toContain("hello");
  }, 30_000);

  it("complete() returns non-streaming response", async () => {
    const modelsClient = createModelsClient();
    const client = createClient("gpt-4o-mini", modelsClient);

    const result = await client.complete(messages);
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain("hello");
  }, 15_000);
});
