import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";

const mutations = [
  { name: "write", input: { path: "src/a.ts", content: "new content" }, displayName: "Write", kind: "create" },
  { name: "edit", input: { path: "src/a.ts", old_string: "old", new_string: "new" }, displayName: "Edit", kind: "replace" },
  { name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: src/a.ts\n+new content\n*** End Patch" }, displayName: "Edit", kind: "patch" },
] as const;

function group(output: OutputProjector): AgentGroupBlock {
  const block = output.getBlocks().find((candidate) => candidate.kind === "agentGroup");
  if (!block || block.kind !== "agentGroup") throw new Error("expected subagent group");
  return block;
}

function parentOutput(): OutputProjector {
  const output = new OutputProjector({ executionCwd: "/workspace" });
  output.apply({ type: "tool-use", toolUseId: "parent", name: "subagent", input: { description: "Work" }, timestamp: 1 });
  return output;
}

const FILE_URI = pathToFileURL(resolve("/workspace", "src/a.ts")).href;

describe("compact subagent tool previews", () => {
  for (const { name, input, displayName, kind } of mutations) test(`streams ${name} presentation without a hidden proposal`, () => {
    const parent = parentOutput();
    const child = new OutputProjector({ executionCwd: "/workspace" });
    for (const output of [parent, child]) {
      const parentToolUseId = output === parent ? "parent" : undefined;
      output.apply({ type: "tool-use", toolUseId: "mutation", name, input: {}, timestamp: 2, parentToolUseId });
      output.apply({ type: "tool-input-delta", toolUseId: "mutation", partialJson: JSON.stringify(input).slice(0, -2), parentToolUseId });
    }
    expect(group(parent).children[0]).toMatchObject({
      status: "streaming", presentation: { name: displayName, detail: "src/a.ts" }, fileChangeKind: kind,
    });
    expect(parent.snapshot().streamingToolText).toEqual({});
    expect(child.snapshot().streamingToolText.mutation).toHaveProperty("proposedDiff");
    for (const output of [parent, child]) {
      output.apply({ type: "tool-preview-check", toolUseId: "mutation", operation: { type: "set", advice: "Check this change" } });
    }
    expect(parent.snapshot().streamingToolText).toEqual({});
    expect(child.snapshot().streamingToolText.mutation?.previewCheck).toBe("Check this change");

    for (const output of [parent, child]) {
      output.apply({ type: "tool-input-complete", toolUseId: "mutation", name, input, timestamp: 3, parentToolUseId: output === parent ? "parent" : undefined });
    }
    expect(group(parent).children[0]).toMatchObject({ fileChangeKind: kind });
    expect(group(parent).children[0]).not.toHaveProperty("proposedDiff");
    expect(child.getBlocks()[0]).toHaveProperty("proposedDiff");
  });

  test.each(["tool-use", "agent-tool-use", "untracked"] as const)("omits immediate child proposals from %s", (route) => {
    const output = parentOutput();
    const input = { path: "src/a.ts", content: "new content" };
    if (route === "agent-tool-use") {
      output.apply({ type: "agent-tool-use", agentId: group(output).id, toolUseId: "mutation", name: "write", input, timestamp: 2 });
    } else {
      output.apply({ type: "tool-use", toolUseId: route === "untracked" ? undefined : "mutation", parentToolUseId: "parent", name: "write", input, timestamp: 2 });
    }
    expect(group(output).children[0]).toMatchObject({
      status: "pending", presentation: { name: "Write", detail: "src/a.ts" }, linkUri: FILE_URI, fileChangeKind: "create",
    });
    expect(group(output).children[0]).not.toHaveProperty("proposedDiff");
  });

  test("input completion cannot rebuild a hidden proposal without streamed body fields", () => {
    const output = parentOutput();
    output.apply({ type: "tool-use", toolUseId: "mutation", parentToolUseId: "parent", name: "write", input: {}, timestamp: 2 });
    output.apply({ type: "tool-input-complete", toolUseId: "mutation", parentToolUseId: "parent", name: "write", input: { path: "src/a.ts", content: "new content" }, timestamp: 3 });
    expect(group(output).children[0]).toMatchObject({ presentation: { name: "Write", detail: "src/a.ts" }, fileChangeKind: "create" });
    expect(group(output).children[0]).not.toHaveProperty("proposedDiff");
  });
});
