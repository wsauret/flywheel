import { describe, expect, it } from "bun:test";
import { prepareToolCall, preparedToolAdmission, repairToolCall, repairToolName } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { RuntimeTool, ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { applyPatchDefinition } from "../../../../../src/orchestration/agent-runtime/tools/apply-patch.js";
import { editDefinition } from "../../../../../src/orchestration/agent-runtime/tools/edit.js";
import { searchDefinition } from "../../../../../src/orchestration/agent-runtime/tools/search.js";
import { makeMockOps } from "./_bash-fixtures.js";
import { makeContext } from "./_fixtures.js";

function stubTool(name: string): RuntimeTool {
  return {
    name,
    action: "file_read",
    description: `stub ${name}`,
    inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: true,
    execute: async (): Promise<ToolResult> => ({ content: name, outcome: "ok" }),
  };
}

function toolMap(...names: string[]): Map<string, RuntimeTool> {
  return new Map(names.map((name) => [name, stubTool(name)]));
}

describe("repairToolName", () => {
  const tools = toolMap("read", "write", "edit", "search", "bash", "todo_tool_list", "write_file", "todo", "patch", "browser_click", "subagent");

  it("returns null for names that are already registered", () => {
    expect(repairToolName("read", tools)).toBeNull();
    expect(repairToolName("", tools)).toBeNull();
  });

  it("repairs casing and separator variants", () => {
    expect(repairToolName("Read", tools)).toBe("read");
    expect(repairToolName("write file", tools)).toBe("write_file");
    expect(repairToolName("write-file", tools)).toBe("write_file");
  });

  it("strips class-like tool suffixes, applied twice for double-tacked ones", () => {
    // Double-tacked class-like suffix shapes seen in the wild.
    expect(repairToolName("TodoTool_tool", tools)).toBe("todo");
    expect(repairToolName("Patch_tool", tools)).toBe("patch");
    expect(repairToolName("BrowserClick_tool", tools)).toBe("browser_click");
  });

  it("trims XML protocol fragments leaked into the name field", () => {
    // The VolcEngine XML protocol leak shape seen in the wild.
    expect(repairToolName('bash" parameter="command" string="true', tools)).toBe("bash");
    expect(repairToolName('subagent" parameter="prompt"', tools)).toBe("subagent");
  });

  it("fuzzy-matches close misspellings above the 0.7 cutoff", () => {
    expect(repairToolName("wrte_file", tools)).toBe("write_file");
  });

  it("rejects ambiguous fuzzy matches and distant names", () => {
    // Equidistant between two valid names: must NOT pick one arbitrarily.
    const ambiguous = toolMap("tool_ab", "tool_ba");
    expect(repairToolName("tool_aa", ambiguous)).toBeNull();
    expect(repairToolName("completely_unrelated", tools)).toBeNull();
  });

  it("never resolves outside the exposed map", () => {
    const narrow = toolMap("read");
    expect(repairToolName("write", narrow)).toBeNull();
  });
});

describe("repairToolCall and prepareToolCall integration", () => {
  const tools = toolMap("read", "write");

  it("stamps repairedFrom and preserves identity when no repair is needed", () => {
    const call = { id: "t1", name: "Read_tool", input: {} };
    const repaired = repairToolCall(call, tools);
    expect(repaired.name).toBe("read");
    expect(repaired.repairedFrom).toBe("Read_tool");

    const untouched = { id: "t2", name: "read", input: {} };
    expect(repairToolCall(untouched, tools)).toBe(untouched);
  });

  it("prepareToolCall resolves the repaired tool instead of rejecting", () => {
    const prepared = prepareToolCall({ id: "t3", name: "Write_tool", input: {} }, tools);
    expect(prepared.validationResult).toBeUndefined();
    expect(prepared.tool?.name).toBe("write");
    expect(prepared.call.name).toBe("write");
    expect(prepared.call.repairedFrom).toBe("Write_tool");
  });

  it("prepareToolCall stamps input repairs on the call", () => {
    const wrapTools = new Map([[
      "fetch",
      {
        ...stubTool("fetch"),
        inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } } },
      },
    ]]);
    const prepared = prepareToolCall({ id: "t5", name: "fetch", input: { urls: "https://a.com" } }, wrapTools);
    expect(prepared.validationResult).toBeUndefined();
    expect(prepared.input).toEqual({ urls: ["https://a.com"] });
    expect(prepared.call.inputRepairs).toEqual([{ kind: "wrapped_in_array", path: "urls" }]);
  });

  it("prepareToolCall repairs the arguments real tools refused, and still refuses a key that could change meaning", async () => {
    const realTools = new Map<string, RuntimeTool>([["bash", createBashDefinition({ operations: makeMockOps() })], ["edit", editDefinition], ["search", searchDefinition]]);

    const bash = prepareToolCall({ id: "r1", name: "bash", input: { command: "ls", timeout: null, windowsHide: true } }, realTools);
    await preparedToolAdmission(bash, makeContext());
    expect(bash.validationResult).toBeUndefined();
    expect(bash.input).toEqual({ command: "ls" });
    expect(bash.call.inputRepairs).toEqual([{ kind: "dropped_null", path: "timeout" }, { kind: "dropped_key", path: "windowsHide" }]);

    const edit = prepareToolCall({ id: "r2", name: "edit", input: { file_path: "a.ts", old_text: "x", new_string: "y" } }, realTools);
    await preparedToolAdmission(edit, makeContext());
    expect(edit.validationResult).toBeUndefined();
    expect(edit.input).toEqual({ path: "a.ts", old_string: "x", new_string: "y" });

    const search = prepareToolCall({ id: "r3", name: "search", input: { pattern: "x", output_mode: "files_with_matches" } }, realTools);
    await preparedToolAdmission(search, makeContext());
    expect(search.validationResult).toBeUndefined();
    expect(search.input).toEqual({ pattern: "x", output_mode: "matching_files" });

    // apply_patch takes raw patch text, so an escape in it stays as written.
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-const s = \"caf\\u00e9\";\n+const s = \"cafe\";\n*** End Patch";
    const applyPatch = prepareToolCall({ id: "r5", name: "apply_patch", input: { input: patch } }, new Map([["apply_patch", applyPatchDefinition]]));
    expect(applyPatch.input).toEqual({ input: patch });
    expect(applyPatch.call.inputRepairs).toBeUndefined();

    const unknown = prepareToolCall({ id: "r4", name: "search", input: { pattern: "x", respect_gitignore: true } }, realTools);
    await preparedToolAdmission(unknown, makeContext());
    expect(unknown.validationResult?.content).toContain("An unexpected parameter `respect_gitignore` was provided");
  });

  it("prepareToolCall still rejects unrepairable names with the available list", () => {
    const prepared = prepareToolCall({ id: "t4", name: "launch_missiles", input: {} }, tools);
    expect(prepared.validationResult?.outcome).toBe("error");
    expect(prepared.validationResult?.content).toContain("Unknown tool");
  });
});
