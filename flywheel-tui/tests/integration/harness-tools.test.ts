import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bashDefinition } from "../../src/orchestration/engines/providers/harness/tools/bash.js";
import { writeHandoffDefinition } from "../../src/orchestration/engines/providers/harness/tools/write-handoff.js";
import { readDefinition } from "../../src/orchestration/engines/providers/harness/tools/read.js";
import { executeTodoList } from "../../src/orchestration/engines/providers/harness/tools/todo-list.js";
import { executeTool, getToolDefinitions } from "../../src/orchestration/engines/providers/harness/tools/tool-dispatch.js";
import { limitOutput } from "../../src/orchestration/engines/providers/harness/context/truncation.js";
import type { ToolContext } from "../../src/orchestration/engines/providers/harness/tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: os.tmpdir(),
    todoList: [],
    ...overrides,
  };
}

describe("harness tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- bash ---

  describe("bash", () => {
    it("executes command and returns stdout + exit code", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: "echo hello world" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("hello world");
      expect(result.content).toContain("[exit code: 0]");
    });

    it("returns error for non-zero exit", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: "exit 42" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("[exit code: 42]");
    });

    it("times out and returns error", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: "sleep 10", timeout: 1 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    }, 15_000);

    it("rejects interactive commands", async () => {
      const ctx = makeContext({ cwd: tmpDir });

      const vim = await bashDefinition.execute({ command: "vim file.txt" }, ctx);
      expect(vim.isError).toBe(true);
      expect(vim.content).toContain("Interactive command detected");

      const less = await bashDefinition.execute({ command: "less output.log" }, ctx);
      expect(less.isError).toBe(true);
      expect(less.content).toContain("Interactive command detected");

      const python = await bashDefinition.execute({ command: "python" }, ctx);
      expect(python.isError).toBe(true);
      expect(python.content).toContain("Interactive command detected");
    });

    it("runs background commands", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: "echo bg-test &" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Started in background");
      expect(result.content).toContain("PID:");
    });

    it("returns aborted when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = makeContext({ cwd: tmpDir, signal: controller.signal });
      const result = await bashDefinition.execute({ command: "echo should not run" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Aborted");
    });
  });

  // --- write_handoff ---

  describe("write_handoff", () => {
    it("writes worker-shaped handoff", async () => {
      const handoffPath = path.join(tmpDir, "handoff.json");
      const ctx = makeContext({ handoffPath });
      const result = await writeHandoffDefinition.execute({
        summary: "Completed the work successfully with all tests passing and features implemented.",
        key_changes: ["added feature X"],
        remaining_work: [],
        confidence: 0.9,
      }, ctx);

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Handoff written");
      expect(fs.existsSync(handoffPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(handoffPath, "utf-8"));
      expect(written.summary).toContain("Completed the work");
      expect(written.confidence).toBe(0.9);
    });

    it("writes dispatcher-shaped handoff", async () => {
      const handoffPath = path.join(tmpDir, "dispatcher-handoff.json");
      const ctx = makeContext({ handoffPath });
      const result = await writeHandoffDefinition.execute({
        schema_version: 1,
        step_index: 0,
        task_content: "Create a hello world file",
        context_files: ["src/index.ts"],
        evaluation_criteria: {
          acceptance_criteria: ["File exists"],
          required_tests: false,
          custom_checks: [],
          required_outputs: [],
        },
      }, ctx);

      expect(result.isError).toBe(false);
      const written = JSON.parse(fs.readFileSync(handoffPath, "utf-8"));
      expect(written.schema_version).toBe(1);
      expect(written.task_content).toBe("Create a hello world file");
    });

    it("returns error when no handoff path configured", async () => {
      const ctx = makeContext();
      const result = await writeHandoffDefinition.execute({
        summary: "A valid summary that meets the minimum length requirement for handoff.",
        key_changes: [],
        remaining_work: [],
        confidence: 0.5,
      }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("No handoff path");
    });
  });

  // --- read ---

  describe("read", () => {
    it("reads a valid PNG image", async () => {
      const imgPath = path.join(tmpDir, "test.png");
      const TINY_PNG = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(imgPath, TINY_PNG);

      const ctx = makeContext();
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("data:image/png;base64,");
    });

    it("rejects unsupported image format", async () => {
      const imgPath = path.join(tmpDir, "test.bmp");
      fs.writeFileSync(imgPath, Buffer.from([0x42, 0x4D]));

      const ctx = makeContext();
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unsupported image format");
    });

    it("rejects images over 20MB", async () => {
      const imgPath = path.join(tmpDir, "large.png");
      const fd = fs.openSync(imgPath, "w");
      fs.ftruncateSync(fd, 21 * 1024 * 1024);
      fs.closeSync(fd);

      const ctx = makeContext();
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("too large");
    });

    it("returns error for missing file_path parameter", async () => {
      const ctx = makeContext();
      const result = await readDefinition.execute({}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("requires a string 'file_path' parameter");
    });

    it("reads text file with hashline-prefixed lines", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello\nworld");

      const ctx = makeContext();
      const result = await readDefinition.execute({ file_path: filePath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/^1#[A-Z]{2}:hello/);
      expect(result.content).toMatch(/2#[A-Z]{2}:world/);
    });
  });

  // --- todo_list ---

  describe("todo_list", () => {
    it("read returns empty list message", () => {
      const ctx = makeContext();
      const result = executeTodoList({ operation: "read" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Todo list is empty.");
    });

    it("write replaces list and read returns current state", () => {
      const ctx = makeContext();
      executeTodoList({
        operation: "write",
        todos: [
          { content: "Task A", status: "pending" },
          { content: "Task B", status: "in_progress", priority: "high" },
          { content: "Task C", status: "completed" },
        ],
      }, ctx);

      const result = executeTodoList({ operation: "read" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Task A");
      expect(result.content).toContain("Task B");
      expect(result.content).toContain("Task C");
      expect(result.content).toContain("in_progress");
    });

    it("enforces max 50 items", () => {
      const ctx = makeContext();
      const todos = Array.from({ length: 60 }, (_, i) => ({
        content: `Item ${i}`,
        status: "pending" as const,
      }));

      executeTodoList({ operation: "write", todos }, ctx);
      expect(ctx.todoList.length).toBe(50);
    });

    it("enforces max 500 char content", () => {
      const ctx = makeContext();
      const longContent = "x".repeat(600);
      executeTodoList({
        operation: "write",
        todos: [{ content: longContent, status: "pending" }],
      }, ctx);

      expect(ctx.todoList[0].content.length).toBe(500);
    });

    it("write atomically replaces list", () => {
      const ctx = makeContext();
      executeTodoList({
        operation: "write",
        todos: [
          { content: "First", status: "pending" },
          { content: "Second", status: "pending" },
        ],
      }, ctx);
      expect(ctx.todoList.length).toBe(2);

      executeTodoList({
        operation: "write",
        todos: [{ content: "Only", status: "completed" }],
      }, ctx);
      expect(ctx.todoList.length).toBe(1);
      expect(ctx.todoList[0].content).toBe("Only");
    });

    it("rejects unknown operation", () => {
      const ctx = makeContext();
      const result = executeTodoList({ operation: "delete" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown operation");
    });

    it("rejects write without todos array", () => {
      const ctx = makeContext();
      const result = executeTodoList({ operation: "write" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("requires a 'todos' array");
    });
  });

  // --- output truncation ---

  describe("output truncation", () => {
    it("returns original for small output", async () => {
      const result = await limitOutput("hello world");
      expect(result.text).toBe("hello world");
      expect(result.truncated).toBe(false);
    });

    it("keeps first + last portions for large output", async () => {
      const large = "A".repeat(15_000) + "MIDDLE".repeat(5_000) + "Z".repeat(15_000);
      const result = await limitOutput(large);
      expect(result.truncated).toBe(true);
      expect(result.text).toContain("A".repeat(100));
      expect(result.text).toContain("Z".repeat(100));
      expect(result.text).toContain("truncated");
      expect(result.text).toContain("bytes omitted");
    });
  });

  // --- tool dispatch ---

  describe("tool dispatch", () => {
    it("returns definitions for all tools", () => {
      const defs = getToolDefinitions();
      const names = defs.map((d) => d.name);
      expect(names).toContain("bash");
      expect(names).toContain("write_handoff");
      expect(names).toContain("read");
      expect(names).toContain("todo_list");
    });

    it("dispatches known tools correctly", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await executeTool("bash", { command: "echo dispatch-test" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("dispatch-test");
    });

    it("returns error for unknown tool", async () => {
      const ctx = makeContext();
      const result = await executeTool("nonexistent_tool", {}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown tool");
      expect(result.content).toContain("nonexistent_tool");
    });

    it("dispatches todo_list through dispatch table", async () => {
      const ctx = makeContext();
      const result = await executeTool("todo_list", { operation: "read" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("Todo list is empty.");
    });
  });
});
