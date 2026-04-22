import { describe, it, expect } from "bun:test";
import {
  classifyTool,
  SUBAGENT_TOOL_NAMES,
} from "../src/infra/tool-display-registry.js";

describe("classifyTool", () => {
  // Exploration tools
  it("classifies read as exploration", () => {
    expect(classifyTool("read")).toBe("exploration");
  });

  it("classifies glob as exploration", () => {
    expect(classifyTool("glob")).toBe("exploration");
  });

  it("classifies grep as exploration", () => {
    expect(classifyTool("grep")).toBe("exploration");
  });

  // Mutation tools
  it("classifies edit as mutation", () => {
    expect(classifyTool("edit")).toBe("mutation");
  });

  it("classifies write as mutation", () => {
    expect(classifyTool("write")).toBe("mutation");
  });

  // Execution tools
  it("classifies bash as execution", () => {
    expect(classifyTool("bash")).toBe("execution");
  });

  it("classifies powershell as execution", () => {
    expect(classifyTool("powershell")).toBe("execution");
  });

  it("classifies repl as execution", () => {
    expect(classifyTool("repl")).toBe("execution");
  });

  it("classifies websearch as execution", () => {
    expect(classifyTool("websearch")).toBe("execution");
  });

  it("classifies webfetch as execution", () => {
    expect(classifyTool("webfetch")).toBe("execution");
  });

  it("classifies lsp as execution", () => {
    expect(classifyTool("lsp")).toBe("execution");
  });

  it("classifies notebookedit as execution", () => {
    expect(classifyTool("notebookedit")).toBe("execution");
  });

  it("classifies sendmessage as execution", () => {
    expect(classifyTool("sendmessage")).toBe("execution");
  });

  it("classifies enterplanmode as execution", () => {
    expect(classifyTool("enterplanmode")).toBe("execution");
  });

  it("classifies exitplanmode as execution", () => {
    expect(classifyTool("exitplanmode")).toBe("execution");
  });

  it("classifies enterworktree as execution", () => {
    expect(classifyTool("enterworktree")).toBe("execution");
  });

  it("classifies exitworktree as execution", () => {
    expect(classifyTool("exitworktree")).toBe("execution");
  });

  it("classifies write_handoff as execution", () => {
    expect(classifyTool("write_handoff")).toBe("execution");
  });

  it("classifies remotetrigger as execution", () => {
    expect(classifyTool("remotetrigger")).toBe("execution");
  });

  // Subagent tools
  it("classifies agent as subagent", () => {
    expect(classifyTool("agent")).toBe("subagent");
  });

  it("classifies task as subagent", () => {
    expect(classifyTool("task")).toBe("subagent");
  });

  // Standalone tools
  it("classifies askuserquestion as standalone", () => {
    expect(classifyTool("askuserquestion")).toBe("standalone");
  });

  it("classifies todowrite as standalone", () => {
    expect(classifyTool("todowrite")).toBe("standalone");
  });

  it("classifies skill as standalone", () => {
    expect(classifyTool("skill")).toBe("standalone");
  });

  it("classifies toolsearch as standalone", () => {
    expect(classifyTool("toolsearch")).toBe("standalone");
  });

  it("classifies todo_list as standalone", () => {
    expect(classifyTool("todo_list")).toBe("standalone");
  });

  // Case normalization
  it("normalizes to lowercase before lookup", () => {
    expect(classifyTool("Read")).toBe("exploration");
    expect(classifyTool("BASH")).toBe("execution");
    expect(classifyTool("Agent")).toBe("subagent");
    expect(classifyTool("AskUserQuestion")).toBe("standalone");
  });

  // Unknown tools default to execution
  it("defaults unknown tools to execution", () => {
    expect(classifyTool("some_random_tool")).toBe("execution");
  });

  // MCP tools default to execution
  it("classifies MCP tools as execution", () => {
    expect(classifyTool("mcp__foo__bar")).toBe("execution");
  });

  it("classifies mcp__github__create_issue as execution", () => {
    expect(classifyTool("mcp__github__create_issue")).toBe("execution");
  });
});

describe("SUBAGENT_TOOL_NAMES (derived from registry)", () => {
  it("includes task (lowercase)", () => {
    expect(SUBAGENT_TOOL_NAMES.has("task")).toBe(true);
  });

  it("includes agent (lowercase)", () => {
    expect(SUBAGENT_TOOL_NAMES.has("agent")).toBe(true);
  });

  it("does not include capitalized variants (consumers normalize)", () => {
    expect(SUBAGENT_TOOL_NAMES.has("Task")).toBe(false);
    expect(SUBAGENT_TOOL_NAMES.has("Agent")).toBe(false);
  });

  it("does not include unrelated tools", () => {
    expect(SUBAGENT_TOOL_NAMES.has("bash")).toBe(false);
    expect(SUBAGENT_TOOL_NAMES.has("read")).toBe(false);
  });
});
