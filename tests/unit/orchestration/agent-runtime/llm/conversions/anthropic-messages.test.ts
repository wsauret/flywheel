import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import { toAnthropicMessagesRequest } from "../../../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages.js";
import { ProviderIdConversionError } from "../../../../../../src/orchestration/agent-runtime/llm/conversions/provider-id.js";
import { stableSystemPrompt } from "../../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ProviderRequestValidationError } from "../../../../../../src/orchestration/agent-runtime/llm/errors.js";

const anthropic = { sharedHost: false, accessProvider: "anthropic_api" as const, provider: "anthropic" as const, api: "anthropic-messages" as const, model: "claude" };
const openai = { accessProvider: "openai_api" as const, provider: "openai" as const, api: "openai-responses" as const, model: "o4" };

function assistant(content: Extract<ConversationMessage, { kind: "assistant" }>["content"]): ConversationMessage {
  return { kind: "assistant", content, ...openai, timestamp: 1 };
}

function textResult(toolUseId: string, text: string, isError = false): ConversationMessage {
  return { kind: "toolResult", toolUseId, content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function countCacheControl(value: unknown): number {
  return JSON.stringify(value).match(/"cache_control"/g)?.length ?? 0;
}

describe("Anthropic Messages converter", () => {
  test("signed thinking replays for same Anthropic model", () => {
    const msg: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "think", signature: "sig" }], ...anthropic, timestamp: 1 };
    expect(JSON.stringify(toAnthropicMessagesRequest(anthropic, [msg]))).toContain("sig");
  });

  test("signed thinking is withheld from another model", () => {
    const msg: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "think", signature: "sig" }], ...anthropic, timestamp: 1 };
    const converted = toAnthropicMessagesRequest({ ...anthropic, model: "other" }, [msg]);
    expect(JSON.stringify(converted)).not.toContain("think");
    expect(JSON.stringify(converted)).not.toContain("sig");
  });

  test("signed thinking is withheld when assistant metadata is missing", () => {
    const msg: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "think", signature: "sig" }] };
    const converted = toAnthropicMessagesRequest(anthropic, [msg]);
    expect(JSON.stringify(converted)).not.toContain("think");
    expect(JSON.stringify(converted)).not.toContain("sig");
  });

  test("redacted thinking replays its opaque data, not the display placeholder, for the same Anthropic model", () => {
    // The adapter stores the display placeholder as the text and the opaque data as the signature.
    const msg: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "[Reasoning redacted]", signature: "opaque-data", redacted: true }], ...anthropic, timestamp: 1 };
    expect(toAnthropicMessagesRequest(anthropic, [msg]).messages[0]?.content[0]).toEqual({ type: "redacted_thinking", data: "opaque-data" });
  });

  test("user images degrade to an omission placeholder when target lacks image input", () => {
    const msg: ConversationMessage = { kind: "user", content: [{ type: "text", text: "see" }, { type: "image", mediaType: "image/png", data: "abc" }] };
    const withoutImages = JSON.stringify(toAnthropicMessagesRequest({ ...anthropic, supportsImages: false }, [msg]));
    expect(withoutImages).not.toContain("base64");
    expect(withoutImages).toContain("omitted");
    const withImages = JSON.stringify(toAnthropicMessagesRequest({ ...anthropic, supportsImages: true }, [msg]));
    expect(withImages).toContain("base64");
    expect(withImages).not.toContain("omitted");
  });

  test("compactionSummary joins the user message after it; system messages are skipped", () => {
    const history: ConversationMessage[] = [
      { kind: "system", content: "inline system" },
      { kind: "compactionSummary", content: "summary of the past" },
      { kind: "user", content: "next" },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, history);
    expect(converted.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "summary of the past" }, { type: "text", text: "next" }] },
    ]);
  });

  test("consecutive toolResult messages are batched into one immediate user message", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "read both" }] },
      { kind: "assistant", content: [
        { type: "tool_use", id: "call_a", name: "read", input: { path: "a.ts" } },
        { type: "tool_use", id: "call_b", name: "read", input: { path: "b.ts" } },
      ], ...anthropic, timestamp: 1 },
      textResult("call_a", "a"),
      textResult("call_b", "b"),
      { kind: "assistant", content: [{ type: "text", text: "done" }], ...anthropic, timestamp: 2 },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, history);
    expect(converted.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(converted.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "a" }] },
      { type: "tool_result", tool_use_id: "call_b", content: [{ type: "text", text: "b" }] },
    ]);
  });

  test("missing tool results are synthesized before provider validation", () => {
    const history: ConversationMessage[] = [{ kind: "assistant", content: [{ type: "tool_use", id: "missing", name: "x", input: {} }], ...anthropic, timestamp: 1 }];
    const converted = toAnthropicMessagesRequest(anthropic, history);
    expect(JSON.stringify(converted)).toContain("missing");
    expect(JSON.stringify(converted)).toContain("No result provided");
  });

  test("blank error tool results are repaired before Anthropic conversion", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "blank", name: "ask_user", input: {} }], ...anthropic, timestamp: 1 },
      { kind: "toolResult", toolUseId: "blank", content: [{ type: "text", text: "" }], isError: true },
    ];
    const converted = toAnthropicMessagesRequest(anthropic, history);
    const result = converted.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result");

    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "blank",
      is_error: true,
      content: [{ type: "text", text: "Tool 'ask_user' returned no result content." }],
    });
  });

  test("orphan tool results are dropped before an Anthropic request is made", () => {
    const history: ConversationMessage[] = [textResult("orphan", "bad")];
    expect(toAnthropicMessagesRequest(anthropic, history).messages).toEqual([]);
  });

  test("cache control leaves room for the adapter tool marker", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "first" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } }], ...anthropic, timestamp: 1 },
      textResult("call_1", "file"),
      { kind: "user", content: [{ type: "text", text: "middle" }] },
      { kind: "assistant", content: [{ type: "text", text: "reply" }], ...anthropic, timestamp: 2 },
      { kind: "user", content: [{ type: "text", text: "final" }] },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, systemPrompt: stableSystemPrompt("system") }, history);
    const toolResult = converted.messages.flatMap((m) => m.content).find((block) => block.type === "tool_result");
    expect(JSON.stringify(toolResult)).not.toContain("cache_control");
    expect(countCacheControl(converted)).toBe(2);
    expect(countCacheControl(converted) + 1).toBeLessThanOrEqual(4);
  });

  test("Anthropic cache retention maps ttl without mutating caller-owned messages", () => {
    const history: ConversationMessage[] = [{ kind: "user", content: [{ type: "text", text: "hello" }] }];
    const first = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "1h" }, history);
    const second = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "5m" }, history);
    expect(first.messages[0]?.content[0]).toMatchObject({ cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(second.messages[0]?.content[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(JSON.stringify(second.messages[0]?.content[0])).not.toContain('"ttl"');
    expect(JSON.stringify(history)).not.toContain("cache_control");
  });

  test("image part in tool_result passes through to wire-shape image block, and a whitespace-only text part sends no block", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_img", name: "read", input: {} }], ...anthropic, timestamp: 1 },
      {
        kind: "toolResult",
        toolUseId: "call_img",
        content: [{ type: "text", text: "  " }, { type: "image", mediaType: "image/png", data: "AAAA" }, { type: "text", text: "caption" }],
      },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none", supportsImages: true }, history);
    const toolResult = converted.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(toolResult).toEqual({
      type: "tool_result",
      tool_use_id: "call_img",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "caption" }],
    });
  });

  test("supportsImages:false replaces image part with text placeholder containing mediaType", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_img", name: "read", input: {} }], ...anthropic, timestamp: 1 },
      {
        kind: "toolResult",
        toolUseId: "call_img",
        content: [{ type: "image", mediaType: "image/png", data: "AAAA" }],
      },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none", supportsImages: false }, history);
    const toolResult = converted.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    const text = toolResult.content[0];
    if (text?.type !== "text") throw new Error("expected text part");
    expect(text.text).toContain("image/png");
    expect(text.text).toContain("omitted");
  });

  test("native and foreign tool call IDs preserve pairing through replay", () => {
    const nativeHistory: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "native_call", name: "read", input: {} }], ...anthropic, timestamp: 1 },
      textResult("native_call", "ok"),
    ];
    const foreignHistory: ConversationMessage[] = [
      assistant([{ type: "tool_use", id: "foreign/call", name: "read", input: {} }]),
      textResult("foreign/call", "ok"),
    ];

    const native = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, nativeHistory);
    const foreign = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, foreignHistory);
    expect(native.messages[0]?.content[0]).toMatchObject({ type: "tool_use", id: "native_call" });
    expect(native.messages[1]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "native_call" });
    const foreignCall = foreign.messages[0]?.content[0];
    const foreignResult = foreign.messages[1]?.content[0];
    if (foreignCall?.type !== "tool_use" || foreignResult?.type !== "tool_result") throw new Error("expected paired tool blocks");
    expect(foreignCall.id).toMatch(/^call_/);
    expect(foreignResult.tool_use_id).toBe(foreignCall.id);
  });

  test("foreign IDs that collide after sanitization or truncation stay distinct and stable", () => {
    const longPrefix = `foreign/${"x".repeat(80)}`;
    const history: ConversationMessage[] = [
      assistant([
        { type: "tool_use", id: "foreign/a", name: "a", input: {} },
        { type: "tool_use", id: "foreign?a", name: "b", input: {} },
        { type: "tool_use", id: `${longPrefix}a`, name: "c", input: {} },
        { type: "tool_use", id: `${longPrefix}b`, name: "d", input: {} },
      ]),
      textResult("foreign/a", "a"),
      textResult("foreign?a", "b"),
      textResult(`${longPrefix}a`, "c"),
      textResult(`${longPrefix}b`, "d"),
    ];

    const first = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, history);
    const second = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, history);
    const calls = first.messages[0]?.content.filter((block) => block.type === "tool_use") ?? [];
    expect(new Set(calls.map((block) => block.id)).size).toBe(4);
    expect(calls.every((block) => block.id.length <= 64)).toBe(true);
    expect(second).toEqual(first);
  });

  test("duplicate tool call IDs fail with the shared conversion error", () => {
    const history: ConversationMessage[] = [assistant([
      { type: "tool_use", id: "duplicate", name: "a", input: {} },
      { type: "tool_use", id: "duplicate", name: "b", input: {} },
    ])];
    expect(() => toAnthropicMessagesRequest(anthropic, history)).toThrow(ProviderIdConversionError);
  });

  test("empty sanitized text is omitted without removing signed empty thinking", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: " \n " }] },
      assistant([
        { type: "text", text: "\t" },
        { type: "reasoning", id: "reason", encrypted_content: "", summary: [{ type: "summary_text", text: "  " }] },
      ]),
      { kind: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }], ...anthropic, timestamp: 2 },
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "none" }, history);
    expect(converted.messages).toEqual([
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
    ]);
  });
});

