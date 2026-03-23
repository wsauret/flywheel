import { describe, it, expect } from "bun:test";
import { formatClaudeStdinMessage } from "../src/controller/phase-executor";

/**
 * Tests for stdin injection formatting helpers.
 */

describe("formatClaudeStdinMessage", () => {
  it("wraps text in SDKUserMessage NDJSON format", () => {
    const result = formatClaudeStdinMessage("hello world");
    const parsed = JSON.parse(result.trim());

    expect(parsed).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "hello world",
      },
    });
  });

  it("ends with a newline character", () => {
    const result = formatClaudeStdinMessage("test");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("does not contain extra newlines within the JSON", () => {
    const result = formatClaudeStdinMessage("test");
    // Should be exactly one line of JSON followed by \n
    const lines = result.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  it("handles prompts with special characters", () => {
    const prompt = 'Fix the "bug" in src/foo.ts\nLine 42: x > y';
    const result = formatClaudeStdinMessage(prompt);
    const parsed = JSON.parse(result.trim());

    expect(parsed.message.content).toBe(prompt);
  });

  it("handles empty string", () => {
    const result = formatClaudeStdinMessage("");
    const parsed = JSON.parse(result.trim());

    expect(parsed.message.content).toBe("");
  });

  it("handles very long prompts", () => {
    const longPrompt = "x".repeat(100_000);
    const result = formatClaudeStdinMessage(longPrompt);
    const parsed = JSON.parse(result.trim());

    expect(parsed.message.content.length).toBe(100_000);
  });
});
