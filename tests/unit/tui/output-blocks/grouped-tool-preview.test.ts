import { describe, expect, it } from "bun:test";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import type { ContentBlock } from "../../../../src/infra/runtime-content-blocks";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";

function makeAssistantEvent(content: ContentBlock[], parentToolUseId?: string): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: {
      type: "model.assistant_message.recorded",
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      message: { content },
    },
  };
}

describe("grouped tool rich previews", () => {
  it("suppresses content for subagent child Write tools", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(makeAssistantEvent([
      { type: "tool_use", id: "agent_tool", name: "subagent", input: { description: "work" } },
    ]), 1000);

    parser.dispatch(makeAssistantEvent([
      {
        type: "tool_use",
        id: "child_write",
        name: "Write",
        input: { path: "src/example.ts", content: "const value = 1;\nconst next = value + 1;\n" },
      },
    ], "agent_tool"), 1500);

    const blocks = projector.getBlocks();
    const agent = blocks[0];
    if (agent?.kind !== "agentGroup") throw new Error("expected agent group");
    const child = agent.children[0]!;

    expect(child.name).toBe("write");
    expect(child.linkUri).toMatch(/^file:\/\/.*\/src\/example\.ts$/);
    expect(child.content).toBeUndefined();
    expect(child.filetype).toBeUndefined();
  });
});

