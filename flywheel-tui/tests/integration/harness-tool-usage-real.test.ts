/**
 * Integration tests verifying LLMs correctly use harness tools end-to-end.
 *
 * Each test runs the full agent loop with a real API call and asserts
 * the model used the expected tool(s) to accomplish the task. This catches
 * prompt/schema regressions that unit tests cannot detect.
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModelsClient } from "../../src/orchestration/engines/providers/harness/llm/models.js";
import { createClient } from "../../src/orchestration/engines/providers/harness/llm/client-factory.js";
import { getToolDefinitions } from "../../src/orchestration/engines/providers/harness/tools/tool-dispatch.js";
import { runAgentLoop } from "../../src/orchestration/engines/providers/harness/agent-loop.js";
import { buildHarnessSystemPrompt } from "../../src/orchestration/engines/providers/harness/prompt.js";
import type { StreamEvent } from "../../src/orchestration/engines/providers/harness/llm/types.js";

const ALL_TOOL_NAMES = new Set(getToolDefinitions().map((t) => t.name));

function makeSystemPrompt(model: string): string {
  return buildHarnessSystemPrompt({
    orchestrationSystemPrompt: "You are a helpful coding assistant.",
    model,
    availableTools: ALL_TOOL_NAMES,
  });
}

/** Extract tool names used from stream events. */
function getToolNames(events: StreamEvent[]): string[] {
  return events
    .filter((e): e is Extract<StreamEvent, { kind: "tool_use" }> => e.kind === "tool_use")
    .map((e) => e.toolCall.name);
}

function toolWasUsed(events: StreamEvent[], toolName: string): boolean {
  return getToolNames(events).includes(toolName);
}

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT = 120_000;

describe("Harness tool usage with real LLM (Anthropic)", () => {
  it("uses write tool to create a new file", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          "Create a new file at greeting.txt containing exactly 'Hello, World!'. " +
          "Use the write tool. Do NOT use bash. Do NOT call write_handoff. " +
          "After creating the file, stop.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      const filePath = path.join(tmpDir, "greeting.txt");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("Hello, World!");

      expect(toolWasUsed(events, "write")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("uses read then edit to modify an existing file", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const filePath = path.join(tmpDir, "config.ts");
      fs.writeFileSync(filePath, 'const API_URL = "http://localhost:3000";\nconst TIMEOUT = 5000;\n');

      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          `Read the file at ${filePath}, then use the edit tool to change the TIMEOUT value from 5000 to 10000. ` +
          "Do NOT use bash or write. Do NOT call write_handoff. After editing, stop.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      const updated = fs.readFileSync(filePath, "utf-8");
      expect(updated).toContain("10000");
      expect(updated).not.toContain("5000");

      expect(toolWasUsed(events, "read")).toBe(true);
      expect(toolWasUsed(events, "edit")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("uses text_search to find a pattern across files", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, "a.ts"), 'export function fetchData() { return "data"; }\n');
      fs.writeFileSync(path.join(srcDir, "b.ts"), 'export function processData() { return null; }\n');
      fs.writeFileSync(path.join(srcDir, "c.ts"), 'export const VERSION = "1.0.0";\n');

      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          `Search the directory ${srcDir} for files containing the word "Data" (case-insensitive). ` +
          "Use the text_search tool with case_insensitive: true. " +
          "Do NOT use bash, grep, or rg. Do NOT call write_handoff. " +
          "Report which files matched, then stop.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      expect(toolWasUsed(events, "text_search")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("uses todo_list to track multi-step work", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          "You have a 3-step task: (1) create a file hello.txt with 'hello', " +
          "(2) create a file world.txt with 'world', (3) create a file done.txt with 'done'. " +
          "First, create a todo list tracking these 3 steps using todo_list(write). " +
          "Then complete each step using the write tool, marking each todo complete as you go. " +
          "Do NOT use bash. Do NOT call write_handoff.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      expect(fs.existsSync(path.join(tmpDir, "hello.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "world.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "done.txt"))).toBe(true);

      expect(toolWasUsed(events, "todo_list")).toBe(true);
      expect(toolWasUsed(events, "write")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("uses bash with cwd parameter", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const subDir = path.join(tmpDir, "subproject");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "marker.txt"), "found-me");

      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          `List the files in ${subDir} using bash with the cwd parameter set to "${subDir}". ` +
          "Use: bash(command=\"ls\", cwd=\"" + subDir + "\"). " +
          "Do NOT call write_handoff. Report what you find, then stop.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      expect(toolWasUsed(events, "bash")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("write tool blocks overwriting existing files", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const filePath = path.join(tmpDir, "existing.txt");
      fs.writeFileSync(filePath, "original content");

      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          `Try to overwrite the file at ${filePath} using the write tool with content 'overwritten'. ` +
          "The write tool should reject this because the file already exists. " +
          "After the rejection, use read and edit to change the content to 'modified via edit' instead. " +
          "Do NOT use bash. Do NOT call write_handoff.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("modified via edit");

      expect(toolWasUsed(events, "write")).toBe(true);
      expect(toolWasUsed(events, "edit")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("edit tool enforces read-before-edit", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-tool-test-");
    try {
      const filePath = path.join(tmpDir, "guarded.txt");
      fs.writeFileSync(filePath, "line one\nline two\nline three\n");

      const modelsClient = createModelsClient();
      const client = createClient(MODEL, modelsClient);
      const events: StreamEvent[] = [];

      const result = await runAgentLoop({
        client,
        tools: getToolDefinitions(),
        systemPrompt: makeSystemPrompt(MODEL),
        instruction:
          `Change "line two" to "line TWO" in ${filePath}. ` +
          "You must read the file first to get LINE#HASH references, then use edit. " +
          "Do NOT use bash or write. Do NOT call write_handoff.",
        cwd: tmpDir,
        signal: AbortSignal.timeout(TIMEOUT),
        onEvent: (e) => events.push(e),
      });

      expect(result.outcome).toBe("ok");

      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("line TWO");
      expect(content).toContain("line one");
      expect(content).toContain("line three");

      const toolNames = getToolNames(events);
      const readIdx = toolNames.indexOf("read");
      const editIdx = toolNames.indexOf("edit");
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(editIdx).toBeGreaterThan(readIdx);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
