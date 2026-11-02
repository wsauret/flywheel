import { describe, test, expect } from "bun:test";
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "../../../../src/infra/output/partial-json.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";

// ---------------------------------------------------------------------------
// StructuredOutputBuilder new methods
// ---------------------------------------------------------------------------
describe("StructuredOutputBuilder streaming methods", () => {
  test("pushTool with streaming flag sets streaming on the block", () => {
    const builder = new StructuredOutputBuilder();
    const idx = builder.pushTool("write", { name: "Write", detail: "" }, Date.now(), undefined, undefined, undefined, undefined, true);
    const blocks = builder.getBlocks();
    const block = blocks[idx];
    expect(block).toBeDefined();
    expect(block!.kind).toBe("tool");
    if (block!.kind === "tool") {
      expect(block!.status).toBe("streaming");
    }
  });

  test("streamingText.append records live text without touching the block tree", () => {
    const builder = new StructuredOutputBuilder();
    const idx = builder.pushTool("write", { name: "Write", detail: "" }, Date.now(), undefined, undefined, undefined, undefined, true);
    const blocksBefore = builder.getBlocks();
    builder.streamingText.append("tc-1", "hello ");
    builder.streamingText.append("tc-1", "world", "typescript");
    expect(builder.streamingText.snapshot()).toEqual({ "tc-1": { content: "hello world", filetype: "typescript" } });
    const block = builder.getBlocks()[idx];
    expect(block).toBe(blocksBefore[idx]!);
  });

  test("streamingText.clear removes the live text entry", () => {
    const builder = new StructuredOutputBuilder();
    builder.streamingText.append("tc-1", "partial content");
    builder.streamingText.clear("tc-1");
    expect(builder.streamingText.snapshot()).toEqual({});
  });

  test("finalizeStandaloneTool sets detail/diff/content on the block", () => {
    const builder = new StructuredOutputBuilder();
    const idx = builder.pushTool("write", { name: "Write", detail: "" }, Date.now(), undefined, undefined, undefined, undefined, true);
    builder.finalizeStandaloneTool(idx, { presentation: { name: "Write", detail: "test.ts" }, content: "final content", filetype: "typescript" });
    const block = builder.getBlocks()[idx];
    if (block!.kind === "tool") {
      expect(block!.presentation.detail).toBe("test.ts");
      expect(block!.status).toBe("pending");
      expect(block!.content).toBe("final content");
      expect(block!.filetype).toBe("typescript");
    }
  });

});

