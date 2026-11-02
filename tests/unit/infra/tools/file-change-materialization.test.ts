import { describe, expect, test } from "bun:test";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import type { ToolEntry } from "../../../../src/infra/output-blocks.js";
import { selectFileChangeBody } from "../../../../src/protocol/client/file-change-body.js";
import { buildMutationEvidence } from "../../../../src/infra/mutation-evidence.js";
import { createRecordingFileMutationStore } from "../../orchestration/agent-runtime/tools/_fixtures.js";

function tool(projector: OutputProjector): ToolEntry {
  const block = projector.getBlocks().find((candidate) => candidate.kind === "tool");
  if (!block || block.kind !== "tool") throw new Error("expected tool block");
  return block;
}

function dispatchTool(projector: RuntimeEventProjector, id: string, name: string, input: { [key: string]: unknown }): void {
  projector.dispatch(createRuntimeEvent("model.assistant_message.recorded", {
    type: "model.assistant_message.recorded",
    message: { content: [{ type: "tool_use", id, name, input }] },
  }));
}

describe("file change materialization", () => {
  test("an unclosed streaming row carries structural registration and a selectable proposal", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" });
    output.apply({ type: "tool-use", toolUseId: "stream-write", name: "write", input: {}, timestamp: 1 });
    expect(tool(output).fileChangeKind).toBe("create");
    output.apply({ type: "tool-input-delta", toolUseId: "stream-write", partialJson: '{"path":"a.ts","content":"draft' });
    const row = tool(output);
    expect(row).toMatchObject({ id: "stream-write", status: "streaming", fileChangeKind: "create" });
    const selected = selectFileChangeBody(row, output.snapshot().streamingToolText["stream-write"]);
    expect(selected).toMatchObject({ kind: "proposed", proposedDiff: { files: [{ path: "a.ts", hunks: [{ lines: [{ text: "draft", partial: true }] }] }] } });
  });
  test("an unclosed patch refines its registration before displaying multiple files", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" });
    output.apply({ type: "tool-use", toolUseId: "stream-patch", name: "apply_patch", input: {}, timestamp: 1 });
    const input = "*** Begin Patch\n*** Add File: first.ts\n+const first = 1;\n*** Add File: second.ts\n+const second";
    output.apply({ type: "tool-input-delta", toolUseId: "stream-patch", partialJson: JSON.stringify({ input }).slice(0, -2) });
    const row = tool(output);
    expect(row).toMatchObject({ id: "stream-patch", status: "streaming", fileChangeKind: "patch" });
    const selected = selectFileChangeBody(row, output.snapshot().streamingToolText["stream-patch"]);
    expect(selected).toMatchObject({ kind: "proposed", proposedDiff: { files: [{ path: "first.ts" }, { path: "second.ts" }] } });
  });
  test("registered write calls expose only a create proposal", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" });
    const events = new RuntimeEventProjector(output);
    dispatchTool(events, "write-1", "write", { path: "src/a.ts", content: "const a = 1;" });

    expect(tool(output)).toMatchObject({ fileChangeKind: "create", proposedDiff: { files: [{ path: "src/a.ts", action: "add" }] } });
    expect(tool(output)).not.toHaveProperty("content");
    expect(tool(output)).not.toHaveProperty("diff");
    expect(tool(output)).not.toHaveProperty("filetype");
    expect(tool(output)).not.toHaveProperty("invocationBody");

    const patchOutput = new OutputProjector({ executionCwd: "/workspace" });
    dispatchTool(new RuntimeEventProjector(patchOutput), "patch-1", "apply_patch", {
      input: "*** Begin Patch\n*** Add File: a.ts\n+const a = 1;\n*** End Patch",
    });
    expect(tool(patchOutput)).toMatchObject({
      fileChangeKind: "patch",
      proposedDiff: { files: [{ path: "a.ts", action: "add" }] },
    });
  });

  test("streamed edit failure clears every unverified body and successful settlement clears every proposal field", async () => {
    const mutationEvidence = await buildMutationEvidence([], createRecordingFileMutationStore().writer.stageSessionContentNodes);
    const output = new OutputProjector({ executionCwd: "/workspace" });
    const events = new RuntimeEventProjector(output);
    dispatchTool(events, "edit-1", "edit", {});
    events.dispatch(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      tool_use: { id: "edit-1", name: "edit", input: { path: "a.ts", old_string: "old", new_string: "new" } },
    }));
    expect(tool(output)).toMatchObject({ fileChangeKind: "replace", proposedDiff: { files: [{ path: "a.ts", action: "update" }] } });

    events.dispatch(createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: "edit-1",
      content: [{ type: "text", text: "failed" }],
      is_error: true,
      details: { mutationEvidence },
    }));
    expect(tool(output)).toMatchObject({
      status: "error",
      errorMessage: "Failed",
      fileChangeKind: "replace",
      mutationEvidence,
    });
    expect(tool(output)).not.toHaveProperty("proposedDiff");
    expect(tool(output)).not.toHaveProperty("invocationBody");
    expect(tool(output)).not.toHaveProperty("content");
    expect(tool(output)).not.toHaveProperty("diff");
    expect(tool(output)).not.toHaveProperty("filetype");

    const success = new OutputProjector({ executionCwd: "/workspace" });
    const successEvents = new RuntimeEventProjector(success);
    dispatchTool(successEvents, "write-2", "write", { path: "empty.ts", content: "" });
    successEvents.dispatch(createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded", tool_use_id: "write-2", content: [{ type: "text", text: "ok" }], is_error: false,
    }));
    expect(tool(success).fileChangeKind).toBe("create");
    expect(tool(success)).not.toHaveProperty("proposedDiff");
    expect(tool(success)).not.toHaveProperty("content");
    expect(tool(success)).not.toHaveProperty("diff");
    expect(tool(success)).not.toHaveProperty("filetype");
    expect(tool(success)).not.toHaveProperty("invocationBody");
  });

  test("direct builder and child settlement clear proposal fields on success", () => {
    const proposal = { files: [{ id: "file-0", path: "a.ts", action: "add" as const, hunks: [] }] };
    const builder = new StructuredOutputBuilder();
    const index = builder.pushStandaloneToolEntry({ kind: "tool", id: "direct", name: "write", presentation: { name: "Write", detail: "a.ts" }, timestamp: 1, status: "pending", fileChangeKind: "create", proposedDiff: proposal });
    builder.completeTool(index, { fileChangeKind: undefined, proposedDiff: undefined });
    expect(builder.getBlocks()[index]).not.toHaveProperty("proposedDiff");

    builder.startAgent("agent", { containerKind: "subagent", label: "Agent", description: "" }, 2, "parent");
    builder.pushToolRowToAgent("agent", { kind: "tool", id: "child", name: "write", presentation: { name: "Write", detail: "a.ts" }, timestamp: 3, status: "pending", fileChangeKind: "create", proposedDiff: proposal });
    builder.completeAgentChildTool("agent", 0, { fileChangeKind: undefined, proposedDiff: undefined });
    const group = builder.getBlocks().find((block) => block.kind === "agentGroup");
    expect(group?.kind === "agentGroup" ? group.children[0] : undefined).not.toHaveProperty("proposedDiff");
  });
});
