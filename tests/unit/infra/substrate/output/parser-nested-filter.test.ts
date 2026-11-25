import { describe, it, expect, beforeEach } from "bun:test";
import { RuntimeEventProjector } from "../../../../../src/infra/substrate/output/projector/runtime-event-projector";
import { OutputProjector } from "../../../../../src/infra/substrate/output/projector/output-projector";
import type { RuntimeEvent } from "../../../../../src/infra/substrate/runtime-facts/runtime-event-types";
import { makeToolResultEvent } from "./_parser-fixtures";

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

// A subagent's own calls, including a subagent it dispatches, render in its
// own session. A nested event that reaches the parent adds no block, no row
// of the card, and no streaming tool text.
describe("a subagent's calls stay out of the parent's transcript", () => {
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

  it("adds neither a block nor a card row for a nested dispatch, its result, or its interior", () => {
    parser.dispatch(toolInputCompleted("parent-tool-1", "subagent", { persona: "explorer", description: "Scout the repo", prompt: "look around" }), 1000);
    const card = projector.getBlocks();
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ kind: "agentGroup", children: [] });

    projector.apply({ type: "tool-use", toolUseId: "nested-1", name: "subagent", input: {}, timestamp: 2000, parentToolUseId: "parent-tool-1" });
    parser.dispatch(toolInputCompleted("nested-1", "subagent", { persona: "explorer", description: "Nested scout", prompt: "go" }, "parent-tool-1"), 2100);
    parser.dispatch(toolInputCompleted("gc-tool-1", "read", { path: "src/index.ts" }, "nested-1"), 3000);
    parser.dispatch(makeToolResultEvent("nested-1"), 4000);

    expect(projector.getBlocks()).toEqual(card);
  });

  it("streams no execution output of a call under a subagent", () => {
    parser.dispatch(toolInputCompleted("parent-tool-1", "subagent", { persona: "explorer", description: "Scout the repo", prompt: "look around" }), 1000);
    projector.apply({ type: "tool-execution-output", toolUseId: "child-tool-1", output: "child output", parentToolUseId: "parent-tool-1" });
    expect(projector.snapshot().streamingToolText).toEqual({});
  });
});
