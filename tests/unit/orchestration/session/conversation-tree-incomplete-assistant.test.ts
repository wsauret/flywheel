import { beforeEach, describe, expect, it } from "bun:test";
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context";
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";
import { message, nextTimestamp, resetTimestamps, systemNotice } from "./_conversation-tree-entries";

beforeEach(() => {
  resetTimestamps();
});

describe("incomplete assistant history", () => {
  it("preserves an incomplete assistant at the model-visible tail", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial = message("11111111", "22222222", "assistant", "partial", true);
    const ctx = buildSessionContext([ask, partial]);
    expect(ctx.messages).toEqual([
      { kind: "user", content: "start" },
      { kind: "assistant", content: "partial", incomplete: true },
    ]);
  });

  it("throws when a settled assistant tail would prefill the provider", () => {
    const ask = message(null, "11111111", "user", "start");
    const answer = message("11111111", "22222222", "assistant", "done");

    expect(() => buildSessionContext([ask, answer])).toThrow(/must end with a user message/i);
  });

  it("accepts a transcript-only system notice after the trailing user turn", () => {
    const ask = message(null, "11111111", "user", "start");
    const answer = message("11111111", "22222222", "assistant", "done");
    const next = message("22222222", "33333333", "user", "next question");
    const notice = systemNotice("33333333", "44444444", "learning reconciliation notice");

    const ctx = buildSessionContext([ask, answer, next, notice]);

    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "assistant", "user", "system"]);
  });

  it("still throws when only a system notice trails a settled assistant", () => {
    const ask = message(null, "11111111", "user", "start");
    const answer = message("11111111", "22222222", "assistant", "done");
    const notice = systemNotice("22222222", "33333333", "notice");

    expect(() => buildSessionContext([ask, answer, notice])).toThrow(/must end with a user message/i);
  });

  it("preserves a trailing incomplete assistant before a system notice", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial = message("11111111", "22222222", "assistant", "partial", true);
    const notice = systemNotice("22222222", "33333333", "notice");
    const ctx = buildSessionContext([ask, partial, notice]);
    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "assistant", "system"]);
  });

  it("preserves an incomplete assistant when a later retry assistant settled", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial = message("11111111", "22222222", "assistant", "partial", true);
    const notice = systemNotice("22222222", "33333333", "notice");
    const retry = message("33333333", "44444444", "assistant", "retry response");
    const next = message("44444444", "55555555", "user", "next turn");
    const ctx = buildSessionContext([ask, partial, notice, retry, next]);
    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "assistant", "system", "assistant", "user"]);
    expect(ctx.messages.some((m) => m.kind === "assistant" && m.content === "partial")).toBe(true);
  });

  it("rejects settled assistant messages separated only by a system notice", () => {
    const ask = message(null, "11111111", "user", "start");
    const answer = message("11111111", "22222222", "assistant", "done");
    const notice = systemNotice("22222222", "33333333", "notice");
    const stray = message("33333333", "44444444", "assistant", "stray");
    const next = message("44444444", "55555555", "user", "next turn");

    expect(() => buildSessionContext([ask, answer, notice, stray, next])).toThrow(/adjacent assistant messages/i);
  });

  it("rejects a non-empty context holding only system notices", () => {
    const notice = systemNotice(null, "11111111", "orphan notice");

    expect(() => buildSessionContext([notice])).toThrow(/must end with a user message/i);
    expect(buildSessionContext([]).messages).toEqual([]);
  });

  it("preserves an incomplete assistant when a real user turn follows it", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial = message("11111111", "22222222", "assistant", "partial", true);
    const next = message("22222222", "33333333", "user", "real next turn");

    const ctx = buildSessionContext([ask, partial, next]);

    expect(ctx.messages.map((m) => typeof m.content === "string" ? m.content : "")).toEqual(["start", "partial", "real next turn"]);
  });

  it("preserves an incomplete assistant when its tool result follows", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial: ConversationEntry = {
      kind: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp: nextTimestamp(),
      message: {
        kind: "assistant",
        content: [{ type: "tool_use", id: "tool_retry", name: "read", input: { path: "src/example.ts" } }],
        incomplete: true,
      },
    };
    const result: ConversationEntry = {
      kind: "message",
      id: "33333333",
      parentId: "22222222",
      timestamp: nextTimestamp(),
      message: {
        kind: "toolResult",
        toolUseId: "tool_retry",
        content: [{ type: "text", text: "file contents" }],
      },
    };
    const next = message("33333333", "44444444", "user", "next turn");

    const ctx = buildSessionContext([ask, partial, result, next]);

    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(ctx.messages.some((m) => typeof m.content === "string" && m.content.includes("<conversationHistoryGap>"))).toBe(false);
  });

  it("preserves an incomplete assistant before its settled retry response", () => {
    const ask = message(null, "11111111", "user", "start");
    const partial = message("11111111", "22222222", "assistant", "partial", true);
    const retry = message("22222222", "33333333", "assistant", "retry response");
    const next = message("33333333", "44444444", "user", "next turn");
    const ctx = buildSessionContext([ask, partial, retry, next]);
    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(ctx.messages.map((m) => typeof m.content === "string" ? m.content : "")).toEqual([
      "start", "partial", "retry response", "next turn",
    ]);
  });

  it("preserves a trailing incomplete assistant after compaction", () => {
    const old = message(null, "11111111", "user", "old");
    const source = message("11111111", "22222222", "user", "source summarized");
    const compactionEntry: ConversationEntry = {
      kind: "compaction",
      id: "33333333",
      parentId: "22222222",
      timestamp: nextTimestamp(),
      summary: "compressed earlier turns",
      retainedMessages: [{ kind: "user", content: "retained" }],
      sourceLeafId: "22222222",
      tokensBefore: 10,
      tokensAfter: 5,
    };
    const partial = message("33333333", "44444444", "assistant", "partial", true);
    const ctx = buildSessionContext([old, source, compactionEntry, partial]);
    expect(ctx.messages.map((m) => m.kind)).toEqual(["user", "compactionSummary", "assistant"]);
  });
});
