/**
 * Bash tool — command execution, timeout, truncation, env filtering,
 * stderr capture, and exit code reporting.
 */

import { describe, it, expect } from "bun:test";
import { createBashTool, applyHeadTail } from "../../../src/harness/tools/bash.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultContext: ToolContext = {
  cwd: "/tmp",
  env: { ...process.env as Record<string, string> },
};

const bashTool = createBashTool();

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

describe("bash tool — basic execution", () => {
  it("executes a simple echo command", async () => {
    const result = await bashTool.execute(
      { command: "echo hello world" },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello world");
  });

  it("reports non-zero exit code", async () => {
    const result = await bashTool.execute(
      { command: "exit 42" },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code: 42");
  });

  it("captures stderr output", async () => {
    const result = await bashTool.execute(
      { command: "echo error-output >&2 && exit 1" },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("error-output");
  });

  it("handles commands with no output", async () => {
    const result = await bashTool.execute(
      { command: "true" },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("(no output)");
  });

  it("uses custom cwd when provided", async () => {
    const result = await bashTool.execute(
      { command: "pwd", cwd: "/tmp" },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();
    // macOS resolves /tmp -> /private/tmp
    expect(result.content).toMatch(/\/tmp/);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("bash tool — timeout", () => {
  it("kills long-running commands after timeout", async () => {
    const result = await bashTool.execute(
      { command: "sleep 30", timeout: 1 },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Output truncation (applyHeadTail)
// ---------------------------------------------------------------------------

describe("applyHeadTail", () => {
  it("returns short output unchanged", () => {
    const input = "line1\nline2\nline3";
    expect(applyHeadTail(input, 10, 10)).toBe(input);
  });

  it("truncates long output with head and tail sections", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    const input = lines.join("\n");

    const result = applyHeadTail(input, 5, 3);
    const outputLines = result.split("\n");

    // Head: 5 lines, marker: 1 line (with surrounding empty lines from join), tail: 3 lines
    expect(outputLines[0]).toBe("line 1");
    expect(outputLines[4]).toBe("line 5");
    expect(result).toContain("[...truncated 492 lines...]");
    expect(outputLines[outputLines.length - 1]).toBe("line 500");
  });

  it("clamps long individual lines", () => {
    const longLine = "x".repeat(1000);
    const result = applyHeadTail(longLine, 200, 100, 50);
    expect(result.length).toBeLessThan(1000);
    expect(result).toContain("(truncated)");
  });

  it("handles empty input", () => {
    expect(applyHeadTail("")).toBe("");
  });

  it("handles exact boundary (head+tail = total)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const input = lines.join("\n");
    // 5 head + 5 tail = 10 = total => no truncation
    expect(applyHeadTail(input, 5, 5)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Env filtering
// ---------------------------------------------------------------------------

describe("bash tool — env filtering", () => {
  it("strips sensitive API keys from the environment", async () => {
    const ctx: ToolContext = {
      cwd: "/tmp",
      env: {
        ...process.env as Record<string, string>,
        OPENAI_API_KEY: "sk-test-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        PATH: process.env.PATH ?? "/usr/bin",
        HOME: process.env.HOME ?? "/tmp",
      },
    };

    const result = await bashTool.execute(
      { command: "env" },
      ctx,
    );
    // The output should NOT contain the secret keys
    expect(result.content).not.toContain("sk-test-secret");
    expect(result.content).not.toContain("sk-ant-secret");
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("bash tool — metadata", () => {
  it("has correct name and concurrency", () => {
    expect(bashTool.name).toBe("bash");
    expect(bashTool.concurrency).toBe("exclusive");
  });

  it("description mentions forbidden operations", () => {
    const desc = bashTool.description;
    expect(desc).toContain("grep");
    expect(desc).toContain("cat");
    expect(desc).toContain("head");
    expect(desc).toContain("tail");
    expect(desc).toContain("sed");
    expect(desc).toContain("awk");
    expect(desc).toContain("find");
  });
});
