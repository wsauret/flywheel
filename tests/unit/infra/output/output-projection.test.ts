import { describe, expect, it } from "bun:test";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import type { ToolEntry } from "../../../../src/infra/output-blocks";
import { buildMutationDiffEvidence, buildMutationDiffEntries } from "../../../../src/infra/mutation-diff-evidence";
import { buildMutationEvidence, readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence";
import { readSessionContentRange } from "../../../../src/infra/session-content";
import { sessionContentFixture } from "../../../helpers/session-content";

function firstTool(blocks: ReturnType<OutputProjector["getBlocks"]>): ToolEntry {
  const tool = blocks.find((block) => block.kind === "tool");
  if (!tool) throw new Error("No tool row found");
  return tool;
}

function firstToolRow(blocks: ReturnType<OutputProjector["getBlocks"]>): ToolEntry {
  for (const block of blocks) {
    if (block.kind === "tool") return block;
    if (block.kind === "agentGroup") {
      const child = block.children.find((item) => item.kind === "tool");
      if (child) return child;
    }
  }
  throw new Error("No tool row found");
}

// The projector resolves against this directory, so it is canonical for the
// running platform and the expected URI is derived from it.
const OUTPUT_CWD = resolve("/scratch/flywheel-output-cwd");

describe("OutputProjector", () => {
  it("complete-text exits generating without sealing grouping", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "push-text", text: "hello", timestamp: 1, blockKey: "main" });
    expect(projector.streamPhase).toBe("generating");
    projector.apply({ type: "complete-text", timestamp: 2, blockKey: "other" });

    expect(projector.streamPhase).toBeNull();
    projector.apply({ type: "push-text", text: " world", timestamp: 3, blockKey: "main" });

    const block = projector.getBlocks()[0];
    expect(block?.kind).toBe("text");
    if (block?.kind === "text") expect(block.content).toBe("hello world");
  });

  it("updates thinking content and streamPhase through the projection state", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "set-model-phase", phase: "thinking", timestamp: 1 });
    projector.apply({ type: "push-thinking", text: "reasoning", timestamp: 2, blockKey: "thinking" });
    expect(projector.streamPhase).toBe("thinking");

    // complete-thinking exits the "thinking" phase to null (UI coalesces
    // to "Idle") — the block stays in the projection, but the phase
    // doesn't linger past the block boundary.
    projector.apply({ type: "complete-thinking", timestamp: 3 });
    expect(projector.streamPhase).toBeNull();

    const block = projector.getBlocks()[0];
    expect(block?.kind).toBe("thinking");
    if (block?.kind === "thinking") {
      expect(block.content).toBe("reasoning");
      expect(block.status).toBe("completed");
      expect(block.completedAt).toBe(3);
    }

    projector.apply({ type: "set-model-phase", phase: "waiting", timestamp: 4 });
    expect(projector.streamPhase).toBe("waiting");

    projector.apply({ type: "begin-turn" });
    expect(projector.streamPhase).toBeNull();
  });

  it("stamps thinking after a tool-only response at the start of its own model call", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "begin-turn" });
    projector.apply({ type: "set-model-phase", phase: "waiting", timestamp: 1_000 });
    projector.apply({ type: "tool-use", toolUseId: "t1", name: "bash", input: {}, timestamp: 1_500 });
    projector.apply({ type: "tool-input-complete", toolUseId: "t1", name: "bash", input: { command: "ls" }, timestamp: 2_000 });
    projector.apply({ type: "tool-result", toolUseId: "t1", outcome: "ok", content: [{ type: "text", text: "ok" }], timestamp: 60_000 });
    projector.apply({ type: "set-model-phase", phase: "waiting", timestamp: 61_000 });
    projector.apply({ type: "push-thinking", text: "plan", timestamp: 61_500, blockKey: "r2:0" });
    projector.apply({ type: "complete-thinking", timestamp: 63_000 });

    const thinking = projector.getBlocks().find((block) => block.kind === "thinking");
    expect(thinking?.kind === "thinking" ? [thinking.timestamp, thinking.completedAt] : null).toEqual([61_000, 63_000]);
  });

  it("materializes streaming tool input into the same preview shape as completed input", () => {
    const streamed = new OutputProjector({ executionCwd: "/workspace" });
    streamed.apply({ type: "tool-use", toolUseId: "write-1", name: "write", input: {}, timestamp: 1 });
    streamed.apply({
      type: "tool-input-delta",
      toolUseId: "write-1",
      partialJson: '{"path":"src/example.ts","content":"const value = 1;"',
    });
    streamed.apply({
      type: "tool-input-complete",
      toolUseId: "write-1",
      name: "write",
      input: { path: "src/example.ts", content: "const value = 1;" },
      timestamp: 2,
    });

    const completed = new OutputProjector({ executionCwd: "/workspace" });
    completed.apply({ type: "tool-use", toolUseId: "write-2", name: "write", input: {}, timestamp: 1 });
    completed.apply({
      type: "tool-input-complete",
      toolUseId: "write-2",
      name: "write",
      input: { path: "src/example.ts", content: "const value = 1;" },
      timestamp: 2,
    });

    const streamedTool = firstTool(streamed.getBlocks());
    const completedTool = firstTool(completed.getBlocks());
    expect({
      name: streamedTool.name,
      presentation: streamedTool.presentation,
      linkUri: streamedTool.linkUri,
      content: streamedTool.content,
      filetype: streamedTool.filetype,
      status: streamedTool.status,
    }).toEqual({
      name: completedTool.name,
      presentation: completedTool.presentation,
      linkUri: completedTool.linkUri,
      content: completedTool.content,
      filetype: completedTool.filetype,
      status: completedTool.status,
    });
  });

  it("places one neutral row at input start and refines the same identity", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "search-1", name: "search", input: {}, timestamp: 1 });

    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks())).toMatchObject({
      id: "search-1",
      presentation: { name: "Search", detail: "" },
      status: "streaming",
    });

    projector.apply({ type: "tool-input-delta", toolUseId: "search-1", partialJson: '{"pattern":"needle"' });
    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks())).toMatchObject({
      id: "search-1",
      presentation: { name: "Search", detail: '"needle"' },
      status: "streaming",
    });
  });

  it("updates one Bash row while its command string streams and reconciles authoritative input", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: {}, timestamp: 1 });

    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks())).toMatchObject({
      id: "bash-1",
      presentation: { name: "Bash", detail: "" },
      status: "streaming",
    });

    projector.apply({ type: "tool-input-delta", toolUseId: "bash-1", partialJson: '{"command":"printf' });
    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf");

    projector.apply({ type: "tool-input-delta", toolUseId: "bash-1", partialJson: " first" });
    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf first");

    projector.apply({ type: "tool-input-delta", toolUseId: "bash-1", partialJson: '"}' });
    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf first");

    projector.apply({
      type: "tool-input-complete",
      toolUseId: "bash-1",
      name: "bash",
      input: { command: "printf authoritative" },
      timestamp: 2,
    });
    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks())).toMatchObject({
      id: "bash-1",
      presentation: { name: "Bash", detail: "printf authoritative" },
      status: "pending",
    });
  });

  it("clears a rejected partial command and accepts authoritative completion", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "bash-invalid", name: "bash", input: {}, timestamp: 1 });
    projector.apply({ type: "tool-input-delta", toolUseId: "bash-invalid", partialJson: '{"command":"printf' });
    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf");

    projector.apply({ type: "tool-input-delta", toolUseId: "bash-invalid", partialJson: "\\q" });
    expect(projector.getBlocks()).toHaveLength(1);
    expect(firstTool(projector.getBlocks())).toMatchObject({
      id: "bash-invalid",
      presentation: { name: "Bash", detail: "" },
      status: "streaming",
    });

    projector.apply({
      type: "tool-input-complete",
      toolUseId: "bash-invalid",
      name: "bash",
      input: { command: "printf complete" },
      timestamp: 2,
    });
    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf complete");
  });

  it("decodes a split newline escape in a streaming multiline Bash command", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "bash-multiline", name: "bash", input: {}, timestamp: 1 });
    projector.apply({ type: "tool-input-delta", toolUseId: "bash-multiline", partialJson: '{"command":"printf first\\' });
    projector.apply({ type: "tool-input-delta", toolUseId: "bash-multiline", partialJson: 'nsecond"' });

    expect(firstTool(projector.getBlocks()).presentation.detail).toBe("printf first second");
  });

  it("projects handoff input as expandable JSON content", () => {
    const projector = new OutputProjector({ executionCwd: OUTPUT_CWD });
    projector.apply({
      type: "tool-use",
      toolUseId: "handoff-1",
      name: "handoff",
      input: {
        summary: "done",
        artifacts: { changed: ["src/app.ts"] },
      },
      timestamp: 1,
    });
    projector.apply({ type: "tool-result", toolUseId: "handoff-1", outcome: "ok", timestamp: 2 });

    const tool = firstTool(projector.getBlocks());
    expect(tool.status).toBe("completed");
    // The row reads the summary that the step handed off.
    expect(tool.presentation.detail).toBe("done");
    expect(tool.filetype).toBe("json");
    expect(tool.content).toBe(JSON.stringify({
      summary: "done",
      artifacts: { changed: ["src/app.ts"] },
    }, null, 2));
  });

  it("applies authoritative result metadata after a provisional conversation result", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({
      type: "tool-use",
      toolUseId: "skill-1",
      name: "skill_manage",
      input: { action: "save", name: "example" },
      timestamp: 1,
    });
    projector.apply({ type: "tool-result", toolUseId: "skill-1", outcome: "ok", source: "conversation", timestamp: 2 });
    expect(firstTool(projector.getBlocks()).status).toBe("completed");
    expect(firstTool(projector.getBlocks()).resultAction).toBeUndefined();

    projector.apply({
      type: "tool-result",
      toolUseId: "skill-1",
      outcome: "ok",
      source: "render",
      details: { resultAction: "created" },
      timestamp: 3,
    });
    expect(firstTool(projector.getBlocks())).toMatchObject({ status: "completed", resultAction: "created" });
  });

  it("resolves relative tool links against the configured execution directory", () => {
    const projector = new OutputProjector({ executionCwd: OUTPUT_CWD });

    projector.apply({
      type: "tool-use",
      toolUseId: "read-1",
      name: "read",
      input: { path: "src/math.ts" },
      timestamp: 1,
    });

    const tool = firstToolRow(projector.getBlocks());
    expect(tool.presentation.detail).toBe("src/math.ts");
    expect(tool.linkUri).toBe(pathToFileURL(join(OUTPUT_CWD, "src", "math.ts")).href);
  });

  it("closes the correct in-flight tool block by toolUseId", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "tool-use", toolUseId: "edit-1", name: "edit", input: { path: "a.ts", old_string: "a", new_string: "b" }, timestamp: 1 });
    projector.apply({ type: "tool-use", toolUseId: "edit-2", name: "edit", input: { path: "b.ts", old_string: "b", new_string: "c" }, timestamp: 2 });
    projector.apply({ type: "tool-result", toolUseId: "edit-2", outcome: "ok", content: [{ type: "text", text: "ok" }], timestamp: 3 });

    const tools = projector.getBlocks().filter((block): block is ToolEntry => block.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.status).toBe("pending");
    expect(tools[1]?.status).toBe("completed");
  });

  it("settles only the matching completed bash row from durable execution output", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: { command: "one" }, timestamp: 1 });
    projector.apply({ type: "tool-use", toolUseId: "bash-2", name: "bash", input: { command: "two" }, timestamp: 2 });
    const runtime = new RuntimeEventProjector(projector);
    runtime.dispatch({
      type: "tool.execution_output.recorded",
      data: { tool_use_id: "bash-1", output: "tail one" },
    } satisfies RuntimeEvent);
    projector.apply({ type: "tool-result", toolUseId: "bash-1", outcome: "ok", content: [{ type: "text", text: "compressed one" }], timestamp: 3 });
    projector.apply({ type: "tool-result", toolUseId: "bash-2", outcome: "ok", content: [{ type: "text", text: "compressed two" }], timestamp: 4 });
    runtime.dispatch({
      type: "tool.execution_output.recorded",
      data: { tool_use_id: "bash-2", output: "tail two" },
    } satisfies RuntimeEvent);

    const tools = projector.getBlocks().filter((block): block is ToolEntry => block.kind === "tool");
    expect(tools.map((tool) => tool.content)).toEqual(["tail one", "tail two"]);
  });

  it("stamps a background command's row with when the command ended, and nothing while it runs", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const runtime = new RuntimeEventProjector(projector);
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: { command: "sleep 45", run_in_background: true }, timestamp: 1000 });
    projector.apply({ type: "tool-result", toolUseId: "bash-1", outcome: "ok", content: [{ type: "text", text: "started" }], details: { background: true }, timestamp: 1865 });
    const record = { toolUseId: "bash-1", processId: "proc-1", description: "sleep 45", startedAtMs: 1010 };
    runtime.dispatch({ type: "tool.background_command.recorded", data: { ...record, state: "running" } } satisfies RuntimeEvent);
    expect(firstToolRow(projector.getBlocks()).endedAt).toBeUndefined();
    runtime.dispatch({ type: "tool.background_command.recorded", data: { ...record, state: "settled", status: "completed", exitCode: 0, settledAtMs: 46_600 } } satisfies RuntimeEvent);
    expect(firstToolRow(projector.getBlocks())).toMatchObject({ status: "completed", endedAt: 46_600 });
  });

  it("joins a settled mutation command's mutation, conflict markers, and refused changes onto its row, whether it settles before or after the result", async () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const runtime = new RuntimeEventProjector(projector);
    const { stage, read } = sessionContentFixture();
    const mutation = (path: string) => ({ version: 1 as const, files: [{ path, change: "modified" as const, unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n` }], omissions: [] });
    const first = await buildMutationDiffEntries(mutation("a.ts"), "bash-1", stage);
    const conflict = await buildMutationDiffEntries(mutation("c.ts"), "bash-1", stage);
    const firstEvidence = await buildMutationEvidence([...first, ...conflict.map(entry => entry.kind === "display" ? { ...entry, file: { ...entry.file, conflictMarkers: true } } : entry)], stage);
    const secondEvidence = await buildMutationEvidence([
      ...await buildMutationDiffEntries(mutation("/workspace/b.ts"), "bash-2", stage),
      { kind: "not_applied", path: "d.bin", reason: "binary files are not merged" },
    ], stage);
    const background = { background: true, releaseReason: "runtime_cap", durationMs: 1 };
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: { command: "one", mutates: true }, timestamp: 1 });
    projector.apply({ type: "tool-use", toolUseId: "bash-2", name: "bash", input: { command: "two", mutates: true }, timestamp: 2 });
    runtime.dispatch({ type: "tool.execution_output.recorded", data: { tool_use_id: "bash-1", output: "tail one", mutationEvidence: firstEvidence } } satisfies RuntimeEvent);
    projector.apply({ type: "tool-result", toolUseId: "bash-1", outcome: "ok", content: [{ type: "text", text: "moved" }], details: background, timestamp: 3 });
    projector.apply({ type: "tool-result", toolUseId: "bash-2", outcome: "ok", content: [{ type: "text", text: "moved" }], details: background, timestamp: 4 });
    runtime.dispatch({ type: "tool.execution_output.recorded", data: { tool_use_id: "bash-2", output: "", mutationEvidence: secondEvidence } } satisfies RuntimeEvent);

    const tools = projector.getBlocks().filter((block): block is ToolEntry => block.kind === "tool");
    expect(tools[0]?.mutationEvidence).toEqual(firstEvidence);
    expect(tools[1]?.mutationEvidence).toEqual({
      ...secondEvidence, samples: [
        { kind: "applied", path: "b.ts" },
        { kind: "not_applied", path: "d.bin", reason: "binary files are not merged" },
      ],
    });
    const pages = await Promise.all(tools.map(tool => readMutationEvidenceFiles(tool.mutationEvidence!, 0, 10, read)));
    expect(pages[0]).toMatchObject({ kind: "available", nextOffset: null, files: [
      { kind: "display", file: { path: "a.ts", conflictMarkers: false } },
      { kind: "display", file: { path: "c.ts", conflictMarkers: true } },
    ] });
    expect(pages[1]).toMatchObject({ kind: "available", nextOffset: null, files: [
      { kind: "display", file: { path: "/workspace/b.ts" } },
      { kind: "not_applied", path: "d.bin", reason: "binary files are not merged" },
    ] });
    expect(tools[1]?.presentation.detail).toBe("two");
  });

  it("streams a command's live tail through its hold and its background run, then settles it into the row", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const runtime = new RuntimeEventProjector(projector);
    const live = (output: string) => runtime.dispatch({ type: "tool.execution_output.delta", data: { tool_use_id: "bash-1", output } } satisfies RuntimeEvent);
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: { command: "make test" }, timestamp: 1 });
    live("tick 1\n");
    expect(projector.snapshot().streamingToolText["bash-1"]).toEqual({ content: "tick 1\n" });
    // The call yields to the background: its row settles and its tail keeps streaming.
    projector.apply({ type: "tool-result", toolUseId: "bash-1", outcome: "ok", content: [{ type: "text", text: "moved to the background" }], details: { background: true, releaseReason: "runtime_cap", durationMs: 1 }, timestamp: 2 });
    live("tick 1\ntick 2\n");
    expect(projector.snapshot().streamingToolText["bash-1"]).toEqual({ content: "tick 1\ntick 2\n" });
    runtime.dispatch({ type: "tool.execution_output.recorded", data: { tool_use_id: "bash-1", output: "tick 1\ntick 2\ntick 3\n" } } satisfies RuntimeEvent);
    expect(firstTool(projector.getBlocks()).content).toBe("tick 1\ntick 2\ntick 3\n");
    expect(projector.snapshot().streamingToolText["bash-1"]).toBeUndefined();
  });

  it("lands late execution output on the settled bash row after a retraction shifts block indices", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "push-text", text: "draft", timestamp: 1, blockKey: "draft-1" });
    projector.apply({ type: "tool-use", toolUseId: "bash-1", name: "bash", input: { command: "one" }, timestamp: 2 });
    projector.apply({ type: "tool-result", toolUseId: "bash-1", outcome: "ok", content: [{ type: "text", text: "compressed" }], timestamp: 3 });
    projector.apply({ type: "retract-draft", blockKeys: ["draft-1"], timestamp: 4 });
    new RuntimeEventProjector(projector).dispatch({
      type: "tool.execution_output.recorded",
      data: { tool_use_id: "bash-1", output: "tail one" },
    } satisfies RuntimeEvent);

    const tools = projector.getBlocks().filter((block): block is ToolEntry => block.kind === "tool");
    expect(tools.map((tool) => [tool.status, tool.content])).toEqual([["completed", "tail one"]]);
  });

  it("projects the mutation row from the persisted result details", async () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const { stage, read } = sessionContentFixture();
    const patch = "--- USER.md\n+++ USER.md\n@@ -0,0 +1 @@\n+Exact global patch";
    const mutationEvidence = await buildMutationDiffEvidence({ version: 1, files: [{ path: "USER.md", change: "added", unifiedDiff: patch }], omissions: [] }, "memory-global", stage);
    projector.apply({ type: "tool-use", toolUseId: "memory-global", name: "memory", input: { action: "add", target: "global", title: "Save preference" }, timestamp: 1 });
    new RuntimeEventProjector(projector).dispatch({
      type: "tool.result.recorded",
      data: {
        tool_use_id: "memory-global",
        outcome: "ok",
        content: [{ type: "text", text: "saved" }],
        details: { mutationEvidence },
      },
    } satisfies RuntimeEvent);

    const page = await readMutationEvidenceFiles(firstTool(projector.getBlocks()).mutationEvidence!, 0, 10, read);
    if (page.kind !== "available") throw new Error("expected mutation files");
    expect(page.nextOffset).toBeNull();
    const file = page.files[0];
    if (file?.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch");
    const range = await readSessionContentRange(file.file.patch.reference, 0, 4096, read);
    if (range.kind !== "available") throw new Error("expected patch bytes");
    expect(Buffer.from(range.base64, "base64").toString()).toBe(patch);
  });

  it("projects a canonical multi-file mutation as one tool row", async () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const { stage, read } = sessionContentFixture();
    const mutationEvidence = await buildMutationDiffEvidence({
      version: 1, files: [
        { path: "a.ts", change: "modified", unifiedDiff: "-old a\n+new a" },
        { path: "b.ts", change: "modified", unifiedDiff: "-old b\n+new b" },
      ], omissions: [],
    }, "replace-many", stage);
    projector.apply({ type: "tool-use", toolUseId: "replace-many", name: "replace", input: { files: ["a.ts", "b.ts"], old: "old", new: "new" }, timestamp: 1 });
    new RuntimeEventProjector(projector).dispatch({
      type: "tool.result.recorded",
      data: {
        tool_use_id: "replace-many",
        outcome: "ok",
        content: [{ type: "text", text: "updated" }],
        details: {
          files: [
            { path: "a.ts", diff: "-old a\n+new a", filetype: "typescript" },
            { path: "b.ts", diff: "-old b\n+new b", filetype: "typescript" },
          ],
          mutationEvidence,
        },
      },
    } satisfies RuntimeEvent);

    const tools = projector.getBlocks().filter((block): block is ToolEntry => block.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.diff).toBeUndefined();
    const page = await readMutationEvidenceFiles(tools[0]!.mutationEvidence!, 0, 10, read);
    if (page.kind !== "available") throw new Error("expected mutation files");
    expect(page.files.map(entry => entry.kind === "display" ? entry.file.path : undefined)).toEqual(["a.ts", "b.ts"]);
    expect(page.nextOffset).toBeNull();
  });

  it("projects large streams in one pass without raw history in state or repeated dirty notifications", () => {
    let changeCount = 0;
    const projector = new OutputProjector({ executionCwd: "/workspace", onChange: () => { changeCount += 1 } });
    const eventCount = 10_000;

    for (let i = 0; i < eventCount; i += 1) {
      projector.apply({ type: "push-text", text: "x", timestamp: i, blockKey: "main" });
    }

    const snapshot = projector.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["outputBlocks", "streamPhase", "streamingOutputChars", "streamingToolText", "visibleMessageCountSuffix"]);
    expect(snapshot.outputBlocks).toHaveLength(1);
    expect(snapshot.outputBlocks[0]?.kind).toBe("text");
    if (snapshot.outputBlocks[0]?.kind === "text") expect(snapshot.outputBlocks[0].content).toHaveLength(eventCount);
    expect(changeCount).toBe(1);
  });

  it("coalesces changes until a snapshot is read, then reports the next dirty period", () => {
    let changeCount = 0;
    const projector = new OutputProjector({ executionCwd: "/workspace", onChange: () => { changeCount += 1 } });

    projector.apply({ type: "push-text", text: "a", timestamp: 1, blockKey: "main" });
    projector.apply({ type: "push-text", text: "b", timestamp: 2, blockKey: "main" });
    expect(changeCount).toBe(1);

    expect(projector.getBlocks()).toHaveLength(1);
    projector.apply({ type: "push-system-message", message: "done", timestamp: 3 });
    expect(changeCount).toBe(2);
  });

  it("pauses orphan subagent blocks on interrupt and drops the 'Initializing…' placeholder", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    // Parent starts streaming a subagent tool_use; description streams in
    // before tool-input-complete, so the agent block materializes early.
    projector.apply({ type: "tool-use", toolUseId: "sub-1", name: "subagent", input: {}, timestamp: 1 });
    projector.apply({ type: "tool-input-delta", toolUseId: "sub-1", partialJson: '{"kind":"dispatch","persona":"implementer"' });

    // Parent is interrupted before the subagent runner is dispatched. The
    // interrupted status carries the Interrupted label in the renderer, so the
    // placeholder is dropped rather than relabeled (a relabel would render
    // "Interrupted" twice).
    projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "paused" });

    const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
    expect(group).toBeDefined();
    if (group?.kind !== "agentGroup") return;
    expect(group.status).toBe("interrupted");
    expect(group.description).toBe("");
  });

  it("keeps a subagent block active on interrupt if its runner was already dispatched", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "tool-use", toolUseId: "sub-1", name: "subagent", input: { persona: "implementer", description: "do work" }, timestamp: 1 });
    // Runner dispatched — agent-dispatched promotes pending → active.
    projector.apply({ type: "agent-dispatched", toolUseId: "sub-1", timestamp: 1 });
    projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "paused" });

    const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
    expect(group).toBeDefined();
    if (group?.kind !== "agentGroup") return;
    expect(group.status).toBe("active");
    expect(group.description).toBe("do work");
    expect(group.agentType).toBe("implementer");
  });

  it("interrupts a dispatched subagent block on session teardown (queue paused/failed)", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "tool-use", toolUseId: "sub-1", name: "subagent", input: { persona: "implementer", description: "do work" }, timestamp: 1 });
    projector.apply({ type: "agent-dispatched", toolUseId: "sub-1", timestamp: 1 });
    // Teardown: the session's runners are dying; no settle path will reach
    // this projector, so the in-flight block must render interrupted.
    projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "teardown" });

    const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
    expect(group).toBeDefined();
    if (group?.kind !== "agentGroup") return;
    expect(group.status).toBe("interrupted");
  });

  it("a paused child keeps its goal, says who paused it, claims no wall time as its active time, and resumes into an active block", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });

    projector.apply({ type: "tool-use", toolUseId: "sub-1", name: "subagent", input: { persona: "implementer", description: "do work" }, timestamp: 1 });
    projector.apply({ type: "agent-dispatched", toolUseId: "sub-1", timestamp: 1 });
    projector.apply({ type: "agent-paused", toolUseId: "sub-1", timestamp: 2501, pausedBy: "person" });

    const paused = projector.getBlocks().find((b) => b.kind === "agentGroup");
    expect(paused).toMatchObject({ status: "paused", pausedBy: "person", description: "do work" });
    expect(paused).not.toHaveProperty("duration");

    projector.apply({ type: "agent-dispatched", toolUseId: "sub-1", timestamp: 3000 });
    const resumed = projector.getBlocks().find((b) => b.kind === "agentGroup");
    expect(resumed).toMatchObject({ status: "active", description: "do work" });
    expect(resumed && "pausedBy" in resumed).toBe(false);
  });

  describe("agent block lifecycle invariants", () => {
    it("synchronous launch error: tool_result against pending block transitions to error", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "agent-x", name: "subagent", input: { persona: "Worker", description: "do work" }, timestamp: 1 });
      projector.apply({ type: "tool-result", toolUseId: "agent-x", outcome: "error", content: [{ type: "text", text: "launch failed" }], source: "render", timestamp: 2 });
      const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (group?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(group.status).toBe("error");
    });

    it("end-of-turn closes pending agent blocks (completed)", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "agent-x", name: "subagent", input: { persona: "Worker", description: "do work" }, timestamp: 1 });
      projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "completed" });
      const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (group?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(group.status).toBe("completed");
    });

    it("end-of-turn preserves dispatched (active) agent blocks; subsequent tool_result completes them", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "agent-x", name: "subagent", input: { persona: "Worker", description: "do work" }, timestamp: 1 });
      projector.apply({ type: "agent-dispatched", toolUseId: "agent-x", timestamp: 1 });
      projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "completed" });
      let group = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (group?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(group.status).toBe("active");
      projector.apply({ type: "tool-result", toolUseId: "agent-x", outcome: "ok", content: [{ type: "text", text: "done" }], source: "render", timestamp: 3 });
      group = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (group?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(group.status).toBe("completed");
    });

    it("top-level tools stay standalone through end-of-turn", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "t1", name: "Read", input: { path: "x.ts" }, timestamp: 1 });
      projector.apply({ type: "tool-input-complete", toolUseId: "t1", name: "Read", input: { path: "x.ts" }, timestamp: 1 });
      projector.apply({ type: "tool-result", toolUseId: "t1", outcome: "ok", content: [{ type: "text", text: "file contents" }], source: "render", timestamp: 2 });
      const tool = projector.getBlocks()[0];
      expect(tool).toMatchObject({ kind: "tool", name: "read", action: "file_read", status: "completed" });
      projector.apply({ type: "end-turn", timestamp: 3, finalStatus: "completed" });
      expect(projector.getBlocks()[0]).toBe(tool);
    });

    it("stale fail-agent against an interrupted pending block leaves status at interrupted (no resurrection)", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "agent-x", name: "subagent", input: { persona: "Worker", description: "do work" }, timestamp: 1 });
      projector.apply({ type: "end-turn", timestamp: 2, finalStatus: "paused" });
      const interrupted = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (interrupted?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(interrupted.status).toBe("interrupted");
      projector.apply({ type: "fail-agent", agentId: interrupted.id, message: "stale failure" });
      const group = projector.getBlocks().find((b) => b.kind === "agentGroup");
      if (group?.kind !== "agentGroup") { expect.unreachable(); return; }
      expect(group.status).toBe("interrupted");
    });
  });
});

describe("code tool projection", () => {
  it("keeps the script row display-only and materializes nested calls with execute metadata", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "code-1", name: "code", input: { source: "return tools.read({ path: 'a.ts' })" }, timestamp: 1 });
    projector.apply({ type: "tool-use", toolUseId: "nested-1", name: "linear.get_issue", input: { id: "ENG-1", limit: 2, active: true, nested: { omit: true }, list: ["omit"] }, timestamp: 2, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-result", toolUseId: "nested-1", outcome: "ok", content: [{ type: "text", text: "nested result" }], source: "render", timestamp: 3, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-result", toolUseId: "code-1", outcome: "ok", content: [{ type: "text", text: "script return" }], source: "render", timestamp: 4 });
    expect(projector.getBlocks()).toMatchObject([
      { kind: "tool", name: "code", status: "completed" },
      { kind: "tool", name: "linear.get_issue", presentation: { name: "linear.get_issue", detail: "[id=ENG-1, limit=2, active=true]" }, runCategoryOverride: "execute", content: "nested result", status: "completed" },
    ]);
  });

  it("materializes a nested first-class tool with execute metadata instead of its standalone display path", () => {
    // Tools like list/read have standalone handlers; a nested-in-code call
    // must bypass the top-level path so the execute override is preserved.
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "code-1", name: "code", input: { source: "return tools.list({ path: '.' })" }, timestamp: 1 });
    projector.apply({ type: "tool-input-complete", toolUseId: "nested-1", name: "list", input: { path: ".", limit: 3 }, timestamp: 2, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-result", toolUseId: "nested-1", outcome: "ok", content: [{ type: "text", text: "3 entries" }], source: "render", timestamp: 3, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-result", toolUseId: "code-1", outcome: "ok", content: [{ type: "text", text: "{ count: 3 }" }], source: "render", timestamp: 4 });
    expect(projector.getBlocks()).toMatchObject([
      { kind: "tool", name: "code", status: "completed" },
      { kind: "tool", name: "list", presentation: { name: "list", detail: "[path=., limit=3]" }, runCategoryOverride: "execute", content: "3 entries", status: "completed" },
    ]);
  });

  it("recognizes nested calls while the parent code call is still pending", () => {
    // Live streams register the code call as pending (empty input) and settle
    // it only at turn settlement; nested facts arrive in between.
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-use", toolUseId: "code-1", name: "code", input: {}, timestamp: 1 });
    projector.apply({ type: "tool-input-complete", toolUseId: "nested-1", name: "list", input: { path: "." }, timestamp: 2, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-result", toolUseId: "nested-1", outcome: "ok", content: [{ type: "text", text: "3 entries" }], source: "render", timestamp: 3, parentToolUseId: "code-1" });
    projector.apply({ type: "tool-input-complete", toolUseId: "code-1", name: "code", input: { source: "return 1" }, timestamp: 4 });
    projector.apply({ type: "tool-result", toolUseId: "code-1", outcome: "ok", content: [{ type: "text", text: "1" }], source: "render", timestamp: 5 });
    expect(projector.getBlocks()).toMatchObject([
      { kind: "tool", name: "code", status: "completed" },
      { kind: "tool", name: "list", runCategoryOverride: "execute", presentation: { name: "list", detail: "[path=.]" }, content: "3 entries", status: "completed" },
    ]);
  });

  it("honors the translator's nestedInCode stamp before the parent code call is known", () => {
    // The durable-fact fan-out can beat the parent's stream events entirely.
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    projector.apply({ type: "tool-input-complete", toolUseId: "nested-1", name: "list", input: { path: "." }, timestamp: 1, parentToolUseId: "code-1", nestedInCode: true });
    projector.apply({ type: "tool-result", toolUseId: "nested-1", outcome: "ok", content: [{ type: "text", text: "3 entries" }], source: "render", timestamp: 2, parentToolUseId: "code-1" });
    expect(projector.getBlocks()).toMatchObject([
      { kind: "tool", name: "list", runCategoryOverride: "execute", content: "3 entries", status: "completed" },
    ]);
  });
});
