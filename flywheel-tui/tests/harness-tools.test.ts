import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bashDefinition, createBashDefinition } from "../src/orchestration/engines/providers/harness/tools/bash.js";
import { writeHandoffDefinition, createHandoffDefinition } from "../src/orchestration/engines/providers/harness/tools/write-handoff.js";
import { readDefinition, createReadDefinition, type ReadOperations } from "../src/orchestration/engines/providers/harness/tools/read.js";
import { todoListDefinition, executeTodoList } from "../src/orchestration/engines/providers/harness/tools/todo-list.js";
import { executeTool, getToolDefinitions } from "../src/orchestration/engines/providers/harness/tools/tool-dispatch.js";
import { limitOutput } from "../src/orchestration/engines/providers/harness/context/truncation.js";
import { computeLineHash, formatLineTag, formatHashLines } from "../src/orchestration/engines/providers/harness/tools/hashline.js";
import type { ToolContext, BashOperations, BunSubprocessLike, HandoffOperations } from "../src/orchestration/engines/providers/harness/tools/types.js";

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
      const result = await bashDefinition.execute({ command: "sleep 0.5", timeout: 0.1 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    }, 5_000);

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

  // --- hashline ---

  describe("hashline", () => {
    it("produces stable 2-char hashes", () => {
      const hash1 = computeLineHash(1, "hello world");
      const hash2 = computeLineHash(1, "hello world");
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(2);
    });

    it("uses index as seed for non-significant lines", () => {
      // Whitespace-only lines use the index as seed, so most index pairs diverge.
      // Check a spread of indices to confirm the seed is mixed in (some pairs
      // may collide within the 256-entry hash space).
      const hashes = Array.from({ length: 20 }, (_, i) => computeLineHash(i + 1, "   "));
      const unique = new Set(hashes);
      // With 20 draws from 256 buckets, a random distribution gives ~19 unique.
      // We just need to confirm the seed actually varies the output.
      expect(unique.size).toBeGreaterThan(1);
    });

    it("formatLineTag produces LINENUM#HASH format", () => {
      const tag = formatLineTag(5, "const x = 1;");
      expect(tag).toMatch(/^5#[A-Z]{2}$/);
    });

    it("formatHashLines prefixes every line", () => {
      const result = formatHashLines("line one\nline two\nline three");
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
      expect(lines[0]).toMatch(/^1#[A-Z]{2}:line one$/);
      expect(lines[1]).toMatch(/^2#[A-Z]{2}:line two$/);
      expect(lines[2]).toMatch(/^3#[A-Z]{2}:line three$/);
    });
  });

  // --- read tool ---

  describe("read", () => {
    it("reads text file with hashline-prefixed lines", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "first line\nsecond line\nthird line");

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: filePath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/^1#[A-Z]{2}:first line/);
      expect(result.content).toContain("second line");
      expect(result.content).toContain("third line");
    });

    it("respects offset (0-based) and limit", async () => {
      const filePath = path.join(tmpDir, "lines.txt");
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"));

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute(
        { file_path: filePath, offset: 2, limit: 3 },
        ctx,
      );
      expect(result.isError).toBe(false);
      // offset=2 starts at line 3 (0-based offset, 1-indexed display)
      expect(result.content).toMatch(/3#[A-Z]{2}:line 3/);
      expect(result.content).toMatch(/4#[A-Z]{2}:line 4/);
      expect(result.content).toMatch(/5#[A-Z]{2}:line 5/);
      expect(result.content).not.toContain("line 2\n");
      expect(result.content).not.toContain(":line 6");
      expect(result.content).toContain("Starting from line 3");
      expect(result.content).toContain("more line");
    });

    it("shows truncation message for large files", async () => {
      const filePath = path.join(tmpDir, "big.txt");
      const lines = Array.from({ length: 3000 }, (_, i) => `line number ${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"));

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: filePath }, ctx);
      expect(result.isError).toBe(false);
      // Default limit is 2000
      expect(result.content).toContain("more line");
      expect(result.content).toContain("offset=2000");
    });

    it("detects binary files and returns error", async () => {
      const filePath = path.join(tmpDir, "binary.dat");
      const buf = Buffer.alloc(100);
      buf[50] = 0; // null byte
      buf.write("some text", 0);
      fs.writeFileSync(filePath, buf);

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: filePath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("binary");
    });

    it("reads PNG file and returns base64", async () => {
      const imgPath = path.join(tmpDir, "test.png");
      const TINY_PNG = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      );
      fs.writeFileSync(imgPath, TINY_PNG);

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("data:image/png;base64,");
    });

    it("reads JPG file and returns base64", async () => {
      const imgPath = path.join(tmpDir, "test.jpg");
      // Minimal JFIF header
      const jpgBuf = Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
        0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
        0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
      ]);
      fs.writeFileSync(imgPath, jpgBuf);

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("data:image/jpeg;base64,");
    });

    it("treats non-image extensions as text even if binary", async () => {
      // .bmp is not a recognized image extension, so read treats it as text.
      // Binary detection catches the null bytes.
      const binPath = path.join(tmpDir, "test.bmp");
      const buf = Buffer.alloc(100);
      buf[10] = 0; // null byte triggers binary detection
      fs.writeFileSync(binPath, buf);

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: binPath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("binary");
    });

    it("rejects images over 20MB", async () => {
      const imgPath = path.join(tmpDir, "large.png");
      const fd = fs.openSync(imgPath, "w");
      fs.ftruncateSync(fd, 21 * 1024 * 1024);
      fs.closeSync(fd);

      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({ file_path: imgPath }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("too large");
    });

    it("returns error for missing file_path parameter", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute({}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("requires a string 'file_path' parameter");
    });

    it("returns error for nonexistent file", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await readDefinition.execute(
        { file_path: path.join(tmpDir, "does-not-exist.txt") },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to read");
    });

    it("accepts mock readFile operations", async () => {
      const mockOps: ReadOperations = {
        readFile: async () => ({
          size: 20,
          arrayBuffer: async () => new TextEncoder().encode("mock line 1\nmock line 2").buffer as ArrayBuffer,
        }),
        resizeImage: async () => null,
      };

      const def = createReadDefinition({ operations: mockOps });
      const ctx = makeContext({ cwd: tmpDir });
      const result = await def.execute({ file_path: "/mock/file.txt" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("mock line 1");
      expect(result.content).toContain("mock line 2");
      expect(result.content).toMatch(/^1#[A-Z]{2}:mock line 1/);
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
      expect(result.content).toContain("[ ] Task A");
      expect(result.content).toContain("[~] Task B");
      expect(result.content).toContain("[x] Task C");
      expect(result.content).toContain("(high)");
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

    it("formats abandoned items with [!] prefix", () => {
      const ctx = makeContext();
      executeTodoList({
        operation: "write",
        todos: [
          { content: "Blocked task", status: "abandoned" },
          { content: "Active task", status: "in_progress" },
        ],
      }, ctx);

      const result = executeTodoList({ operation: "read" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("[!] Blocked task");
      expect(result.content).toContain("[~] Active task");
    });

    it("description mentions two-call protocol", () => {
      expect(todoListDefinition.description).toContain("twice per task");
      expect(todoListDefinition.description).toContain("in_progress");
      expect(todoListDefinition.description).toContain("completed");
      expect(todoListDefinition.description).toContain("context recovery");
    });

    it("input_schema includes abandoned in status enum", () => {
      const items = (todoListDefinition.input_schema as Record<string, unknown>).properties as Record<string, unknown>;
      const todos = items.todos as Record<string, unknown>;
      const itemSchema = (todos.items as Record<string, unknown>).properties as Record<string, unknown>;
      const status = itemSchema.status as Record<string, unknown>;
      expect(status.enum).toContain("abandoned");
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

  // --- enriched definitions + Map dispatch ---

  describe("enriched ToolDefinition with execute", () => {
    const allDefinitions = [bashDefinition, writeHandoffDefinition, readDefinition, todoListDefinition];

    it("every definition has name, description, input_schema, and execute", () => {
      for (const def of allDefinitions) {
        expect(typeof def.name).toBe("string");
        expect(def.name.length).toBeGreaterThan(0);
        expect(typeof def.description).toBe("string");
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.input_schema).toBeDefined();
        expect(typeof def.input_schema).toBe("object");
        expect(typeof def.execute).toBe("function");
      }
    });

    it("bash description is substantive, not a stub", () => {
      expect(bashDefinition.description.length).toBeGreaterThan(50);
      expect(bashDefinition.description).toContain("isolated");
      expect(bashDefinition.description).toContain("do not persist");
      expect(bashDefinition.description).toContain("background");
      expect(bashDefinition.description).toContain("timeout");
    });

    it("executeTool dispatches via definition.execute for all 4 tools", async () => {
      const ctx = makeContext({ cwd: tmpDir });

      const bashResult = await executeTool("bash", { command: "echo registry-test" }, ctx);
      expect(bashResult.isError).toBe(false);
      expect(bashResult.content).toContain("registry-test");

      const todoResult = await executeTool("todo_list", { operation: "read" }, ctx);
      expect(todoResult.isError).toBe(false);
      expect(todoResult.content).toBe("Todo list is empty.");

      const readResult2 = await executeTool("read", { file_path: "/nonexistent.txt" }, ctx);
      expect(readResult2.isError).toBe(true);
      expect(readResult2.content).toContain("Failed to read");

      const handoffResult = await executeTool("write_handoff", { summary: "test" }, makeContext());
      expect(handoffResult.isError).toBe(true);
      expect(handoffResult.content).toContain("No handoff path");
    });

    it("unknown tool returns explicit error with available tool names", async () => {
      const ctx = makeContext();
      const result = await executeTool("bogus_tool", {}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown tool 'bogus_tool'");
      expect(result.content).toContain("bash");
      expect(result.content).toContain("write_handoff");
      expect(result.content).toContain("read");
      expect(result.content).toContain("todo_list");
    });

    it("bash execute validates input.command is a string", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: 123 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("bash requires a string 'command' parameter");
    });

    it("bash execute coerces input.timeout to number", async () => {
      const ctx = makeContext({ cwd: tmpDir });
      const result = await bashDefinition.execute({ command: "echo fast", timeout: 10 }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("fast");
    });

    it("todoList.execute shares the same mutable todoList reference across calls", async () => {
      const ctx = makeContext();
      await todoListDefinition.execute(
        { operation: "write", todos: [{ content: "Shared ref test", status: "pending" }] },
        ctx,
      );
      expect(ctx.todoList.length).toBe(1);
      expect(ctx.todoList[0].content).toBe("Shared ref test");

      const readResult = await todoListDefinition.execute({ operation: "read" }, ctx);
      expect(readResult.content).toContain("Shared ref test");
    });

    it("getToolDefinitions returns all registered tools", () => {
      const defs = getToolDefinitions();
      expect(defs.length).toBe(4);
      const names = defs.map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(["bash", "write_handoff", "read", "todo_list"]));
    });
  });

  // --- factory DI with mock operations ---

  describe("createBashDefinition with mock operations", () => {
    function makeMockSubprocess(overrides?: Partial<BunSubprocessLike>): BunSubprocessLike {
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("mock output\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        pid: 12345,
        kill: () => {},
        ...overrides,
      };
    }

    it("uses injected spawn and writeScript operations", async () => {
      const spawnCalls: { cmd: string[]; cwd: string }[] = [];
      const writeCalls: { path: string; content: string }[] = [];
      const deleteCalls: string[] = [];

      const mockOps: BashOperations = {
        spawn(cmd, opts) {
          spawnCalls.push({ cmd, cwd: opts.cwd });
          return makeMockSubprocess();
        },
        async writeScript(p, content) {
          writeCalls.push({ path: p, content });
          return content.length;
        },
        async deleteScript(p) {
          deleteCalls.push(p);
        },
      };

      const def = createBashDefinition({ operations: mockOps });
      const ctx = makeContext({ cwd: "/mock/cwd" });
      const result = await def.execute({ command: "echo hello" }, ctx);

      expect(result.isError).toBe(false);
      expect(result.content).toContain("mock output");
      expect(result.content).toContain("[exit code: 0]");
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0]!.cwd).toBe("/mock/cwd");
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0]!.path).toMatch(/^\/tmp\/flywheel-harness-/);
      expect(deleteCalls.length).toBe(1);
    });

    it("still validates interactive commands with mock operations", async () => {
      const mockOps: BashOperations = {
        spawn: () => makeMockSubprocess(),
        writeScript: async () => 0,
        deleteScript: async () => {},
      };

      const def = createBashDefinition({ operations: mockOps });
      const ctx = makeContext({ cwd: "/mock" });
      const result = await def.execute({ command: "vim file.txt" }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Interactive command detected");
    });

    it("handles non-zero exit codes from mock subprocess", async () => {
      const mockOps: BashOperations = {
        spawn: () => makeMockSubprocess({
          exitCode: 1,
          exited: Promise.resolve(1),
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("error: something failed\n"));
              controller.close();
            },
          }),
        }),
        writeScript: async () => 0,
        deleteScript: async () => {},
      };

      const def = createBashDefinition({ operations: mockOps });
      const ctx = makeContext({ cwd: "/mock" });
      const result = await def.execute({ command: "failing-command" }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("error: something failed");
      expect(result.content).toContain("[exit code: 1]");
    });

    it("handles background commands with mock spawn", async () => {
      const mockOps: BashOperations = {
        spawn: () => makeMockSubprocess({
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("99999\n"));
              controller.close();
            },
          }),
        }),
        writeScript: async () => 0,
        deleteScript: async () => {},
      };

      const def = createBashDefinition({ operations: mockOps });
      const ctx = makeContext({ cwd: "/mock" });
      const result = await def.execute({ command: "sleep 100 &" }, ctx);

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Started in background");
      expect(result.content).toContain("PID: 99999");
    });

    it("validates command parameter type", async () => {
      const def = createBashDefinition({ operations: {
        spawn: () => makeMockSubprocess(),
        writeScript: async () => 0,
        deleteScript: async () => {},
      }});
      const ctx = makeContext({ cwd: "/mock" });
      const result = await def.execute({ command: 42 }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("bash requires a string 'command' parameter");
    });
  });

  describe("createHandoffDefinition with mock operations", () => {
    it("uses injected writeFile operation", async () => {
      const writeCalls: { path: string; content: string }[] = [];

      const mockOps: HandoffOperations = {
        async writeFile(p, content) {
          writeCalls.push({ path: p, content });
          return content.length;
        },
      };

      const def = createHandoffDefinition({ operations: mockOps });
      const ctx = makeContext({ handoffPath: "/mock/handoff.json" });
      const result = await def.execute({ summary: "work done" }, ctx);

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Handoff written");
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0]!.path).toBe("/mock/handoff.json");
      const parsed = JSON.parse(writeCalls[0]!.content);
      expect(parsed.summary).toBe("work done");
    });

    it("validates dispatcher fields before calling writeFile", async () => {
      const writeCalls: string[] = [];

      const mockOps: HandoffOperations = {
        async writeFile(p) {
          writeCalls.push(p);
          return 0;
        },
      };

      const def = createHandoffDefinition({ operations: mockOps });
      const ctx = makeContext({ handoffPath: "/mock/handoff.json" });
      const result = await def.execute({
        schema_version: 1,
        // missing step_index, task_content, context_files
      }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("missing required fields");
      expect(writeCalls.length).toBe(0);
    });

    it("returns error when no handoff path even with mock ops", async () => {
      const def = createHandoffDefinition({ operations: {
        writeFile: async () => 0,
      }});
      const ctx = makeContext();
      const result = await def.execute({ summary: "test" }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("No handoff path");
    });

    it("reports writeFile errors", async () => {
      const def = createHandoffDefinition({ operations: {
        async writeFile() {
          throw new Error("disk full");
        },
      }});
      const ctx = makeContext({ handoffPath: "/mock/handoff.json" });
      const result = await def.execute({ summary: "test" }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Failed to write handoff");
      expect(result.content).toContain("disk full");
    });
  });
});
