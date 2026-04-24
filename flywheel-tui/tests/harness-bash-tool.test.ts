import { describe, expect, test } from "bun:test";
import { createBashDefinition } from "../src/orchestration/engines/providers/harness/tools/bash.js";
import type { ToolContext, BashOperations, BunSubprocessLike } from "../src/orchestration/engines/providers/harness/tools/types.js";

function makeSuccessOps(): BashOperations {
  return {
    spawn: (_cmd, _opts): BunSubprocessLike => {
      const encoder = new TextEncoder();
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode("ok\n"));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exitCode: 0,
        pid: 1,
        kill: () => {},
      };
    },
    writeScript: async () => 0,
    deleteScript: async () => {},
  };
}

describe("bash tool timeout clamp", () => {
  test("clamps timeout above 3600s without error", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [], readFiles: new Set(), bgLogPaths: new Set() };

    const result = await bash.execute({ command: "echo hi", timeout: 7200 }, context);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ok");
  });

  test("allows timeout at or below 3600s", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [], readFiles: new Set(), bgLogPaths: new Set() };

    const result = await bash.execute({ command: "echo hi", timeout: 3600 }, context);
    expect(result.isError).toBe(false);
  });

  test("default timeout works without explicit timeout", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [], readFiles: new Set(), bgLogPaths: new Set() };

    const result = await bash.execute({ command: "echo hi" }, context);
    expect(result.isError).toBe(false);
  });
});

describe("bash interactive-command detection", () => {
  const runCommand = async (command: string): Promise<{ content: string; isError: boolean }> => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [], readFiles: new Set(), bgLogPaths: new Set() };
    return bash.execute({ command }, context);
  };

  test("blocks bare editor invocation", async () => {
    const result = await runCommand("vim file.txt");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit");
  });

  test("blocks editor after shell separator", async () => {
    const result = await runCommand("echo hi && vim file.txt");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit");
  });

  test("does not false-trigger on vi.fn in an inline script", async () => {
    const result = await runCommand("echo 'const x = vi.fn()'");
    expect(result.isError).toBe(false);
  });

  test("does not false-trigger on vitest identifier", async () => {
    const result = await runCommand("echo 'from vitest'");
    expect(result.isError).toBe(false);
  });

  test("does not false-trigger on words containing ed", async () => {
    const result = await runCommand("echo edited needed");
    expect(result.isError).toBe(false);
  });

  test("does not false-trigger on less/more substrings", async () => {
    const result = await runCommand("echo blessed moremoney");
    expect(result.isError).toBe(false);
  });
});

describe("bash interceptor routes to dedicated tools", () => {
  const runCommand = async (
    command: string,
    availableTools: ReadonlySet<string>,
  ): Promise<{ content: string; isError: boolean }> => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [], readFiles: new Set(), bgLogPaths: new Set(), availableTools };
    return bash.execute({ command }, context);
  };

  test("intercepts inline bun -e that reads files", async () => {
    const result = await runCommand(
      "bun -e 'const s = require(\"fs\").readFileSync(\"/tmp/x\", \"utf8\"); console.log(s)'",
      new Set(["edit", "read"]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit");
  });

  test("intercepts inline node -e that writes files", async () => {
    const result = await runCommand(
      "node -e 'require(\"fs\").writeFileSync(\"/tmp/x\", \"hi\")'",
      new Set(["edit", "write"]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit");
  });

  test("intercepts python -c with open() for file I/O", async () => {
    const result = await runCommand(
      "python3 -c 'open(\"/tmp/x\", \"w\").write(\"hi\")'",
      new Set(["edit", "write"]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit");
  });

  test("does not intercept bun -e without file I/O", async () => {
    const result = await runCommand(
      "bun -e 'console.log(1 + 1)'",
      new Set(["edit", "write"]),
    );
    expect(result.isError).toBe(false);
  });
});
