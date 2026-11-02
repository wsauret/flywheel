import { safeParse } from "../../helpers/schema-assertions.js";
import { describe, expect, test } from "bun:test";
import { AnyBlockSchema, isVisibleMessageBlock, type AnyBlock } from "../../../src/infra/output-blocks";

// Regression coverage for Phase 5 Theme 3 t5.4: schema fields the sole writer
// always sets are now required. Omitting them must fail parsing.

describe("output-blocks: tightened required fields", () => {
  test("visible message classifier counts only text and delivered users across every block kind", () => {
    const blocks: readonly AnyBlock[] = [
      { kind: "text", id: "text", content: "answer", timestamp: 1 },
      { kind: "userMessage", id: "delivered", content: "sent", timestamp: 2, pending: false, injected: false },
      { kind: "userMessage", id: "pending", content: "sending", timestamp: 3, pending: true, injected: false },
      { kind: "tool", id: "tool", name: "read", presentation: { name: "Read", detail: "file" }, timestamp: 4, status: "completed" },
      { kind: "agentGroup", id: "group", label: "Agent", description: "work", children: [], totalToolCount: 0, timestamp: 5, toolUseId: "agent", containerKind: "subagent", status: "completed" },
      { kind: "system", id: "system", message: "notice", timestamp: 6 },
      { kind: "thinking", id: "thinking", content: "thought", status: "completed", timestamp: 7 },
      { kind: "divider", id: "boundary", label: "Step", timestamp: 8 },
      { kind: "question", toolUseId: "question", questions: [], timestamp: 9 },
      { kind: "degraded", id: "gap", factFamily: "chat_tree", failureClass: "decode_failure", eventType: "event", eventVersion: 1, eventPosition: 1, notice: "Part of this transcript could not be displayed.", timestamp: 10 },
    ]

    expect(blocks.map(isVisibleMessageBlock)).toEqual([true, true, false, false, false, false, false, false, false, false])
  })

  test("UserMessageBlock rejects a block missing pending", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "userMessage",
      content: "hi",
      timestamp: 1,
      injected: false,
    });
    expect(result.success).toBe(false);
  });

  test("UserMessageBlock rejects a block missing injected", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "userMessage",
      content: "hi",
      timestamp: 1,
      pending: false,
    });
    expect(result.success).toBe(false);
  });

  test("QuestionEntry rejects a question missing multiSelect", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "question",
      toolUseId: "tu-1",
      questions: [{ question: "pick", choices: [{ kind: "option", label: "a" }] }],
      timestamp: 1,
    });
    expect(result.success).toBe(false);
  });

});
