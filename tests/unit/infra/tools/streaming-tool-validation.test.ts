import { describe, expect, test } from "bun:test";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";

function assistantEvent(content: NonNullable<Extract<RuntimeEvent, { type: "model.assistant_message.recorded" }>["data"]["message"]>["content"]): RuntimeEvent {
  return createRuntimeEvent("model.assistant_message.recorded", {
    type: "model.assistant_message.recorded",
    message: { content },
  });
}

function toolInputDeltaEvent(toolUseId: string, partialJson: string): RuntimeEvent {
  return createRuntimeEvent("tool.input.delta", {
    type: "tool.input.delta",
    tool_use_id: toolUseId,
    partial_json: partialJson,
  });
}

function toolInputCompleteEvent(id: string, name: string, input: { readonly [key: string]: unknown }): RuntimeEvent {
  return createRuntimeEvent("tool.input.completed", {
    type: "tool.input.completed",
    tool_use: { id, name, input },
  });
}

function toolPreviewCheckEvent(toolUseId: string, operation: { type: "set"; advice: string } | { type: "clear" }): RuntimeEvent {
  return createRuntimeEvent("tool.preview.check", { tool_use_id: toolUseId, operation });
}

function failedResult(toolUseId: string, text: string): RuntimeEvent {
  return createRuntimeEvent("tool.result.recorded", {
    type: "tool.result.recorded",
    tool_use_id: toolUseId,
    content: [{ type: "text", text }],
    is_error: true,
  });
}

describe("RuntimeEventProjector file validation and failure", () => {
  test.each([
    {
      name: "write",
      first: '{"path":"test.ts","content":"first',
      next: " second",
      complete: { path: "test.ts", content: "canonical" },
    },
    {
      name: "apply_patch",
      first: '{"input":"*** Begin Patch\\n*** Update File: src/a.ts\\n',
      next: "+second\\n",
      complete: { input: "*** Begin Patch\n*** Update File: src/a.ts\n+canonical\n*** End Patch\n" },
    },
  ])("$name preview advice suppresses proposals while parsing and clear restores the latest proposal", ({ name, first, next, complete }) => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    const id = `preview-${name}`;

    parser.dispatch(assistantEvent([{ type: "tool_use", id, name, input: {} }]));
    parser.dispatch(toolInputDeltaEvent(id, first));
    expect(projector.snapshot().streamingToolText[id]).toHaveProperty("proposedDiff");
    parser.dispatch(toolPreviewCheckEvent(id, { type: "set", advice: "Review this change" }));
    expect(projector.snapshot().streamingToolText[id]).toEqual({ previewCheck: "Review this change" });
    parser.dispatch(toolInputDeltaEvent(id, next));
    expect(projector.snapshot().streamingToolText[id]).toEqual({ previewCheck: "Review this change" });
    parser.dispatch(toolPreviewCheckEvent(id, { type: "clear" }));
    expect(projector.snapshot().streamingToolText[id]).toHaveProperty("proposedDiff");
    parser.dispatch(toolPreviewCheckEvent(id, { type: "set", advice: "Check canonical input" }));
    parser.dispatch(toolInputCompleteEvent(id, name, complete));
    expect(projector.snapshot().streamingToolText).toEqual({});
    expect(projector.getBlocks().find((block) => block.kind === "tool" && block.id === id)).toHaveProperty("proposedDiff");
    parser.dispatch(toolPreviewCheckEvent(id, { type: "set", advice: "Too late" }));
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test.each(["completed", "error", "retry", "interrupted"] as const)("preview advice clears for %s settlement and ignores late checks", (settlement) => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    const id = `preview-${settlement}`;
    parser.dispatch(assistantEvent([{ type: "tool_use", id, name: "write", input: {} }]));
    parser.dispatch(toolInputDeltaEvent(id, '{"path":"test.ts","content":"draft'));
    parser.dispatch(toolPreviewCheckEvent(id, { type: "set", advice: "Review" }));
    if (settlement === "retry" || settlement === "interrupted") {
      projector.apply({ type: "abandon-tool-inputs", reason: settlement });
    } else {
      parser.dispatch(createRuntimeEvent("tool.result.recorded", {
        type: "tool.result.recorded",
        tool_use_id: id,
        content: [{ type: "text", text: settlement }],
        is_error: settlement === "error",
      }));
    }
    expect(projector.snapshot().streamingToolText).toEqual({});
    parser.dispatch(toolPreviewCheckEvent(id, { type: "set", advice: "Too late" }));
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test("preview checks for non-file tools are ignored", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(toolInputCompleteEvent("bash-preview", "bash", { command: "echo hi" }));
    parser.dispatch(toolPreviewCheckEvent("bash-preview", { type: "set", advice: "Review" }));
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test("completed generated write input atomically becomes a structural proposal and failure removes it", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "tc-failed-write", name: "write", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("tc-failed-write", '{"path":"test.ts","content":"draft body"'));
    parser.dispatch(toolInputCompleteEvent("tc-failed-write", "write", { path: "test.ts", content: "draft body" }));
    expect(projector.snapshot().streamingToolText).toEqual({});
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({
      id: "tc-failed-write",
      status: "pending",
      fileChangeKind: "create",
      proposedDiff: { files: [{ path: "test.ts", action: "add" }] },
    });
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("content");
    parser.dispatch(failedResult("tc-failed-write", "write failed"));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ status: "error", fileChangeKind: "create" });
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("proposedDiff");
  });

  test("late input completion cannot restore a failed write proposal", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "late-write", name: "write", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("late-write", '{"path":"late.ts","content":"draft"'));
    parser.dispatch(failedResult("late-write", "write failed"));
    parser.dispatch(toolInputCompleteEvent("late-write", "write", { path: "late.ts", content: "draft" }));
    const rows = projector.getBlocks().filter((block) => block.kind === "tool" && block.id === "late-write");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "error", fileChangeKind: "create", errorMessage: "Write failed" });
    expect(rows[0]).not.toHaveProperty("proposedDiff");
  });

  test("apply_patch streams raw input as a diff through the edit display", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "tc-patch", name: "apply_patch", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("tc-patch", '{"input":"*** Begin Patch\\n*** Update File: src/a.ts\\n'));
    expect(projector.snapshot().streamingToolText["tc-patch"]).toMatchObject({
      proposedDiff: { files: [{ path: "src/a.ts", action: "update" }] },
    });
    parser.dispatch(toolInputCompleteEvent("tc-patch", "apply_patch", {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\n",
    }));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({
      status: "pending",
      fileChangeKind: "patch",
      proposedDiff: { files: [{ path: "src/a.ts", action: "update" }] },
    });
    parser.dispatch(failedResult("tc-patch", "patch failed"));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ status: "error", fileChangeKind: "patch" });
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("proposedDiff");
  });
});
