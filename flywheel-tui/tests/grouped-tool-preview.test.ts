import { describe, expect, it } from "bun:test";
import { StructuredEventParser } from "../src/infra/output/structured-event-parser";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { ToolGroupBlock } from "../src/infra/output-blocks";
import { shouldRenderGroupedToolAsEntry } from "../src/tui/routes/work/components/output-blocks/tool-entry-helpers";

function makeAssistantEvent(content: Record<string, unknown>[], parentToolUseId?: string): NDJSONEvent {
  return {
    type: "assistant",
    data: {
      type: "assistant",
      message: { content, ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}) },
    },
    raw: "",
  };
}

describe("grouped tool rich previews", () => {
  it("captures diff data for grouped Edit tools", () => {
    const builder = new StructuredOutputBuilder();
    const parser = new StructuredEventParser(builder);

    parser.dispatch(makeAssistantEvent([
      { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "work", subagent_type: "Implement" } },
    ]), 1000);

    parser.dispatch(makeAssistantEvent([
      {
        type: "tool_use",
        id: "child_edit",
        name: "Edit",
        input: { file_path: "src/example.ts", old_string: "before", new_string: "after" },
      },
    ], "agent_tool"), 1500);

    const blocks = builder.getBlocks();
    const agent = blocks[0] as ToolGroupBlock;
    const child = agent.children[0]!;

    expect(child.name).toBe("Edit");
    expect(child.filePath).toBe("src/example.ts");
    expect(child.filetype).toBe("typescript");
    expect(child.diff).toContain("--- a/src/example.ts");
    expect(child.diff).toContain("-before");
    expect(child.diff).toContain("+after");
    expect(shouldRenderGroupedToolAsEntry(child)).toBe(true);
  });

  it("captures content data for grouped Write tools", () => {
    const builder = new StructuredOutputBuilder();
    const parser = new StructuredEventParser(builder);

    parser.dispatch(makeAssistantEvent([
      { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "work" } },
    ]), 1000);

    parser.dispatch(makeAssistantEvent([
      {
        type: "tool_use",
        id: "child_write",
        name: "Write",
        input: { file_path: "src/example.ts", content: "const value = 1;\nconst next = value + 1;\n" },
      },
    ], "agent_tool"), 1500);

    const blocks = builder.getBlocks();
    const agent = blocks[0] as ToolGroupBlock;
    const child = agent.children[0]!;

    expect(child.name).toBe("Write");
    expect(child.filePath).toBe("src/example.ts");
    expect(child.filetype).toBe("typescript");
    expect(child.content).toBe("const value = 1;\nconst next = value + 1;\n");
    expect(shouldRenderGroupedToolAsEntry(child)).toBe(true);
  });

  it("keeps plain grouped tools on the compact row path", () => {
    expect(shouldRenderGroupedToolAsEntry({ diff: undefined, content: undefined })).toBe(false);
  });
});
