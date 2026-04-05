import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/harness/cli.js";

// ═══════════════════════════════════════════════════════════════════════════
// parseArgs
// ═══════════════════════════════════════════════════════════════════════════

describe("parseArgs", () => {
  it("extracts task message from positional args", () => {
    const result = parseArgs(["read package.json and tell me the project name"]);
    expect(result.task).toBe("read package.json and tell me the project name");
  });

  it("joins multiple positional args into a single task", () => {
    const result = parseArgs(["hello", "world", "test"]);
    expect(result.task).toBe("hello world test");
  });

  it("returns empty task when no positional args", () => {
    const result = parseArgs([]);
    expect(result.task).toBe("");
  });

  it("parses --model flag", () => {
    const result = parseArgs(["some task", "--model", "claude-opus-4-6"]);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.task).toBe("some task");
  });

  it("defaults model to claude-sonnet-4-6", () => {
    const result = parseArgs(["task"]);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("parses --max-turns flag", () => {
    const result = parseArgs(["task", "--max-turns", "50"]);
    expect(result.maxTurns).toBe(50);
  });

  it("defaults max-turns to 100", () => {
    const result = parseArgs(["task"]);
    expect(result.maxTurns).toBe(100);
  });

  it("parses --max-tokens flag", () => {
    const result = parseArgs(["task", "--max-tokens", "8192"]);
    expect(result.maxTokens).toBe(8192);
  });

  it("defaults max-tokens to 16384", () => {
    const result = parseArgs(["task"]);
    expect(result.maxTokens).toBe(16384);
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["task", "--verbose"]);
    expect(result.verbose).toBe(true);
  });

  it("parses -v shorthand for verbose", () => {
    const result = parseArgs(["task", "-v"]);
    expect(result.verbose).toBe(true);
  });

  it("defaults verbose to false", () => {
    const result = parseArgs(["task"]);
    expect(result.verbose).toBe(false);
  });

  it("parses --thinking flag with effort level", () => {
    const result = parseArgs(["task", "--thinking", "medium"]);
    expect(result.thinking).toBe("medium");
  });

  it("defaults thinking to high", () => {
    const result = parseArgs(["task"]);
    expect(result.thinking).toBe("high");
  });

  it("disables thinking with --thinking off", () => {
    const result = parseArgs(["task", "--thinking", "off"]);
    expect(result.thinking).toBeNull();
  });

  it("disables thinking with --thinking 0", () => {
    const result = parseArgs(["task", "--thinking", "0"]);
    expect(result.thinking).toBeNull();
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("parses -h shorthand for help", () => {
    const result = parseArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  it("defaults help to false", () => {
    const result = parseArgs(["task"]);
    expect(result.help).toBe(false);
  });

  it("handles all flags together", () => {
    const result = parseArgs([
      "do the thing",
      "--model", "claude-opus-4-6",
      "--max-turns", "20",
      "--max-tokens", "4096",
      "--verbose",
      "--thinking", "max",
    ]);
    expect(result.task).toBe("do the thing");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.maxTurns).toBe(20);
    expect(result.maxTokens).toBe(4096);
    expect(result.verbose).toBe(true);
    expect(result.thinking).toBe("max");
  });

  it("handles flags interspersed with positional args", () => {
    const result = parseArgs(["hello", "--verbose", "world"]);
    expect(result.task).toBe("hello world");
    expect(result.verbose).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error cases
// ═══════════════════════════════════════════════════════════════════════════

describe("parseArgs error handling", () => {
  it("throws on unknown flags", () => {
    expect(() => parseArgs(["task", "--unknown"])).toThrow("Unknown flag: --unknown");
  });

  it("throws on unknown short flags", () => {
    expect(() => parseArgs(["task", "-x"])).toThrow("Unknown flag: -x");
  });

  it("throws when --model has no value", () => {
    expect(() => parseArgs(["task", "--model"])).toThrow("--model requires a value");
  });

  it("throws when --model value starts with -", () => {
    expect(() => parseArgs(["task", "--model", "--verbose"])).toThrow("--model requires a value");
  });

  it("throws when --max-turns has no value", () => {
    expect(() => parseArgs(["task", "--max-turns"])).toThrow("--max-turns requires a value");
  });

  it("throws when --max-turns is not a number", () => {
    expect(() => parseArgs(["task", "--max-turns", "abc"])).toThrow("--max-turns must be a positive integer");
  });

  it("throws when --max-turns is zero", () => {
    expect(() => parseArgs(["task", "--max-turns", "0"])).toThrow("--max-turns must be a positive integer");
  });

  it("throws when --max-tokens has no value", () => {
    expect(() => parseArgs(["task", "--max-tokens"])).toThrow("--max-tokens requires a value");
  });

  it("throws when --max-tokens is not a number", () => {
    expect(() => parseArgs(["task", "--max-tokens", "abc"])).toThrow("--max-tokens must be a positive integer");
  });

  it("throws when --thinking has no value", () => {
    expect(() => parseArgs(["task", "--thinking"])).toThrow("--thinking requires an effort level");
  });

  it("throws when --thinking is not a valid effort level", () => {
    expect(() => parseArgs(["task", "--thinking", "abc"])).toThrow("--thinking must be one of");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runCli integration (env / help / missing task)
// ═══════════════════════════════════════════════════════════════════════════

describe("runCli", () => {
  it("--help prints usage text without errors", async () => {
    // Capture console.log output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    // Import and call runCli — --help should return without calling process.exit
    const { runCli } = await import("../../src/harness/cli.js");

    // runCli with --help should not exit (returns normally)
    await runCli(["--help"]);

    console.log = originalLog;

    const output = logs.join("\n");
    expect(output).toContain("Usage: bin/harness");
    expect(output).toContain("--model");
    expect(output).toContain("--verbose");
    expect(output).toContain("--thinking");
  });
});
