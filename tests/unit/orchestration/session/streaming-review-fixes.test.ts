/**
 * Dedicated tests for streaming tool input review fixes.
 * Each section tests one finding independently with edge cases.
 */
import { describe, test, expect } from "bun:test";

import { OutputProjector } from "../../../../src/infra/output/output-projector";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import type { ContentBlock } from "../../../../src/infra/runtime-content-blocks";

// ---------------------------------------------------------------------------
// P2-6: O(n²) syntax highlighting → incremental
// (Can't easily test createHighlighter without TUI/theme context, but we
//  verify the logic via the runtime-event-projector streaming flow)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P3-7: type casts removed from dispatch
// ---------------------------------------------------------------------------

describe("P3: dispatch narrowing without type casts", () => {
  function assistantEvent(content: ContentBlock[]): RuntimeEvent {
    return createRuntimeEvent("model.assistant_message.recorded", { type: "model.assistant_message.recorded", message: { content } });
  }
  function toolInputDeltaEvent(toolUseId: string, partialJson: string): RuntimeEvent {
    return createRuntimeEvent("tool.input.delta", {
      type: "tool.input.delta", tool_use_id: toolUseId, partial_json: partialJson,
    });
  }
  function toolInputCompleteEvent(id: string, name: string, input: { [key: string]: unknown }): RuntimeEvent {
    return createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed", tool_use: { id, name, input },
    });
  }

  test("tool_input_delta dispatches correctly without casts", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "tc-1", name: "write", input: {} }]));
    parser.dispatch(toolInputDeltaEvent("tc-1", '{"path":"test.ts","content":"hello"'));
    const toolBlock = projector.getBlocks().find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    const streaming = projector.snapshot().streamingToolText["tc-1"];
    expect(streaming?.proposedDiff?.files[0]?.hunks[0]?.lines).toMatchObject([{ kind: "add", text: "hello" }]);
    expect(streaming?.content).toBeUndefined();
  });

  test("tool_input_complete dispatches correctly without casts", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);
    parser.dispatch(assistantEvent([{ type: "tool_use", id: "tc-1", name: "write", input: {} }]));
    parser.dispatch(toolInputCompleteEvent("tc-1", "write", { path: "test.ts", content: "final" }));
    const blocks = projector.getBlocks();
    const toolBlock = blocks.find(b => b.kind === "tool");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.kind === "tool") {
      expect(toolBlock.status).toBe("pending");
      expect(toolBlock.proposedDiff?.files[0]?.hunks[0]?.lines).toMatchObject([{ kind: "add", text: "final" }]);
      expect(toolBlock.content).toBeUndefined();
    }
    expect(projector.snapshot().streamingToolText).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// P2-4: eventParser.reset() on dispose
// ---------------------------------------------------------------------------

describe("P2: eventParser.reset() called on dispose", () => {
  test("RuntimeEventProjector reset clears all maps", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    // Simulate streaming start
    const event = createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      message: { content: [{ type: "tool_use", id: "tc-1", name: "write", input: {} }] },
    });
    parser.dispatch(event);

    // Reset should not throw and should clear internal state
    parser.reset();

    // After reset, a delta for the same toolUseId should be a no-op (buffer deleted)
    const delta = createRuntimeEvent("tool.input.delta", {
      type: "tool.input.delta",
      tool_use_id: "tc-1",
      partial_json: '{"content":"test"',
    });
    parser.dispatch(delta);

    // No streaming content should appear (buffer was cleared by reset)
    expect(projector.snapshot().streamingToolText).toEqual({});
  });
});