// ---------------------------------------------------------------------------
// RuntimeEventProjector — streaming tool input flow
// ---------------------------------------------------------------------------
describe("RuntimeEventProjector streaming tool input", () => {
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

  function toolExecutionOutputEvent(toolUseId: string, output: string, parentToolUseId?: string): RuntimeEvent {
    return createRuntimeEvent("tool.execution_output.delta", {
      type: "tool.execution_output.delta",
      tool_use_id: toolUseId,
      output,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    });
  }

  function toolInputCompleteEvent(id: string, name: string, input: { [key: string]: unknown }, parentToolUseId?: string): RuntimeEvent {
    return createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      tool_use: { id, name, input },
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    });
  }

  function toolResultEvent(toolUseId: string, details?: unknown): RuntimeEvent {
    return createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: toolUseId,
      content: [{ type: "text", text: "ok" }],
      is_error: false,
      ...(details !== undefined ? { details } : {}),
    });
  }

  test("tool_input_start places one neutral write row and refines it in place", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));

    const started = projector.getBlocks().filter(b => b.kind === "tool");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      id: "tc-1",
      name: "write",
      presentation: { name: "Write", detail: "" },
      status: "streaming",
    });

    parser.dispatch(toolInputDeltaEvent("tc-1", '{"path":"test.ts"'));
    const rows = projector.getBlocks().filter(b => b.kind === "tool");
    expect(rows).toHaveLength(1);
    const toolBlock = rows[0];
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.name).toBe("write");
      expect(toolBlock.status).toBe("streaming");
    }
  });

  test("tool_input_start places one neutral edit row before declared fields arrive", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-2", name: "edit", input: {} },
    ]));

    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({
      id: "tc-2",
      presentation: { name: "Edit", detail: "" },
      status: "streaming",
    });

    parser.dispatch(toolInputDeltaEvent("tc-2", '{"path":"test.ts"'));
    const toolBlock = projector.getBlocks().find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.name).toBe("edit");
      expect(toolBlock.status).toBe("streaming");
    }
  });

  test("tool_input_delta publishes character-level write proposals without structural upserts", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));

    parser.dispatch(toolInputDeltaEvent("tc-1", '{"path":"/workspace/test.ts","content":"h'));
    const firstProposal = projector.snapshot().streamingToolText["tc-1"];
    expect(firstProposal).toMatchObject({
      proposedDiff: {
        files: [{
          path: "test.ts",
          action: "add",
          hunks: [{ lines: [{ kind: "add", text: "h", partial: true }] }],
        }],
      },
    });
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("proposedDiff");

    parser.dispatch(toolInputDeltaEvent("tc-1", "i"));
    expect(projector.snapshot().streamingToolText["tc-1"]).toMatchObject({
      proposedDiff: {
        files: [{
          hunks: [{ lines: [{ kind: "add", text: "hi", partial: true }] }],
        }],
      },
    });
    const toolBlock = projector.getBlocks().find(b => b.kind === "tool");
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.id).toBe("tc-1");
    }
  });

  test("tool_execution_output_delta updates live text for pending bash tool", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(toolInputCompleteEvent("bash-1", "bash", { command: "echo hi" }));
    parser.dispatch(toolExecutionOutputEvent("bash-1", "hi\n"));

    const toolBlock = projector.getBlocks().find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.name).toBe("bash");
      expect(toolBlock.status).toBe("pending");
    }
    expect(projector.snapshot().streamingToolText["bash-1"]).toEqual({ content: "hi\n" });
  });

  test("tool input and execution output share live text only in disjoint phases", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-disjoint", name: "write", input: {} },
    ]));
    parser.dispatch(toolInputDeltaEvent("tc-disjoint", '{"path":"test.ts","content":"draft"'));

    const streamingBlock = projector.getBlocks().find(b => b.kind === "tool");
    if (streamingBlock?.kind === "tool") {
      expect(streamingBlock.status).toBe("streaming");
    }
    expect(projector.snapshot().streamingToolText["tc-disjoint"]).toHaveProperty("proposedDiff");

    parser.dispatch(toolInputCompleteEvent("tc-disjoint", "write", { path: "test.ts", content: "final" }));
    expect(projector.snapshot().streamingToolText).toEqual({});

    const pendingBlock = projector.getBlocks().find(b => b.kind === "tool");
    if (pendingBlock?.kind === "tool") {
      expect(pendingBlock.status).toBe("pending");
    }
    parser.dispatch(toolExecutionOutputEvent("tc-disjoint", "writing file\n"));
    expect(projector.snapshot().streamingToolText["tc-disjoint"]?.content).toBe("writing file\n");
  });

  test("streaming Bash input completes to pending before execution output arrives", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "bash-stream", name: "bash", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("bash-stream", '{"command":"printf output"}'));
    parser.dispatch(toolInputCompleteEvent("bash-stream", "bash", { command: "printf output" }));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ id: "bash-stream", status: "pending" });
    parser.dispatch(toolExecutionOutputEvent("bash-stream", "output"));
    expect(projector.snapshot().streamingToolText["bash-stream"]).toEqual({ content: "output" });
  });

  test("a Bash call declares mutation from its first field, before its command streams", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "bash-edit", name: "bash", input: {} }]));
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("declaresMutation");
    parser.dispatch(toolInputDeltaEvent("bash-edit", '{"mutates":true,'));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ id: "bash-edit", status: "streaming", declaresMutation: true });
    parser.dispatch(toolInputDeltaEvent("bash-edit", '"command":"python3 reshape.py"}'));
    parser.dispatch(toolInputCompleteEvent("bash-edit", "bash", { mutates: true, command: "python3 reshape.py" }));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ id: "bash-edit", status: "pending", declaresMutation: true });
  });

  test("replays a recorded edits input as a mutation row", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "old-bash", name: "bash", input: { edits: true, command: "python3 reshape.py" } }]));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({ id: "old-bash", declaresMutation: true });
  });

  test("tool_result clears live execution output", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(toolInputCompleteEvent("bash-result", "bash", { command: "echo hi" }));
    parser.dispatch(toolExecutionOutputEvent("bash-result", "hi\n"));
    expect(projector.snapshot().streamingToolText["bash-result"]?.content).toBe("hi\n");

    parser.dispatch(toolResultEvent("bash-result"));
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test("background result retains live output and marker until turn reset", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(toolInputCompleteEvent("bash-background", "bash", { command: "server &" }));
    parser.dispatch(toolExecutionOutputEvent("bash-background", "early\n"));
    parser.dispatch(toolResultEvent("bash-background", { background: true }));

    expect(projector.snapshot().streamingToolText["bash-background"]?.content).toBe("early\n");
    expect(projector.getBlocks().find((block) => block.kind === "tool")).toMatchObject({
      status: "completed",
      background: true,
    });

    parser.dispatch(toolExecutionOutputEvent("bash-background", "subsequent\n"));
    expect(projector.snapshot().streamingToolText["bash-background"]?.content).toBe("subsequent\n");
    projector.apply({ type: "end-turn", timestamp: Date.now(), finalStatus: "completed" });
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test("parented execution output follows the routed child tool id", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "agent-tool", name: "subagent", input: { description: "work" } },
    ]));
    parser.dispatch(toolInputCompleteEvent("bash-child", "bash", { command: "echo child" }, "agent-tool"));
    parser.dispatch(toolExecutionOutputEvent("bash-child", "child\n", "agent-tool"));

    const agentBlock = projector.getBlocks().find(b => b.kind === "agentGroup");
    expect(agentBlock).toBeDefined();
    if (agentBlock?.kind === "agentGroup") {
      expect(agentBlock.children).toHaveLength(1);
      expect(agentBlock.children[0]?.id).toBe("bash-child");
      expect(agentBlock.children[0]?.status).toBe("pending");
    }
    expect(projector.snapshot().streamingToolText["bash-child"]?.content).toBe("child\n");
  });

  test("tool_input_delta streams an incomplete content string", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));

    parser.dispatch(toolInputDeltaEvent("tc-1", '{"path":"test.ts","content":"hel'));

    expect(projector.snapshot().streamingToolText["tc-1"]).toHaveProperty("proposedDiff");
  });

  test("tool_input_delta decodes escapes split across provider chunks", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-split", name: "write", input: {} },
    ]));
    parser.dispatch(toolInputDeltaEvent("tc-split", '{"path":"test.ts","content":"first\\'));
    parser.dispatch(toolInputDeltaEvent("tc-split", 'nsecond \\uD83D'));
    parser.dispatch(toolInputDeltaEvent("tc-split", '\\uDE00'));

    expect(projector.snapshot().streamingToolText["tc-split"]).toMatchObject({
      proposedDiff: { files: [{ hunks: [{ lines: expect.arrayContaining([
        expect.objectContaining({ kind: "add", text: "second 😀" }),
      ]) }] }] },
    });
  });

  test("malformed or oversized provisional input does not override authoritative completion", () => {
    for (const [id, invalid] of [
      ["malformed", '{"content":"visible","ignored":[1,2}'],
      ["oversized", `{"content":"${"x".repeat(MAX_STREAMING_TOOL_INPUT_BYTES)}`],
    ] as const) {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      const parser = new RuntimeEventProjector(projector);
      parser.dispatch(assistantEvent([{ type: "tool_use", id, name: "write", input: {} }]));
      parser.dispatch(toolInputDeltaEvent(id, invalid));
      expect(projector.snapshot().streamingToolText[id]).toMatchObject({
        proposedDiff: { unavailable: invalid.startsWith('{"content":"visible"') ? "malformed" : "over-bound" },
      });
      parser.dispatch(toolInputCompleteEvent(id, "write", { path: "test.ts", content: "authoritative body" }));
      expect(projector.getBlocks().filter(b => b.kind === "tool")).toMatchObject([
        { id, status: "pending", fileChangeKind: "create", proposedDiff: { files: [{ path: "test.ts", action: "add" }] } },
      ]);
    }
  });

  test("empty authoritative completion has no body after malformed provisional input", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "empty", name: "write", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("empty", '{"content":"visible","ignored":[1,2}'));
    parser.dispatch(toolInputCompleteEvent("empty", "write", {}));
    expect(projector.snapshot().streamingToolText).toEqual({});
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("content");
  });

  test("tool_input_complete materializes deferred block with full info", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));

    parser.dispatch(toolInputCompleteEvent("tc-1", "write", {
      path: "/scratch/streaming-test-file.ts",
      content: "const x = 1;",
    }));

    const blocks = projector.getBlocks();
    const toolBlock = blocks.find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.status).toBe("pending");
      expect(toolBlock.proposedDiff).toMatchObject({ files: [{ path: "../scratch/streaming-test-file.ts", action: "add" }] });
    }
    expect(projector.snapshot().streamingToolText).toEqual({});
  });

  test("tool_input_complete re-patches detail from the full input after early materialization", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-search", name: "search", input: {} },
    ]));

    // The declared pattern field refines presentation during streaming.
    parser.dispatch(toolInputDeltaEvent("tc-search", '{"pattern":"priorBlocks"'));
    const earlyBlock = projector.getBlocks().find(b => b.kind === "tool");
    expect(earlyBlock).toBeDefined();
    if (earlyBlock?.kind === "tool") {
      expect(earlyBlock.presentation.detail).toBe('"priorBlocks"');
    }

    parser.dispatch(toolInputCompleteEvent("tc-search", "search", {
      pattern: "priorBlocks",
      path: "src/orchestration",
      output_mode: "content",
    }));

    const toolBlock = projector.getBlocks().find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.presentation.detail).toContain("priorBlocks");
      expect(toolBlock.presentation.detail).toContain("src/orchestration");
      expect(toolBlock.linkUri).toBeDefined();
    }
  });

  test("tool_result after tool_input_complete sets completed", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));
    parser.dispatch(toolInputCompleteEvent("tc-1", "write", {
      path: "/scratch/streaming-test-file.ts",
      content: "const x = 1;",
    }));
    parser.dispatch(toolResultEvent("tc-1"));

    const blocks = projector.getBlocks();
    const toolBlock = blocks.find(b => b.kind === "tool");
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.status).toBe("completed");
    }
  });

  test("tool_input_complete without prior deltas materializes directly", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-1", name: "write", input: {} },
    ]));

    parser.dispatch(toolInputCompleteEvent("tc-1", "write", {
      path: "/scratch/test.ts",
      content: "const y = 2;",
    }));

    const blocks = projector.getBlocks();
    const toolBlock = blocks.find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.status).toBe("pending");
      expect(toolBlock.proposedDiff).toMatchObject({ files: [{ path: "../scratch/test.ts", action: "add" }] });
    }
  });

  test("string edit streams new_string with the path filetype", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-edit", name: "edit", input: {} },
    ]));

    parser.dispatch(toolInputDeltaEvent("tc-edit", '{"path":"test.ts","old_string":"a",'));
    parser.dispatch(toolInputDeltaEvent("tc-edit", '"new_string":"b"}'));

    expect(projector.snapshot().streamingToolText["tc-edit"]).toMatchObject({
      proposedDiff: {
        files: [{ path: "test.ts", action: "update", hunks: [{ lines: expect.arrayContaining([
          expect.objectContaining({ kind: "add", text: "b" }),
        ]) }] }],
      },
    });
  });

  test("interruption retains visible proposals and reset keeps child rows compact", () => {
    const topLevel = new OutputProjector({ executionCwd: "/workspace" });
    const topLevelEvents = new RuntimeEventProjector(topLevel);
    topLevelEvents.dispatch(assistantEvent([{ type: "tool_use", id: "write-interrupted", name: "write", input: {} }]));
    topLevelEvents.dispatch(toolInputDeltaEvent("write-interrupted", '{"path":"top.ts","content":"draft'));
    topLevel.apply({ type: "end-turn", timestamp: 1, finalStatus: "paused" });
    expect(topLevel.snapshot().streamingToolText).toEqual({});
    expect(topLevel.getBlocks().find(b => b.kind === "tool")).toMatchObject({
      status: "interrupted",
      fileChangeKind: "create",
      proposedDiff: { files: [{ path: "top.ts", action: "add" }] },
    });

    const child = new OutputProjector({ executionCwd: "/workspace" });
    const childEvents = new RuntimeEventProjector(child);
    childEvents.dispatch(assistantEvent([{ type: "tool_use", id: "agent", name: "subagent", input: { description: "work" } }]));
    child.apply({ type: "tool-use", toolUseId: "child-write", name: "write", input: {}, timestamp: 2, parentToolUseId: "agent" });
    child.apply({ type: "tool-input-delta", toolUseId: "child-write", partialJson: '{"path":"child.ts","content":"draft', parentToolUseId: "agent" });
    child.resetTracking();
    const group = child.getBlocks().find(b => b.kind === "agentGroup");
    expect(group?.kind === "agentGroup" ? group.children[0] : undefined).toMatchObject({
      fileChangeKind: "create",
      presentation: { name: "Write", detail: "child.ts" },
    });
    expect(group?.kind === "agentGroup" ? group.children[0] : undefined).not.toHaveProperty("proposedDiff");
    expect(child.snapshot().streamingToolText).toEqual({});
  });

  test("immediate edit input stays pending without a provisional diff", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{
      type: "tool_use",
      id: "edit-immediate",
      name: "edit",
      input: { path: "src/a.ts", old_string: "old", new_string: "new" },
    }]));
    expect(projector.getBlocks().find(b => b.kind === "tool")).toMatchObject({
      id: "edit-immediate",
      status: "pending",
      presentation: { name: "Edit", detail: "src/a.ts" },
    });
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("diff");
    expect(projector.getBlocks().find(b => b.kind === "tool")).not.toHaveProperty("content");
  });

  test("ask_user start refines into one durable question identity", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }]));
    expect(projector.getBlocks()).toEqual([
      expect.objectContaining({ kind: "tool", id: "ask-1", presentation: { name: "Ask User", detail: "" } }),
    ]);
    projector.apply({
      type: "push-question",
      toolUseId: "ask-1",
      questions: [{ question: "Continue?", choices: [], multiSelect: false }],
      timestamp: 1,
    });
    expect(projector.getBlocks()).toEqual([
      expect.objectContaining({ kind: "question", toolUseId: "ask-1" }),
    ]);
  });

});
