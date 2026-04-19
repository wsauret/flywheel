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
  test("clamps timeout above 300s without error", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [] };

    const result = await bash.execute({ command: "echo hi", timeout: 600 }, context);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ok");
  });

  test("allows timeout at or below 300s", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [] };

    const result = await bash.execute({ command: "echo hi", timeout: 300 }, context);
    expect(result.isError).toBe(false);
  });

  test("default timeout works without explicit timeout", async () => {
    const bash = createBashDefinition({ operations: makeSuccessOps() });
    const context: ToolContext = { cwd: "/tmp", todoList: [] };

    const result = await bash.execute({ command: "echo hi" }, context);
    expect(result.isError).toBe(false);
  });
});
