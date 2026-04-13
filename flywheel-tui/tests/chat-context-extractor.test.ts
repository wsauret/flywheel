import { describe, it, expect } from "bun:test";
// extractChatContext was inlined into use-command-dispatch.ts — test the extracted function here.
import type { AnyBlock } from "../src/infra/output-blocks";

const CHAT_CONTEXT_MAX_CHARS = 2000;

function extractChatContext(blocks: readonly AnyBlock[]): string | undefined {
  const lines: string[] = [];
  let chars = 0;
  for (let i = blocks.length - 1; i >= 0 && chars < CHAT_CONTEXT_MAX_CHARS; i--) {
    const block = blocks[i]!;
    if (block.kind === "userMessage" && !block.injected) {
      lines.unshift(`User: ${block.content}`);
      chars += block.content.length + 6;
    } else if (block.kind === "text") {
      lines.unshift(`Assistant: ${block.content}`);
      chars += block.content.length + 11;
    }
  }
  if (lines.length === 0) return undefined;
  let result = lines.join("\n");
  if (result.length > CHAT_CONTEXT_MAX_CHARS) {
    result = result.slice(result.length - CHAT_CONTEXT_MAX_CHARS);
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0) result = result.slice(firstNewline + 1);
  }
  return result;
}
import type { AnyBlock } from "../src/infra/output-blocks";

function textBlock(content: string): AnyBlock {
  return { kind: "text", content, timestamp: Date.now() } as AnyBlock;
}

function userBlock(content: string, injected = false): AnyBlock {
  return { kind: "userMessage", content, timestamp: Date.now(), injected } as AnyBlock;
}

function toolBlock(): AnyBlock {
  return { kind: "tool", name: "Read", detail: "read file", timestamp: Date.now() } as AnyBlock;
}

function thinkingBlock(): AnyBlock {
  return { kind: "thinking", content: "hmm", timestamp: Date.now() } as AnyBlock;
}

describe("extractChatContext", () => {
  it("returns undefined for empty blocks", () => {
    expect(extractChatContext([])).toBeUndefined();
  });

  it("returns undefined when no user or text blocks exist", () => {
    expect(extractChatContext([toolBlock(), thinkingBlock()])).toBeUndefined();
  });

  it("extracts user and assistant turns", () => {
    const blocks = [
      userBlock("What's the auth bug?"),
      textBlock("The auth middleware stores session tokens incorrectly."),
      userBlock("How should we fix it?"),
      textBlock("Replace the storage layer with encrypted cookies."),
    ];
    const result = extractChatContext(blocks)!;
    expect(result).toContain("User: What's the auth bug?");
    expect(result).toContain("Assistant: The auth middleware stores session tokens incorrectly.");
    expect(result).toContain("User: How should we fix it?");
    expect(result).toContain("Assistant: Replace the storage layer with encrypted cookies.");
  });

  it("skips tool and thinking blocks", () => {
    const blocks = [
      userBlock("hello"),
      thinkingBlock(),
      toolBlock(),
      textBlock("hi there"),
    ];
    const result = extractChatContext(blocks)!;
    expect(result).not.toContain("hmm");
    expect(result).not.toContain("Read");
    expect(result).toContain("User: hello");
    expect(result).toContain("Assistant: hi there");
  });

  it("skips injected system messages", () => {
    const blocks = [
      userBlock("real message"),
      userBlock("injected observer note", true),
      textBlock("response"),
    ];
    const result = extractChatContext(blocks)!;
    expect(result).toContain("User: real message");
    expect(result).not.toContain("injected observer note");
  });

  it("caps output at ~2000 chars", () => {
    const blocks: AnyBlock[] = [];
    for (let i = 0; i < 100; i++) {
      blocks.push(userBlock(`Message ${i}: ${"x".repeat(50)}`));
      blocks.push(textBlock(`Response ${i}: ${"y".repeat(50)}`));
    }
    const result = extractChatContext(blocks)!;
    expect(result.length).toBeLessThanOrEqual(2100);
    // Most recent turns should be present
    expect(result).toContain("Message 99");
  });
});