/** The Claude engine sends every run of user messages as one wire message,
 *  and every Anthropic path matches it, so these requests keep canonical blocks
 *  and order and change only the message boundary. */
describe("Anthropic message boundary", () => {
  const marker = { type: "ephemeral", ttl: "1h" } as const;
  const text = (value: string) => ({ type: "text" as const, text: value });
  const toolUse = (...ids: string[]): ConversationMessage => ({
    kind: "assistant", content: ids.map((id) => ({ type: "tool_use" as const, id, name: "read", input: {} })), ...anthropic, timestamp: 1,
  });
  const reply = (value: string): ConversationMessage => ({ kind: "assistant", content: [{ type: "text", text: value }], ...anthropic, timestamp: 2 });
  const human = (content: string): ConversationMessage => ({ kind: "user", origin: "human", content });
  const runtime = (content: string): ConversationMessage => ({ kind: "user", origin: "system", content });

  test("tool results and the inputs queued after them form one message in canonical order", () => {
    const history = [human("read both"), toolUse("call_a", "call_b"), textResult("call_a", "a"), textResult("call_b", "b"), human("also check the README"), runtime("Background work finished.")];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "1h" }, history);
    expect(converted.messages).toEqual([
      { role: "user", content: [text("read both")] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "read", input: {} }, { type: "tool_use", id: "call_b", name: "read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_a", content: [text("a")] },
        { type: "tool_result", tool_use_id: "call_b", content: [text("b")] },
        text("also check the README"),
        { ...text("Background work finished."), cache_control: marker },
      ] },
    ]);
  });

  test("two queued inputs and the reminders after a person's message join it with no added text", () => {
    const history = [human("start"), runtime("# Environment"), runtime("Today's date is 2026-10-07."), reply("done"), human("one"), runtime("notice two")];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "1h" }, history);
    expect(converted.messages).toEqual([
      { role: "user", content: [text("start"), text("# Environment"), text("Today's date is 2026-10-07.")] },
      { role: "assistant", content: [text("done")] },
      { role: "user", content: [text("one"), { ...text("notice two"), cache_control: marker }] },
    ]);
  });

  test("empty and whitespace messages drop out without splitting the run around them", () => {
    const history: ConversationMessage[] = [
      toolUse("call_a"), { kind: "toolResult", toolUseId: "call_a", content: [] }, human(" \n "),
      { kind: "user", content: [{ type: "text", text: "" }, { type: "text", text: "kept" }] }, human("\t"),
    ];
    const converted = toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "1h" }, history);
    expect(converted.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: [] }, { ...text("kept"), cache_control: marker }] },
    ]);
  });

  test("a tool result placed after other user content is refused before the request is sent", () => {
    const history: ConversationMessage[] = [toolUse("call_a"), { kind: "compactionSummary", content: "summary" }, textResult("call_a", "a")];
    expect(() => toAnthropicMessagesRequest(anthropic, history)).toThrow(ProviderRequestValidationError);
  });

  test("each request of an append-only conversation extends the previous request's cached prefix", () => {
    const snapshots: ConversationMessage[][] = [];
    const history: ConversationMessage[] = [];
    const grow = (...messages: ConversationMessage[]) => { history.push(...messages); snapshots.push([...history]); };
    grow(human("hello"), runtime("# Environment"), runtime("Today's date is 2026-10-07."));
    grow(toolUse("call_a"), textResult("call_a", "a"));
    grow(human("queued while the request failed"));
    grow(runtime("Background work finished."));
    grow(reply("done"), human("next"), runtime("# Environment update"));
    grow(toolUse("call_b", "call_c"), textResult("call_b", "b"), textResult("call_c", ""));
    const requests = snapshots.map((snapshot) => toAnthropicMessagesRequest({ ...anthropic, cacheRetention: "1h" }, snapshot).messages);
    for (const messages of requests) {
      expect(messages.every((message, index) => index === 0 || message.role !== messages[index - 1]?.role)).toBe(true);
      expect(countCacheControl(messages)).toBe(1);
      expect(JSON.stringify(messages.at(-1)?.content.at(-1))).toContain("cache_control");
    }
    for (let index = 1; index < requests.length; index += 1) {
      const previous = JSON.parse(JSON.stringify(requests[index - 1]).replaceAll(',"cache_control":{"type":"ephemeral","ttl":"1h"}', ""));
      const next = JSON.parse(JSON.stringify(requests[index]).replaceAll(',"cache_control":{"type":"ephemeral","ttl":"1h"}', ""));
      const last = previous.length - 1;
      expect(next.slice(0, last)).toEqual(previous.slice(0, last));
      expect(next[last].role).toBe(previous[last].role);
      expect(next[last].content.slice(0, previous[last].content.length)).toEqual(previous[last].content);
    }
  });
});
