import { describe, expect, test } from "bun:test";
import { toOpenAIResponsesInput } from "../../../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses.js";
import type { ConversationMessage } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";

const openai = { sharedHost: false, accessProvider: "openai_api" as const, provider: "openai" as const, api: "openai-responses" as const, model: "o4" };

describe("toOpenAIResponsesInput invariants (canonical heal pass)", () => {
  test("passes through well-formed call/output pairs", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "hi" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }], ...openai, timestamp: 1 },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "ok" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out.filter((i) => i.type === "function_call")).toHaveLength(1);
    expect(out.filter((i) => i.type === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
  });

  test("aborted turns replay with interrupted tombstone outputs", () => {
    const messages: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }], ...openai, timestamp: 1, stopReason: "aborted" },
      { kind: "user", content: [{ type: "text", text: "never mind" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out.some((i) => i.type === "function_call")).toBe(true);
    const output = out.find((i) => i.type === "function_call_output");
    if (output?.type !== "function_call_output") throw new Error("expected function_call_output");
    expect(output.call_id).toBe("c1");
    expect(output.output).toContain("interrupted before a result was recorded");
  });
});

describe("toOpenAIResponsesInput", () => {
  test("orphan tool_use gets a synthetic tool result instead of being dropped", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "hello" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: { x: 1 } }], ...openai, timestamp: 1 },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ type: "function_call", call_id: "c1" });
    expect(out[2]).toEqual({ type: "function_call_output", call_id: "c1", output: "No result provided" });
  });

  test("orphan tool_result is dropped", () => {
    const messages: ConversationMessage[] = [
      { kind: "toolResult", toolUseId: "ghost", content: [{ type: "text", text: "stale" }] },
      { kind: "user", content: [{ type: "text", text: "fresh prompt" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out.some((i) => i.type === "function_call_output")).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user" });
  });
});

describe("trailing reasoning items on aborted-turn replay", () => {
  const reasoning = { type: "reasoning" as const, id: "rs_1", encrypted_content: "ENC", summary: [{ type: "summary_text" as const, text: "thought" }] };

  test("a reasoning item followed by same-turn output replays intact", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "go" }] },
      {
        kind: "assistant",
        content: [reasoning, { type: "tool_use", id: "c1", name: "read", input: {} }],
        ...openai,
        timestamp: 1,
      },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "ok" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    const reasoningIndex = out.findIndex((i) => i.type === "reasoning");
    const callIndex = out.findIndex((i) => i.type === "function_call");
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBe(reasoningIndex + 1);
  });

  test("a trailing reasoning item on an aborted turn is withheld, never sent as text", () => {
    // The aborted-turn shape OpenAI permanently 400s on: text or tool_use
    // followed by a reasoning item the abort cut off.
    const messages: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "go" }] },
      {
        kind: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "read", input: {} },
          reasoning,
        ],
        ...openai,
        timestamp: 1,
        stopReason: "aborted",
      },
      { kind: "toolResult", toolUseId: "c1", content: [{ type: "text", text: "ok" }], interrupted: true },
      { kind: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out.some((i) => i.type === "reasoning")).toBe(false);
    expect(JSON.stringify(out)).not.toContain("thought");
  });

  test("a trailing reasoning item with no summary is dropped", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "go" }] },
      {
        kind: "assistant",
        content: [
          { type: "text", text: "partial answer" },
          { type: "reasoning", id: "rs_2", encrypted_content: "ENC2" },
        ],
        ...openai,
        timestamp: 1,
        stopReason: "aborted",
      },
      { kind: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const out = toOpenAIResponsesInput(openai, messages);
    expect(out.some((i) => i.type === "reasoning")).toBe(false);
    expect(out.some((i) => i.type === "message" && i.content.some((c) => c.type === "output_text" && c.text === "partial answer"))).toBe(true);
  });
});
