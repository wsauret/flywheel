import { describe, expect, test } from "bun:test";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper";

function setup() {
  const output = new OutputProjector({ executionCwd: "/workspace" });
  return { output, runtime: new RuntimeEventProjector(output) };
}

describe("abandoned tool input", () => {
  test.each(["workflow", "subagent", "read", "apply_patch"])("retry silently removes an unfinished %s preview", (name) => {
    const { output, runtime } = setup();
    output.apply({ type: "tool-use", toolUseId: "abandoned", name, input: {}, timestamp: 1000 });
    runtime.dispatch({ type: "model.stream.abandoned", data: { reason: "retry" } }, 2000);
    expect(output.getBlocks()).toEqual([]);
    output.apply({ type: "end-turn", timestamp: 201000, finalStatus: "completed" });
    expect(output.getBlocks()).toEqual([]);
    output.apply({ type: "tool-use", toolUseId: "replacement", name, input: {}, timestamp: 202000 });
    expect(output.getBlocks().at(-1)).toMatchObject({ status: name === "workflow" ? "pending" : "streaming" });
  });

  test("retry does not settle dispatched workflow or another child's incomplete input", () => {
    const { output, runtime } = setup();
    output.apply({ type: "tool-use", toolUseId: "live", name: "workflow", input: {}, timestamp: 1000 });
    output.apply({ type: "tool-input-complete", toolUseId: "live", name: "workflow", input: { summary: "Live workflow" }, timestamp: 1001 });
    output.apply({ type: "agent-dispatched", toolUseId: "live", timestamp: 1002 });
    output.apply({ type: "tool-use", toolUseId: "child-preview", parentToolUseId: "live", name: "read", input: {}, timestamp: 1003 });
    output.apply({ type: "tool-use", toolUseId: "abandoned", name: "workflow", input: {}, timestamp: 1004 });
    runtime.dispatch({ type: "model.stream.abandoned", data: { reason: "retry" } }, 2000);
    const live = output.getBlocks().find(block => block.kind === "agentGroup" && block.toolUseId === "live");
    expect(live).toMatchObject({ status: "active", children: [{ status: "streaming" }] });
    expect(output.getBlocks()).toHaveLength(1);
  });

  test.each(["failed", "interrupted"] as const)("stream %s settles only the affected child and writes no tool result", (reason) => {
    const { output, runtime } = setup();
    output.apply({ type: "tool-use", toolUseId: "live", name: "subagent", input: { description: "Live child" }, timestamp: 1000 });
    output.apply({ type: "agent-dispatched", toolUseId: "live", timestamp: 1001 });
    output.apply({ type: "tool-use", toolUseId: "child-preview", parentToolUseId: "live", name: "read", input: {}, timestamp: 1002 });
    output.apply({ type: "tool-use", toolUseId: "root-preview", name: "workflow", input: {}, timestamp: 1003 });
    const event = { type: "model.stream.abandoned", data: { reason, parent_tool_use_id: "live" } } as const;
    runtime.dispatch(event, 2000);
    expect(mapRuntimeEventToSessionRuntimeFacts(event)).toEqual([]);
    expect(output.getBlocks()[0]).toMatchObject({ status: "active", children: [{ status: reason === "failed" ? "error" : "interrupted" }] });
    expect(output.getBlocks().at(-1)).toMatchObject({ status: "pending" });
  });

  test.each([
    ["failed", "workflow"], ["failed", "read"], ["interrupted", "workflow"], ["interrupted", "read"],
  ] as const)("stream %s removes an unfinished top-level %s preview, which no persisted part claims", (reason, name) => {
    const { output, runtime } = setup();
    output.apply({ type: "tool-use", toolUseId: "unfinished", name, input: {}, timestamp: 1000 });
    runtime.dispatch({ type: "model.stream.abandoned", data: { reason } }, 2000);
    expect(output.getBlocks()).toEqual([]);
    output.apply({ type: "end-turn", timestamp: 3000, finalStatus: reason === "failed" ? "completed" : "paused" });
    expect(output.getBlocks()).toEqual([]);
  });
});
