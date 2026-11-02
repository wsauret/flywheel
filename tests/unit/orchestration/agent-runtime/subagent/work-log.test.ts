import { describe, expect, it } from "bun:test";

import {
  buildFallbackSummary,
  buildSubagentWorkLog,
  createSubagentTurnLog,
  formatSubagentToolCall,
  type SubagentToolCallRecord,
} from "../../../../../src/orchestration/modules/subagents/execution/work-log.js";

const record = (overrides: Partial<SubagentToolCallRecord> & Pick<SubagentToolCallRecord, "toolName" | "input">): SubagentToolCallRecord => ({
  status: "done",
  ...overrides,
});

describe("formatSubagentToolCall", () => {
  it("formats bash command with truncated argument and output", () => {
    const longCmd = "echo ".repeat(60);
    const formatted = formatSubagentToolCall(record({
      toolName: "bash",
      input: { command: longCmd },
      result: "x".repeat(400),
    }));
    expect(formatted).toContain("### bash (done)");
    expect(formatted).toContain("**Command:**");
    expect(formatted).toContain("...");
    expect(formatted).toContain("**Output:**");
    expect(formatted).toContain("(truncated)");
  });

  it("formats edit with path and result", () => {
    const formatted = formatSubagentToolCall(record({
      toolName: "edit",
      input: { path: "src/foo.ts" },
      result: "@@ -1 +1 @@\n-old\n+new",
    }));
    expect(formatted).toContain("### edit (done)");
    expect(formatted).toContain("**Path:** `src/foo.ts`");
    expect(formatted).toContain("**Result:**");
  });

  it("formats stored historical replace calls generically", () => {
    const formatted = formatSubagentToolCall(record({
      toolName: "replace",
      input: { files: ["a.sql", "b.sql"], old: "x", new: "y" },
      result: "a.sql:\n-x\n+y",
    }));
    expect(formatted).toBe("\n### replace (done)");
  });

  it("includes status for pending, error, and interrupted records", () => {
    expect(formatSubagentToolCall(record({ toolName: "bash", input: { command: "ls" }, status: "pending" })))
      .toContain("### bash (pending)");
    expect(formatSubagentToolCall(record({ toolName: "edit", input: { path: "a.ts" }, status: "error" })))
      .toContain("### edit (error)");
    expect(formatSubagentToolCall(record({ toolName: "bash", input: { command: "sleep 10" }, status: "interrupted" })))
      .toContain("### bash (interrupted)");
  });
});

describe("createSubagentTurnLog", () => {
  it("retains only formatter-consumed input without changing source objects", () => {
    const source = {
      path: "src/a.ts",
      pattern: "needle",
      unused: { body: "large" },
    };
    const before = structuredClone(source);
    const turnLog = createSubagentTurnLog();

    turnLog.observer.recordToolUse("read", "read", source);
    turnLog.observer.recordToolUse("search", "search", source);
    turnLog.observer.recordToolUse("other", "ask_user", source);

    expect(turnLog.records.map(({ input }) => input)).toEqual([
      { path: "src/a.ts" },
      { pattern: "needle", path: "src/a.ts" },
      {},
    ]);
    expect(source).toEqual(before);
  });

  it("retains enough command and result content to preserve formatter boundaries", () => {
    const turnLog = createSubagentTurnLog();
    turnLog.observer.recordToolUse("bash", "bash", { command: "c".repeat(250), unused: "drop" });
    turnLog.observer.recordToolResult("bash", [{ type: "text", text: "r".repeat(400) }], false, false);

    expect(turnLog.records[0]?.input).toEqual({ command: "c".repeat(201) });
    expect(turnLog.records[0]?.result?.length).toBe(301);
  });

  it("records each registration under the tool it calls", () => {
    const turnLog = createSubagentTurnLog();
    turnLog.observer.recordToolUse("exec", "exec", { command: "c".repeat(250), working_directory: "drop" });
    turnLog.observer.recordToolUse("patch", "apply_patch", { input: "*** Begin Patch" });
    const execOutput = [{ type: "text" as const, text: "exec output" }];
    const patchOutput = [{ type: "text" as const, text: "patched a.ts" }];
    turnLog.observer.recordToolResult("exec", execOutput, false, false);
    turnLog.observer.recordToolResult("patch", patchOutput, false, false);

    expect(turnLog.records.map((entry) => entry.toolName)).toEqual(["bash", "edit"]);
    expect(turnLog.records[0]?.input).toEqual({ command: "c".repeat(201) });
    expect(turnLog.records.map((entry) => entry.result)).toEqual([JSON.stringify(execOutput), JSON.stringify(patchOutput)]);
  });

  it("serializes results only for completed bash, edit, and write calls", () => {
    let serializationCount = 0;
    const content = [{ type: "text" as const, text: "result", toJSON: () => {
      serializationCount++;
      return { type: "text", text: "result" };
    } }];
    const turnLog = createSubagentTurnLog();
    turnLog.observer.recordToolUse("read", "read", { path: "a.ts" });
    turnLog.observer.recordToolUse("failed", "edit", { path: "a.ts" });
    turnLog.observer.recordToolUse("interrupted", "write", { path: "a.ts" });
    turnLog.observer.recordToolUse("done", "bash", { command: "true" });

    turnLog.observer.recordToolResult("read", content, false, false);
    turnLog.observer.recordToolResult("failed", content, true, false);
    turnLog.observer.recordToolResult("interrupted", content, false, true);
    turnLog.observer.recordToolResult("missing", content, false, false);
    expect(serializationCount).toBe(0);
    turnLog.observer.recordToolResult("done", content, false, false);

    expect(serializationCount).toBe(1);
    expect(turnLog.records.map(({ status }) => status)).toEqual(["done", "error", "interrupted", "done"]);
    expect(turnLog.records.map(({ result }) => result)).toEqual([
      undefined,
      undefined,
      undefined,
      '[{"type":"text","text":"result"}]',
    ]);
  });

  it("preserves exact command and result formatter truncation at retained boundaries", () => {
    const envelopeLength = JSON.stringify([{ type: "text", text: "" }]).length;
    for (const commandLength of [200, 201, 250]) {
      for (const resultLength of [300, 301, 500]) {
        const input = { command: "c".repeat(commandLength) };
        const content = [{ type: "text" as const, text: "r".repeat(resultLength - envelopeLength) }];
        const original = record({ toolName: "bash", input, result: JSON.stringify(content) });
        const turnLog = createSubagentTurnLog();
        turnLog.observer.recordToolUse("bash", "bash", input);
        turnLog.observer.recordToolResult("bash", content, false, false);
        expect(original.result?.length).toBe(resultLength);
        expect(buildSubagentWorkLog(turnLog.records)).toBe(buildSubagentWorkLog([original]));
        expect(buildFallbackSummary(turnLog.records)).toBe(buildFallbackSummary([original]));
      }
    }
  });
});

