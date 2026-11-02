import { describe, expect, spyOn, test } from "bun:test";
import { Log } from "../../../../../src/infra/log.js";
import { healConversation } from "../../../../../src/orchestration/agent-runtime/llm/heal-messages.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const anthropic = { api: "anthropic-messages" as const, provider: "anthropic" as const, model: "claude", timestamp: 1 };

describe("healConversation", () => {
  test("orphan tool_use gets synthesized toolResult with text-part content", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }], ...anthropic },
    ];
    const healed = healConversation(history);
    const synth = healed.find((m) => m.kind === "toolResult" && m.toolUseId === "call_1");
    if (synth?.kind !== "toolResult") throw new Error("expected toolResult");
    expect(synth).toEqual({
      kind: "toolResult",
      toolUseId: "call_1",
      isError: true,
      content: [{ type: "text", text: "No result provided" }],
    });
  });

  test("satisfied tool_use ids are not synthesized", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }], ...anthropic },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "ok" }] },
    ];
    const healed = healConversation(history);
    const toolResults = healed.filter((m) => m.kind === "toolResult");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.kind !== "toolResult") throw new Error("expected toolResult");
    expect(toolResults[0].content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("blank interrupted tool results are replaced with canonical tombstones", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "ask_user", input: {} }], ...anthropic },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "" }], isError: true, interrupted: true },
    ];

    expect(healConversation(history).at(-1)).toEqual({
      kind: "toolResult",
      toolUseId: "call_1",
      isError: true,
      interrupted: true,
      content: [{ type: "text", text: "Tool 'ask_user' was interrupted before a result was recorded." }],
    });
  });

  test("only unsatisfied ids from a parallel tool_use turn are synthesized", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [
        { type: "tool_use", id: "call_a", name: "read", input: {} },
        { type: "tool_use", id: "call_b", name: "read", input: {} },
      ], ...anthropic },
      { kind: "toolResult", toolUseId: "call_a", content: [{ type: "text", text: "ok" }] },
    ];
    const healed = healConversation(history);
    const toolResults = healed.filter((m) => m.kind === "toolResult");
    expect(toolResults.map((m) => m.toolUseId)).toEqual(["call_a", "call_b"]);
    expect(toolResults[0]?.isError).toBeUndefined();
    expect(toolResults[1]).toEqual({
      kind: "toolResult",
      toolUseId: "call_b",
      isError: true,
      content: [{ type: "text", text: "No result provided" }],
    });
  });

  test("a user message between assistant tool_use and its result flushes pending", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }], ...anthropic },
      { kind: "user", content: [{ type: "text", text: "wait actually" }] },
    ];
    const healed = healConversation(history);
    const assistantIdx = healed.findIndex((m) => m.kind === "assistant");
    const toolResultIdx = healed.findIndex((m) => m.kind === "toolResult");
    const userIdx = healed.findIndex((m) => m.kind === "user");
    expect(toolResultIdx).toBeGreaterThan(assistantIdx);
    expect(toolResultIdx).toBeLessThan(userIdx);
    const synth = healed[toolResultIdx];
    if (synth?.kind !== "toolResult") throw new Error("expected toolResult");
    expect(synth.content).toEqual([{ type: "text", text: "No result provided" }]);
  });

  test("assistant turns with stopReason error are dropped", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_err", name: "read", input: {} }], ...anthropic, stopReason: "error" },
      { kind: "user", content: "continue" },
    ];
    expect(healConversation(history)).toEqual([{ kind: "user", content: "continue" }]);
  });

  test("aborted turns are replayed with interrupted tombstones for their tool calls", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [
        { type: "text", text: "partial work" },
        { type: "tool_use", id: "call_1", name: "bash", input: {} },
      ], ...anthropic, stopReason: "aborted" },
      { kind: "user", content: "never mind" },
    ];
    const healed = healConversation(history);
    expect(healed).toHaveLength(3);
    expect(healed[0]).toBe(history[0]!);
    expect(healed[1]).toEqual({
      kind: "toolResult",
      toolUseId: "call_1",
      isError: true,
      interrupted: true,
      content: [{ type: "text", text: "Tool 'bash' was interrupted before a result was recorded." }],
    });
    expect(healed[2]).toEqual({ kind: "user", content: "never mind" });
  });

  test("orphan toolResults are dropped", () => {
    const history: ConversationMessage[] = [
      { kind: "toolResult", toolUseId: "ghost", content: [{ type: "text", text: "stale" }] },
      { kind: "user", content: "fresh prompt" },
    ];
    expect(healConversation(history)).toEqual([{ kind: "user", content: "fresh prompt" }]);
  });

  test("duplicate toolResults for an answered id are dropped", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }], ...anthropic },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "first" }] },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "second" }] },
    ];
    const healed = healConversation(history);
    const results = healed.filter((m) => m.kind === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toEqual([{ type: "text", text: "first" }]);
  });

  test("one secret-safe diagnostic reports each flush that synthesized dangling results", () => {
    const warn = spyOn(Log.create({ service: "heal-messages" }), "warn").mockImplementation(() => {});
    try {
      const history: ConversationMessage[] = [
        { kind: "assistant", content: [
          { type: "tool_use", id: "call_a", name: "read", input: { path: "/etc/passwd" } },
          { type: "tool_use", id: "call_b", name: "bash", input: { command: "echo $API_KEY" } },
        ], ...anthropic },
        { kind: "user", content: "carry on" },
        { kind: "assistant", content: [{ type: "tool_use", id: "call_c", name: "bash", input: {} }], ...anthropic, stopReason: "aborted" },
      ];
      healConversation(history);

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]).toEqual(["synthesized dangling tool results", { synthesized: 2, aborted: false }]);
      expect(warn.mock.calls[1]).toEqual(["synthesized dangling tool results", { synthesized: 1, aborted: true }]);
      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toContain("call_a");
      expect(serialized).not.toContain("bash");
      expect(serialized).not.toContain("API_KEY");
    } finally {
      warn.mockRestore();
    }
  });

  test("history with no dangling tool call emits no diagnostic", () => {
    const warn = spyOn(Log.create({ service: "heal-messages" }), "warn").mockImplementation(() => {});
    try {
      healConversation([
        { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }], ...anthropic },
        { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "ok" }] },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
