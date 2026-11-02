import { describe, expect, it } from "bun:test";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context";
import type { MessageEntry, ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";

let nowCounter = 0;

function nextTimestamp(): string {
  nowCounter += 1;
  return new Date(2026, 4, 21, 0, 0, 0, nowCounter).toISOString();
}

function message(parentId: string | null, id: string, messageBody: MessageEntry["message"]): ConversationEntry {
  return { kind: "message", id, parentId, timestamp: nextTimestamp(), message: messageBody };
}

function userText(parentId: string | null, id: string, content: string): ConversationEntry {
  return message(parentId, id, { kind: "user", content });
}

function assistantText(parentId: string | null, id: string, content: string): ConversationEntry {
  return message(parentId, id, { kind: "assistant", content });
}

function toolUse(id: string, pattern: string) {
  return { type: "tool_use" as const, id, name: "search", input: { pattern } };
}

function toolResult(parentId: string | null, id: string, toolUseId: string, text: string): ConversationEntry {
  return message(parentId, id, { kind: "toolResult", toolUseId, content: [{ type: "text", text }] });
}

function asToolResult(entry: ConversationMessage | undefined): Extract<ConversationMessage, { kind: "toolResult" }> {
  if (entry?.kind !== "toolResult") throw new Error("expected toolResult message");
  return entry;
}

describe("buildSessionContext tool adjacency", () => {
  it("accepts parallel tool_use blocks followed by a matching toolResult run", () => {
    const ask = userText(null, "11111111", "find both");
    const assistant = message("11111111", "22222222", {
      kind: "assistant",
      content: [
        { type: "text", text: "Checking both." },
        toolUse("tool_a", "alpha"),
        toolUse("tool_b", "beta"),
      ],
    });
    const resultA = toolResult("22222222", "33333333", "tool_a", "alpha result");
    const resultB = toolResult("33333333", "44444444", "tool_b", "beta result");
    const answer = assistantText("44444444", "55555555", "done");
    const followUp = userText("55555555", "66666666", "next");

    const context = buildSessionContext([ask, assistant, resultA, resultB, answer, followUp]);
    expect(context.messages.map((entry) => entry.kind)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant", "user"]);
    const assistantContent = context.messages[1]?.content;
    if (!Array.isArray(assistantContent)) throw new Error("expected assistant blocks");
    expect(assistantContent.filter((block) => block.type === "tool_use").map((block) => block.id)).toEqual([
      "tool_a",
      "tool_b",
    ]);
    expect(asToolResult(context.messages[2]).toolUseId).toBe("tool_a");
    expect(asToolResult(context.messages[3]).toolUseId).toBe("tool_b");
    expect(asToolResult(context.messages[2]).interrupted).toBeUndefined();
    expect(asToolResult(context.messages[3]).interrupted).toBeUndefined();
  });

  it("replaces fragmented tool exchanges with typed gaps", () => {
    const toolA = message(null, "11111111", {
      kind: "assistant",
      content: [toolUse("tool_a", "alpha")],
    });
    const toolB = message("11111111", "22222222", {
      kind: "assistant",
      content: [toolUse("tool_b", "beta")],
    });
    const text = assistantText("22222222", "33333333", "I found results.");
    const resultA = toolResult("33333333", "44444444", "tool_a", "alpha result");
    const resultB = toolResult("44444444", "55555555", "tool_b", "beta result");
    const followUp = userText("55555555", "66666666", "next");

    const context = buildSessionContext([toolA, toolB, text, resultA, resultB, followUp]);

    expect(context.messages.map((entry) => entry.kind)).toEqual(["user", "user", "assistant", "user", "user"]);
    expect([context.messages[0], context.messages[1], context.messages[3]].every((entry) => entry?.kind === "user" && entry.origin === "system")).toBe(true);
    expect([context.messages[0], context.messages[1], context.messages[3]].every((entry) => typeof entry?.content === "string" && entry.content.startsWith("<conversationHistoryGap"))).toBe(true);
  });

  it("replaces duplicate and unexpected tool results with one typed gap", () => {
    const ask = userText(null, "11111111", "find one");
    const assistant = message("11111111", "22222222", {
      kind: "assistant",
      content: [toolUse("tool_a", "alpha")],
    });
    const real = toolResult("22222222", "33333333", "tool_a", "first answer");
    const duplicate = toolResult("33333333", "44444444", "tool_a", "duplicate answer");
    const unexpected = toolResult("44444444", "55555555", "tool_x", "never asked");
    const followUp = userText("55555555", "66666666", "next");

    const context = buildSessionContext([ask, assistant, real, duplicate, unexpected, followUp]);

    expect(context.messages.map((entry) => entry.kind)).toEqual(["user", "user", "user"]);
    expect(context.messages[1]).toMatchObject({ kind: "user", origin: "system" });
  });
});