describe("buildSubagentWorkLog", () => {
  it("renders an empty log for no records", () => {
    expect(buildSubagentWorkLog([])).toBe("");
  });

  it("renders one block per record with numbering", () => {
    const log = buildSubagentWorkLog([
      record({ toolName: "read", input: { path: "a.ts" } }),
      record({ toolName: "edit", input: { path: "a.ts" } }),
    ]);
    expect(log).toContain("## Tool call 1");
    expect(log).toContain("## Tool call 2");
    expect(log).toContain("---");
  });
});

describe("buildFallbackSummary", () => {
  it("buckets file changes, commands, reads, searches, and other tools", () => {
    const summary = buildFallbackSummary([
      record({ toolName: "edit", input: { path: "src/a.ts" } }),
      record({ toolName: "write", input: { path: "src/b.ts" } }),
      record({ toolName: "bash", input: { command: "bun test" } }),
      record({ toolName: "read", input: { path: "src/c.ts" } }),
      record({ toolName: "search", input: { pattern: "foo" } }),
      record({ toolName: "list", input: { path: "src" } }),
      record({ toolName: "ask_user", input: {} }),
      record({ toolName: "ask_user", input: {} }),
    ]);
    expect(summary).toContain("**File changes:**");
    expect(summary).toContain("- edit: `src/a.ts`");
    expect(summary).toContain("- write: `src/b.ts`");
    expect(summary).toContain("**Commands run:**");
    expect(summary).toContain("`bun test`");
    expect(summary).toContain("**Files read:**");
    expect(summary).toContain("- `src/c.ts`");
    expect(summary).toContain("**Searches:**");
    expect(summary).toContain("- search: `foo`");
    expect(summary).toContain("- list: `src`");
    expect(summary).toContain("**Other tools used:** ask_user");
  });

  it("skips records that did not reach status 'done'", () => {
    const summary = buildFallbackSummary([
      record({ toolName: "edit", input: { path: "src/a.ts" }, status: "pending" }),
      record({ toolName: "bash", input: { command: "ls" }, status: "error" }),
    ]);
    expect(summary).not.toContain("**File changes:**");
    expect(summary).not.toContain("**Commands run:**");
  });

  it("truncates long bash commands to 60 chars in the fallback", () => {
    const cmd = "a".repeat(120);
    const summary = buildFallbackSummary([record({ toolName: "bash", input: { command: cmd } })]);
    expect(summary).toContain(`${"a".repeat(60)}...`);
  });
});
