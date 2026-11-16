import { describe, test, expect, spyOn } from "bun:test";
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "../../../../src/infra/output/partial-json.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";
import { StreamingToolInputs, type StreamingInputUpdate } from "../../../../src/infra/output/streaming-tool-inputs.js";
import { resolveToolRowPresentation } from "../../../../src/infra/tools/tool-display-registry.js";
import { parseShell, ShellScanner } from "../../../../src/infra/tools/shell-words.js";

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

  function toolExecutionOutputEvent(toolUseId: string, output: string): RuntimeEvent {
    return createRuntimeEvent("tool.execution_output.delta", {
      type: "tool.execution_output.delta",
      tool_use_id: toolUseId,
      output,
    });
  }

  function toolInputCompleteEvent(id: string, name: string, input: { [key: string]: unknown }): RuntimeEvent {
    return createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      tool_use: { id, name, input },
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

  test.each([
    ["edits list", ['{"path":"test.ts","edits":[{"old_string":"a",', '"new_string":"b"}]}']],
    ["single-edit shape", ['{"path":"test.ts","old_string":"a",', '"new_string":"b"}']],
  ])("string edit streams both sides of its %s as a provisional diff", (_input, deltas) => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(assistantEvent([
      { type: "tool_use", id: "tc-edit", name: "edit", input: {} },
    ]));

    for (const delta of deltas) parser.dispatch(toolInputDeltaEvent("tc-edit", delta));

    expect(projector.snapshot().streamingToolText["tc-edit"]).toMatchObject({
      proposedDiff: {
        files: [{ path: "test.ts", action: "update", hunks: [{ lines: [
          expect.objectContaining({ kind: "remove", text: "a" }),
          expect.objectContaining({ kind: "add", text: "b" }),
        ] }] }],
      },
    });
  });

  test("interruption retains visible proposals", () => {
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

// ---------------------------------------------------------------------------
// StreamingToolInputs: rows derived from each delta
// ---------------------------------------------------------------------------
describe("StreamingToolInputs row derivation", () => {
  type StreamedRow = NonNullable<Extract<StreamingInputUpdate, { kind: "decoded" }>["row"]>;

  /** Streams a call's JSON input `deltaLength` characters at a time and
   *  returns the row after each delta that changed a presentation field. */
  function streamRows(name: string, input: { [key: string]: unknown }, deltaLength = 1, cwd = "/workspace"): StreamedRow[] {
    const inputs = new StreamingToolInputs(cwd);
    inputs.start("call", name);
    const json = JSON.stringify(input);
    const rows: StreamedRow[] = [];
    for (let at = 0; at < json.length; at += deltaLength) {
      const update = inputs.append("call", json.slice(at, at + deltaLength));
      if (update?.kind === "decoded" && update.row) rows.push(update.row);
    }
    return rows;
  }

  interface MeteredSpy {
    readonly mock: { readonly calls: readonly (readonly unknown[])[]; readonly contexts: readonly unknown[] };
    mockClear(): void;
    mockRestore(): void;
  }

  /** Far below what one delta reads when it reads the input streamed before it. */
  const DELTA_READ_BOUND = 500;

  interface DeltaReads {
    readonly most: number;
    readonly rows: StreamedRow[];
  }

  /** A call whose input streams: each delta answers the call's row after it. */
  interface DeltaStream {
    readonly append: (delta: string) => StreamedRow | undefined;
  }

  /** Streams a call's input into a transcript. */
  function projectorStream(name: string): DeltaStream {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      message: { content: [{ type: "tool_use", id: "call", name, input: {} }] },
    }));
    return {
      append: (delta) => {
        parser.dispatch(createRuntimeEvent("tool.input.delta", { type: "tool.input.delta", tool_use_id: "call", partial_json: delta }));
        const block = projector.getBlocks().find((candidate) => candidate.kind === "tool");
        return block?.kind === "tool" && block.sentence ? { presentation: block.presentation, sentence: block.sentence } : undefined;
      },
    };
  }

  /** Streams a call's input through `StreamingToolInputs` alone. */
  function decoderStream(name: string): DeltaStream {
    const inputs = new StreamingToolInputs("/workspace");
    inputs.start("call", name);
    return {
      append: (delta) => {
        const update = inputs.append("call", delta);
        return update?.kind === "decoded" ? update.row : undefined;
      },
    };
  }

  /** Meters the characters that string and regular-expression reads touch:
   *  one per character read, and the searched text for a call that scans a
   *  string. Returns the most that one delta read while `name` streamed
   *  `input` one character per delta, and the rows. A delta that reads the
   *  input streamed before it reads more with each delta. */
  function mostReadByOneDelta(name: string, input: { [key: string]: unknown }, through: "decoder" | "transcript" = "decoder"): DeltaReads {
    const length = (value: unknown): number => typeof value === "string" ? value.length : 0;
    const offset = (value: unknown, size: number): number => {
      const at = typeof value === "number" ? value : 0;
      return at < 0 ? Math.max(0, size + at) : Math.min(at, size);
    };
    const meters: { readonly spy: MeteredSpy; readonly cost: (self: unknown, args: readonly unknown[]) => number }[] = [
      { spy: spyOn(String.prototype, "charAt"), cost: () => 1 },
      { spy: spyOn(String.prototype, "charCodeAt"), cost: () => 1 },
      // A slice shares the characters of the string it cuts, so it reads none.
      { spy: spyOn(String.prototype, "slice"), cost: () => 1 },
      { spy: spyOn(String.prototype, "indexOf"), cost: (self, [, from]) => length(self) - offset(from, length(self)) },
      ...(["replace", "replaceAll", "trim", "trimEnd", "search", "split", "match", "matchAll", "includes", "startsWith", "endsWith"] as const)
        .map((key) => ({ spy: spyOn(String.prototype, key), cost: (self: unknown) => length(self) })),
      { spy: spyOn(RegExp.prototype, "exec"), cost: (_self, [text]) => length(text) },
      { spy: spyOn(RegExp.prototype, "test"), cost: (_self, [text]) => length(text) },
    ];
    const read = (): number => {
      let total = 0;
      for (const { spy, cost } of meters) {
        for (const [call, args] of spy.mock.calls.entries()) total += cost(spy.mock.contexts[call], args);
        spy.mockClear();
      }
      return total;
    };
    const stream = through === "decoder" ? decoderStream(name) : projectorStream(name);
    const rows: StreamedRow[] = [];
    let most = 0;
    try {
      for (const char of JSON.stringify(input)) {
        read();
        const row = stream.append(char);
        most = Math.max(most, read());
        // A delta that read too much already fails the bound; stop before the rest reads ever more.
        if (most >= DELTA_READ_BOUND) break;
        if (row) rows.push(row);
      }
    } finally {
      for (const { spy } of meters) spy.mockRestore();
    }
    return { most, rows };
  }

  test("a bash command streamed one character per delta shows each prefix as its visible command after each delta", () => {
    const command = 'rg -n "TODO" src | head -n 5 && git status --short';
    const rows = streamRows("bash", { command });
    expect(rows.slice(0, command.length).map((row) => row.presentation.detail)).toEqual([...command].map((_, index) => command.slice(0, index + 1).trimEnd()));
    expect(rows.every((row) => row.presentation.name === "Bash")).toBe(true);
  });

  test.each([
    ["a heredoc", { command: "cat > /workspace/notes.md <<'EOF'\n# Notes\nrun ./build.sh; rg TODO\nEOF\nwc -l notes.md" }],
    ["a multi-line script with cd", { command: "cd /workspace/web\n./build.sh --fast\ncat /workspace/web/out.txt | head -n 3\n" }],
    ["a pipeline", { command: "rg --files src | xargs wc -l | sort -n" }],
    ["control characters", { command: "\u001b[31mecho\u001b[0m ‎hi\r\n\u0007ls\u2028 src\t\t" }],
    ["a declared mutation", { mutates: true, command: "sed -i s/a/b/ /workspace/f.txt && ./fix.sh" }],
    ["an escape string open across a script's start", { command: "printf '\u001b]0;';./a.sh x\u0007; ls" }],
    ["scripts in and after a substitution", { command: "echo $(./x.sh) ./y.sh; ./z.sh" }],
  ])("after the last delta, a streamed bash row with %s equals the settled row", (_case, input) => {
    for (const deltaLength of [1, 3, 64]) {
      expect(streamRows("bash", input, deltaLength).at(-1)).toEqual(resolveToolRowPresentation("bash", input, "/workspace"));
    }
  });

  test.each([
    ["a V4A patch", { input: "*** Begin Patch\n*** Update File: /workspace/src/a.ts\n@@ function a()\n-old\n+new\n*** Add File: src/b.ts\n+b\n*** End Patch" }],
    ["one file", { input: "*** Begin Patch\r\n*** Update File: src/a.ts  \r\n+x\r\n*** End Patch" }],
    ["a hashline section", { input: "@@ src/old.ts\n+x" }],
    ["an explicit path", { path: "/workspace/src/c.ts", old_string: "a", new_string: "b" }],
  ])("after the last delta, a streamed edit row with %s equals the settled row", (_case, input) => {
    for (const deltaLength of [1, 5]) {
      expect(streamRows("edit", input, deltaLength).at(-1)).toEqual(resolveToolRowPresentation("edit", input, "/workspace"));
    }
  });

  test("a streamed bash sentence changes only when a command is read, and a heredoc body never shows in it", () => {
    const command = `cat > notes.md <<'EOF'\n${Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n")}\nEOF\nrg TODO src`;
    const sentences = streamRows("bash", { command }).map((row) => row.sentence)
      .filter((sentence, index, all) => index === 0 || JSON.stringify(sentence) !== JSON.stringify(all[index - 1]));
    expect(sentences).toEqual([
      { name: "Ran", detail: "" },
      { name: "Wrote", detail: "notes.md" },
      { name: "Wrote", detail: "notes.md; Searched TODO in src" },
    ]);
  });

  test("over a 2,000-line heredoc streamed one character per delta, no delta reads the command streamed before it, in the decoder or the transcript row, and each command completes once", () => {
    const body = Array.from({ length: 2000 }, (_, line) => `line ${line} ${"x".repeat(30)}`).join("\n");
    const command = `cat > out.txt <<'EOF'\n${body}\nEOF\n./publish.sh out.txt`;
    expect(command.length).toBeGreaterThan(80_000);
    for (const through of ["decoder", "transcript"] as const) {
      const { most, rows } = mostReadByOneDelta("bash", { command }, through);
      // One delta that read the command streamed before it would read tens of thousands.
      expect(most).toBeLessThan(DELTA_READ_BOUND);
      expect(rows.at(-1)).toEqual(resolveToolRowPresentation("bash", { command }, "/workspace"));
    }

    const scanner = new ShellScanner();
    const completed = [...command].flatMap((char) => scanner.advance(char).complete);
    completed.push(...scanner.finish().complete);
    expect(completed).toEqual([...parseShell(command)]);
  });

  // The transcript adds the row's own work to the decoder's, so a patch far
  // longer than the bound proves it there at a quarter of the metered time.
  test.each([
    ["200 KB", "decoder", 2000],
    ["50 KB", "transcript", 500],
  ] as const)("over a %s V4A patch streamed one character per delta, no delta reads the patch streamed before it, through the %s", (_size, through, lineCount) => {
    const lines = Array.from({ length: lineCount }, (_, line) => `+${String(line).padEnd(99, "z")}`);
    const input = `*** Begin Patch\n*** Update File: src/a.ts\n${lines.join("\n")}\n*** End Patch`;
    expect(input.length).toBeGreaterThan(lineCount * 100);
    const { most, rows } = mostReadByOneDelta("edit", { input }, through);
    expect(most).toBeLessThan(DELTA_READ_BOUND);
    expect(rows.at(-1)).toEqual({ presentation: { name: "Edit", detail: "src/a.ts" }, sentence: { name: "Edited", detail: "a.ts" } });
  });
});
