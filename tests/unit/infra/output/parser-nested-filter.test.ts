import { describe, it, expect, beforeEach } from "bun:test";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import { makeAgentDispatchedEvent, makeToolResultEvent } from "./_parser-fixtures";

// Nested (subagent) deltas carry parent_tool_use_id; the projector filters them
// from the parent chat log. Subagent output stays visible only through the
// intentional child-status/subagent-block path, never as parent text/phase.
describe("nested subagent deltas are filtered from the parent chat log", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  function nestedTextDelta(text: string, parentToolUseId: string): RuntimeEvent {
    return {
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "text_delta", text }, block_key: "sub:0", parent_tool_use_id: parentToolUseId },
    };
  }

  it("does not render a nested text delta into the parent block list", () => {
    parser.dispatch(nestedTextDelta("subagent answer", "parent-tool-1"), 1000);
    expect(projector.getBlocks().filter((b) => b.kind === "text")).toHaveLength(0);
  });

  it("does not flip the parent model phase on a nested provider_response_started", () => {
    parser.dispatch({ type: "agent.provider_response.started", data: { parent_tool_use_id: "parent-tool-1" } }, 1000);
    expect(projector.streamPhase).toBeNull();
  });
});

// A subagent dispatched from inside another subagent renders as a single
// child row in the dispatcher's box, never as a top-level agent block; the
// grandchild's interior events are dropped entirely.
describe("nested subagent dispatches render as child rows", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  function toolInputCompleted(id: string, name: string, input: { [key: string]: unknown }, parentToolUseId?: string): RuntimeEvent {
    return {
      type: "tool.input.completed",
      data: {
        type: "tool.input.completed",
        tool_use: { id, name, input },
        ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      },
    };
  }

  function dispatchParentAgent(): void {
    parser.dispatch(toolInputCompleted("parent-tool-1", "subagent", { persona: "explorer", description: "Scout the repo", prompt: "look around" }), 1000);
  }

  function agentGroups() {
    return projector.getBlocks().filter((b) => b.kind === "agentGroup");
  }

  it("renders a nested dispatch as a row in the parent box, not a top-level agent block", () => {
    dispatchParentAgent();
    expect(agentGroups()).toHaveLength(1);

    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "reviewer-code-quality", description: "Review the change", prompt: "review" }, "parent-tool-1"), 2000);

    const groups = agentGroups();
    expect(groups).toHaveLength(1);
    const parent = groups[0];
    if (parent?.kind !== "agentGroup") throw new Error("expected agent group");
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]?.name).toBe("subagent");
    expect(parent.children[0]?.presentation.detail).toContain("Review the change");
  });

  it("drops the nested subagent's interior events instead of leaking them top-level", () => {
    dispatchParentAgent();
    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "explorer", description: "Nested scout", prompt: "go" }, "parent-tool-1"), 2000);

    const before = projector.getBlocks().length;
    parser.dispatch(toolInputCompleted("gc-tool-1", "read", { path: "src/index.ts" }, "nested-1"), 3000);

    expect(projector.getBlocks()).toHaveLength(before);
    const parent = agentGroups()[0];
    if (parent?.kind !== "agentGroup") throw new Error("expected agent group");
    expect(parent.children).toHaveLength(1);
  });

  it("completes the nested row when the dispatch's final tool result lands", () => {
    dispatchParentAgent();
    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "explorer", description: "Nested scout", prompt: "go" }, "parent-tool-1"), 2000);
    parser.dispatch(makeToolResultEvent("nested-1"), 4000);

    const parent = agentGroups()[0];
    if (parent?.kind !== "agentGroup") throw new Error("expected agent group");
    expect(parent.children[0]?.status).toBe("completed");
  });

  it("treats subagent lifecycle events for a nested row as no-ops", () => {
    dispatchParentAgent();
    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "explorer", description: "Nested scout", prompt: "go" }, "parent-tool-1"), 2000);

    const before = projector.getBlocks();
    parser.dispatch(makeAgentDispatchedEvent("nested-1"), 2500);
    expect(projector.getBlocks()).toEqual(before);
  });

  it("materializes a streaming-start nested dispatch as a row once its input completes", () => {
    dispatchParentAgent();
    projector.apply({ type: "tool-use", toolUseId: "nested-1", name: "subagent", input: {}, timestamp: 2000, parentToolUseId: "parent-tool-1" });
    projector.apply({ type: "tool-input-complete", toolUseId: "nested-1", name: "subagent", input: { persona: "explorer", description: "Nested scout", prompt: "go" }, timestamp: 2100, parentToolUseId: "parent-tool-1" });

    const groups = agentGroups();
    expect(groups).toHaveLength(1);
    const parent = groups[0];
    if (parent?.kind !== "agentGroup") throw new Error("expected agent group");
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]?.presentation.detail).toContain("Nested scout");
  });

  it("drops grandchild execution output instead of exposing it as streaming tool text", () => {
    dispatchParentAgent();
    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "explorer", description: "Nested scout", prompt: "go" }, "parent-tool-1"), 2000);

    projector.apply({ type: "tool-execution-output", toolUseId: "gc-tool-1", output: "grandchild output", parentToolUseId: "nested-1" });
    expect(projector.snapshot().streamingToolText["gc-tool-1"]).toBeUndefined();

    // Control: execution output whose parent is a real agent block still streams.
    projector.apply({ type: "tool-execution-output", toolUseId: "child-tool-1", output: "child output", parentToolUseId: "parent-tool-1" });
    expect(projector.snapshot().streamingToolText["child-tool-1"]?.content).toBe("child output");
  });
});
