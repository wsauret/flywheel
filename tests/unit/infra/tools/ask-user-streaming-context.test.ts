import { describe, expect, test } from "bun:test";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";

function assistantEvent(content: Array<{ type: "tool_use"; id: string; name: string; input: { [key: string]: unknown } }>): RuntimeEvent {
  return createRuntimeEvent("model.assistant_message.recorded", {
    type: "model.assistant_message.recorded",
    message: { content },
  });
}

function toolInputCompleteEvent(id: string, name: string, input: { [key: string]: unknown }): RuntimeEvent {
  return createRuntimeEvent("tool.input.completed", {
    type: "tool.input.completed",
    tool_use: { id, name, input },
  });
}

function toolResultEvent(toolUseId: string): RuntimeEvent {
  return createRuntimeEvent("tool.result.recorded", {
    type: "tool.result.recorded",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: "ok" }],
    is_error: false,
  });
}

describe("ask_user streaming context", () => {
  test("inserts context before its provisional row without shifting concurrent tool settlement", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace", onChange: () => {} });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "ask-context", name: "ask_user", input: {} },
      { type: "tool_use", id: "read-concurrent", name: "read", input: {} },
    ]), 1);
    projector.drainChanges();

    parser.dispatch(toolInputCompleteEvent("ask-context", "ask_user", {
      context: "I need one decision before I continue.",
      question: "Continue?",
      options: ["Yes", "No"],
    }), 2);

    expect(projector.getBlocks()).toEqual([
      expect.objectContaining({
        kind: "text",
        id: "ask-context:lead",
        content: "I need one decision before I continue.",
      }),
      expect.objectContaining({ kind: "tool", id: "ask-context", status: "streaming" }),
      expect.objectContaining({ kind: "tool", id: "read-concurrent", status: "streaming" }),
    ]);
    expect(projector.drainChanges()).toMatchObject({
      fullResync: false,
      changes: [
        { kind: "insert", index: 0, block: expect.objectContaining({ kind: "text", id: "ask-context:lead" }) },
      ],
    });

    projector.apply({
      type: "push-question",
      toolUseId: "ask-context",
      questions: [{ question: "Continue?", choices: [], multiSelect: false }],
      timestamp: 3,
    });
    expect(projector.drainChanges()).toMatchObject({
      fullResync: false,
      changes: [
        { kind: "upsert", index: 1, block: expect.objectContaining({ kind: "question", toolUseId: "ask-context" }) },
      ],
    });

    parser.dispatch(toolInputCompleteEvent("read-concurrent", "read", { path: "test.ts" }), 4);
    parser.dispatch(toolResultEvent("read-concurrent"), 5);
    expect(projector.getBlocks()[2]).toMatchObject({
      kind: "tool",
      id: "read-concurrent",
      status: "completed",
      presentation: { name: "Read", detail: "test.ts" },
    });
  });

  test("drains context insertion and question replacement as ordered deltas", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace", onChange: () => {} });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "ask-combined", name: "ask_user", input: {} }]), 1);
    projector.drainChanges();

    parser.dispatch(toolInputCompleteEvent("ask-combined", "ask_user", {
      context: "Choose the next step.",
      question: "Continue?",
      options: ["Yes", "No"],
    }), 2);
    projector.apply({
      type: "push-question",
      toolUseId: "ask-combined",
      questions: [{ question: "Continue?", choices: [], multiSelect: false }],
      timestamp: 3,
    });

    expect(projector.drainChanges()).toMatchObject({
      fullResync: false,
      changes: [
        { kind: "insert", index: 0, block: expect.objectContaining({ kind: "text", id: "ask-combined:lead" }) },
        { kind: "upsert", index: 1, block: expect.objectContaining({ kind: "question", toolUseId: "ask-combined" }) },
      ],
    });
  });

  test("keeps only the provisional identity without context", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "ask-no-context", name: "ask_user", input: {} }]));
    parser.dispatch(toolInputCompleteEvent("ask-no-context", "ask_user", {
      question: "Continue?",
      options: ["Yes", "No"],
    }));

    expect(projector.getBlocks()).toEqual([
      expect.objectContaining({ kind: "tool", id: "ask-no-context", status: "streaming" }),
    ]);
  });
});
