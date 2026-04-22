import { describe, it, expect } from "bun:test";
import {
  getToolDisplay,
  getToolDisplayName,
} from "../src/infra/tool-display-registry.js";

describe("getToolDisplay", () => {
  it("returns metadata for a known tool (lowercase)", () => {
    const meta = getToolDisplay("read");
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe("Read");
  });

  it("returns metadata for a known tool (mixed case)", () => {
    const meta = getToolDisplay("Read");
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe("Read");
  });

  it("case-insensitive: Read and read return the same entry", () => {
    const lower = getToolDisplay("read");
    const upper = getToolDisplay("Read");
    expect(lower).toEqual(upper);
  });

  it("case-insensitive: BASH and bash return the same entry", () => {
    const lower = getToolDisplay("bash");
    const upper = getToolDisplay("BASH");
    expect(lower).toEqual(upper);
  });

  it("returns undefined for an unknown tool name", () => {
    expect(getToolDisplay("totally_unknown_tool_xyz")).toBeUndefined();
  });

  it("returns entries with getDetail for tools that have handlers", () => {
    const read = getToolDisplay("read");
    expect(read).toBeDefined();
    expect(typeof read!.getDetail).toBe("function");
  });

  it("returns entries without getDetail for display-only tools", () => {
    const remote = getToolDisplay("remotetrigger");
    expect(remote).toBeDefined();
    expect(remote!.displayName).toBe("Remote Trigger");
    expect(remote!.getDetail).toBeUndefined();
  });
});

describe("getToolDisplay detail handlers", () => {
  const cwd = "/home/user/project";

  it("Read: returns formatted file path", () => {
    const meta = getToolDisplay("read");
    const detail = meta!.getDetail!({ file_path: "/home/user/project/src/index.ts" }, cwd);
    expect(detail).toBe("src/index.ts");
  });

  it("Read: includes line range when offset/limit given", () => {
    const meta = getToolDisplay("read");
    const detail = meta!.getDetail!({ file_path: "/home/user/project/src/index.ts", offset: 10, limit: 20 }, cwd);
    expect(detail).toBe("src/index.ts:11-30");
  });

  it("Write: returns formatted file path", () => {
    const meta = getToolDisplay("write");
    const detail = meta!.getDetail!({ file_path: "/home/user/project/README.md" }, cwd);
    expect(detail).toBe("README.md");
  });

  it("Edit: returns formatted file path", () => {
    const meta = getToolDisplay("edit");
    const detail = meta!.getDetail!({ file_path: "/home/user/project/src/app.ts" }, cwd);
    expect(detail).toBe("src/app.ts");
  });

  it("Edit: returns null when no file_path", () => {
    const meta = getToolDisplay("edit");
    const detail = meta!.getDetail!({}, cwd);
    expect(detail).toBeNull();
  });

  it("Bash: returns shortened command", () => {
    const meta = getToolDisplay("bash");
    const detail = meta!.getDetail!({ command: "ls /home/user/project/src" }, cwd);
    expect(detail).toBe("ls src");
  });

  it("Glob: returns pattern and directory", () => {
    const meta = getToolDisplay("glob");
    const detail = meta!.getDetail!({ pattern: "*.ts", path: "/home/user/project/src" }, cwd);
    expect(detail).toBe("\"*.ts\" in src");
  });

  it("Grep: returns pattern, directory, and file filter", () => {
    const meta = getToolDisplay("grep");
    const detail = meta!.getDetail!({ pattern: "TODO", path: "/home/user/project/src", glob: "*.ts" }, cwd);
    expect(detail).toBe("\"TODO\" in src [*.ts]");
  });

  it("Agent: returns description with subagent type", () => {
    const meta = getToolDisplay("agent");
    const detail = meta!.getDetail!({ description: "Search files", subagent_type: "explore" }, cwd);
    expect(detail).toBe("[explore] Search files");
  });

  it("WebFetch: returns URL", () => {
    const meta = getToolDisplay("webfetch");
    const detail = meta!.getDetail!({ url: "https://example.com" }, cwd);
    expect(detail).toBe("https://example.com");
  });

  it("WebSearch: returns query", () => {
    const meta = getToolDisplay("websearch");
    const detail = meta!.getDetail!({ query: "bun test runner" }, cwd);
    expect(detail).toBe("bun test runner");
  });

  it("LSP: returns method and file path", () => {
    const meta = getToolDisplay("lsp");
    const detail = meta!.getDetail!({ method: "textDocument/hover", file_path: "/home/user/project/src/x.ts" }, cwd);
    expect(detail).toBe("textDocument/hover src/x.ts");
  });

  it("Skill: returns skill name", () => {
    const meta = getToolDisplay("skill");
    const detail = meta!.getDetail!({ skill: "flywheel:work" }, cwd);
    expect(detail).toBe("flywheel:work");
  });

  it("SendMessage: returns recipient", () => {
    const meta = getToolDisplay("sendmessage");
    const detail = meta!.getDetail!({ to: "user@example.com" }, cwd);
    expect(detail).toBe("to user@example.com");
  });

  it("AskUserQuestion: returns question text", () => {
    const meta = getToolDisplay("askuserquestion");
    const detail = meta!.getDetail!({ question: "Which file?" }, cwd);
    expect(detail).toBe("Which file?");
  });

  it("ToolSearch: returns query", () => {
    const meta = getToolDisplay("toolsearch");
    const detail = meta!.getDetail!({ query: "file search" }, cwd);
    expect(detail).toBe("file search");
  });

  it("TodoWrite: has no detail handler", () => {
    const meta = getToolDisplay("todowrite");
    expect(meta!.getDetail).toBeUndefined();
  });

  it("todo_list: returns operation detail", () => {
    const meta = getToolDisplay("todo_list");
    const detail = meta!.getDetail!({ operation: "write", todos: [{ content: "a" }, { content: "b" }] }, cwd);
    expect(detail).toBe("write (2 items)");
  });

  it("write_handoff: returns summary", () => {
    const meta = getToolDisplay("write_handoff");
    const detail = meta!.getDetail!({ summary: "Completed phase 1" }, cwd);
    expect(detail).toBe("Completed phase 1");
  });

  it("EnterPlanMode: has no detail handler", () => {
    const meta = getToolDisplay("enterplanmode");
    expect(meta!.getDetail).toBeUndefined();
  });

  it("NotebookEdit: returns formatted notebook path", () => {
    const meta = getToolDisplay("notebookedit");
    const detail = meta!.getDetail!({ notebook_path: "/home/user/project/analysis.ipynb" }, cwd);
    expect(detail).toBe("analysis.ipynb");
  });

  it("Read: handles handoff paths with shortening", () => {
    const meta = getToolDisplay("read");
    const detail = meta!.getDetail!({ file_path: "/home/user/project/.flywheel/sessions/abc-123/handoffs/work_step1.json" }, cwd);
    expect(detail).toBe("[handoff] work_step1.json");
  });
});

