import { describe, expect, test } from "bun:test";

import { applyContentRepairs, repairContentRefusal } from "../../../../../src/orchestration/agent-runtime/llm/content-repair.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const WITHHOLD_NOTE = "The provider refused the image of read call-1, so it is withheld.";
const REMOVE_NOTE = "The provider refused the calls call-2 and call-3, so they are removed.";

const image = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };

describe("applyContentRepairs", () => {
  test("a withhold replaces exactly that part with the decision's note", () => {
    const result: ConversationMessage = { kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] };
    const messages: ConversationMessage[] = [
      { kind: "user", content: "look" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "a.png" } }] },
      result,
      { kind: "system", content: WITHHOLD_NOTE, contentRepair: { kind: "withhold", toolUseId: "call-1", partIndex: 1, partKind: "image" } },
    ];
    const stored = structuredClone(result);

    const repaired = applyContentRepairs(messages);

    expect(repaired).toHaveLength(4);
    expect(repaired[2]).toEqual({ kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "before" }, { type: "text", text: WITHHOLD_NOTE }, { type: "text", text: "after" }] });
    expect(result).toEqual(stored);
    expect(repaired[3]).toBe(messages[3]!);
  });

  test("a withhold whose part is absent or of another kind changes nothing", () => {
    const messages: ConversationMessage[] = [
      { kind: "toolResult", toolUseId: "call-1", content: [image] },
      { kind: "system", content: WITHHOLD_NOTE, contentRepair: { kind: "withhold", toolUseId: "call-1", partIndex: 0, partKind: "text" } },
      { kind: "system", content: WITHHOLD_NOTE, contentRepair: { kind: "withhold", toolUseId: "call-1", partIndex: 4, partKind: "image" } },
    ];

    const repaired = applyContentRepairs(messages);

    expect(repaired[0]).toBe(messages[0]!);
  });

  test("a remove drops the calls and results, drops an emptied assistant message, and places the note as a system-origin user message", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "work" },
      { kind: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "call-2", name: "read", input: {} }, { type: "tool_use", id: "call-4", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-2", content: [{ type: "text", text: "refused" }] },
      { kind: "toolResult", toolUseId: "call-4", content: [{ type: "text", text: "kept" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-3", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-3", content: [{ type: "text", text: "refused too" }] },
      { kind: "system", content: REMOVE_NOTE, contentRepair: { kind: "remove", toolUseIds: ["call-2", "call-3"] } },
      { kind: "assistant", content: "continuing" },
    ];

    const repaired = applyContentRepairs(messages);

    expect(repaired).toEqual([
      { kind: "user", content: "work" },
      { kind: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "call-4", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-4", content: [{ type: "text", text: "kept" }] },
      { kind: "user", origin: "system", content: REMOVE_NOTE },
      { kind: "assistant", content: "continuing" },
    ]);
  });

  test("every message the decisions do not touch keeps its object identity", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "work" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-1", content: [image] },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-2", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-2", content: [{ type: "text", text: "refused" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "call-5", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "call-5", content: [{ type: "text", text: "untouched" }] },
      { kind: "system", content: WITHHOLD_NOTE, contentRepair: { kind: "withhold", toolUseId: "call-1", partIndex: 0, partKind: "image" } },
      { kind: "system", content: REMOVE_NOTE, contentRepair: { kind: "remove", toolUseIds: ["call-2"] } },
      { kind: "user", content: "next" },
    ];

    const repaired = applyContentRepairs(messages);

    const untouched = [0, 1, 5, 6, 7, 9].map((index) => messages[index]!);
    for (const message of untouched) expect(repaired).toContain(message);
    expect(repaired).toHaveLength(8);
    expect(repaired.filter((message) => !untouched.includes(message))).toEqual([
      { kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: WITHHOLD_NOTE }] },
      { kind: "user", origin: "system", content: REMOVE_NOTE },
    ]);
  });

  test("history without decisions returns the input array itself", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "work" },
      { kind: "system", content: "an ordinary notice" },
      { kind: "assistant", content: "done" },
    ];

    expect(applyContentRepairs(messages)).toBe(messages);
  });
});

describe("repairContentRefusal", () => {
  const reason = "Could not process image";

  test("a withhold note names the part kind, the call its result answers, and the provider's reason", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "a.png" } }] },
      { kind: "toolResult", toolUseId: "call-1", content: [image] },
    ];

    expect(repairContentRefusal(history, { reason, part: { toolUseId: "call-1", partIndex: 0, kind: "image" } }, "anthropic_api")).toEqual({
      kind: "system",
      content: '[Flywheel withheld this image from the result of read {"path":"a.png"} because the provider refused it: Could not process image]',
      contentRepair: { kind: "withhold", toolUseId: "call-1", partIndex: 0, partKind: "image" },
    });
  });

  test("a remove note joins every removed call, and a removal before the newest assistant message does not block it", () => {
    const history: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }] },
      { kind: "system", content: REMOVE_NOTE, contentRepair: { kind: "remove", toolUseIds: ["call-1"] } },
      { kind: "assistant", content: [{ type: "text", text: "trying others" }, { type: "tool_use", id: "call-2", name: "read", input: { path: "b.png" } }, { type: "tool_use", id: "call-3", name: "bash", input: { command: "ls" } }] },
      { kind: "toolResult", toolUseId: "call-2", content: [image] },
      { kind: "toolResult", toolUseId: "call-3", content: [{ type: "text", text: "b.png" }] },
    ];

    expect(repairContentRefusal(history, { reason }, "anthropic_api")).toEqual({
      kind: "system",
      content: 'Flywheel removed your most recent tool calls (read {"path":"b.png"}; bash {"command":"ls"}) and their results from this conversation, because the provider refused the request that contained them: Could not process image. Running them again would repeat the refusal. Do not run them again; continue the task without their results, or tell the person that you cannot continue without them.',
      contentRepair: { kind: "remove", toolUseIds: ["call-2", "call-3"] },
    });
  });
});