describe("getToolDisplayName", () => {
  it("returns mapped display name for known tools", () => {
    expect(getToolDisplayName("grep")).toBe("Text Search");
    expect(getToolDisplayName("Grep")).toBe("Text Search");
    expect(getToolDisplayName("bash")).toBe("Bash");
    expect(getToolDisplayName("read")).toBe("Read");
    expect(getToolDisplayName("agent")).toBe("Subagent");
    expect(getToolDisplayName("task")).toBe("Subagent");
    expect(getToolDisplayName("websearch")).toBe("Web Search");
    expect(getToolDisplayName("webfetch")).toBe("Web Fetch");
    expect(getToolDisplayName("notebookedit")).toBe("Notebook Edit");
    expect(getToolDisplayName("powershell")).toBe("PowerShell");
    expect(getToolDisplayName("repl")).toBe("REPL");
    expect(getToolDisplayName("todowrite")).toBe("Todo List");
    expect(getToolDisplayName("toolsearch")).toBe("Tool Search");
    expect(getToolDisplayName("sendmessage")).toBe("Send Message");
    expect(getToolDisplayName("askuserquestion")).toBe("Ask User");
    expect(getToolDisplayName("enterplanmode")).toBe("Enter Plan Mode");
    expect(getToolDisplayName("exitplanmode")).toBe("Exit Plan Mode");
    expect(getToolDisplayName("enterworktree")).toBe("Enter Worktree");
    expect(getToolDisplayName("exitworktree")).toBe("Exit Worktree");
    expect(getToolDisplayName("write")).toBe("Write");
    expect(getToolDisplayName("edit")).toBe("Edit");
    expect(getToolDisplayName("glob")).toBe("File Search");
    expect(getToolDisplayName("lsp")).toBe("LSP");
    expect(getToolDisplayName("skill")).toBe("Skill");
    expect(getToolDisplayName("remotetrigger")).toBe("Remote Trigger");
  });

  it("handles cron prefix tools", () => {
    expect(getToolDisplayName("schedulecron_daily")).toBe("Cron");
    expect(getToolDisplayName("ScheduleCronWeekly")).toBe("Cron");
    expect(getToolDisplayName("cron_task")).toBe("Cron");
    expect(getToolDisplayName("CronDelete")).toBe("Cron");
  });

  it("handles MCP prefixed tools", () => {
    expect(getToolDisplayName("mcp__github__create_issue")).toBe("MCP github");
    expect(getToolDisplayName("mcp__slack__send_message")).toBe("MCP slack");
  });

  it("returns raw name for completely unknown tools", () => {
    expect(getToolDisplayName("SomeRandomTool")).toBe("SomeRandomTool");
  });
  it("uses Write Handoff for session handoff file writes", () => {
    const filePath = "/home/user/project/.flywheel/sessions/abc-123/handoffs/work_step1.json";
    expect(getToolDisplayName("Write", { filePath })).toBe("Write Handoff");
    expect(getToolDisplayName("Edit", { filePath })).toBe("Write Handoff");
  });


  it("returns proper display names for todo_list and write_handoff", () => {
    expect(getToolDisplayName("todo_list")).toBe("Todo List");
    expect(getToolDisplayName("write_handoff")).toBe("Write Handoff");
  });
});
