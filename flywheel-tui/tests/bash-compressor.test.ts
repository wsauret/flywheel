import { afterEach, describe, expect, it } from "bun:test";
import { compressBashOutput } from "../src/orchestration/engines/providers/harness/tools/bash-compressor.js";

describe("bash output compressor", () => {
  const savedRawOutput = process.env.FLYWHEEL_RAW_OUTPUT;

  afterEach(() => {
    if (savedRawOutput === undefined) delete process.env.FLYWHEEL_RAW_OUTPUT;
    else process.env.FLYWHEEL_RAW_OUTPUT = savedRawOutput;
  });

  describe("test runner detection", () => {
    function buildTestOutput(): string {
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) lines.push(`✓ passing test ${i}`);
      lines.push("✗ one test fails");
      lines.push("  Expected: 1");
      lines.push("20 pass, 1 fail");
      return lines.join("\n");
    }

    it("detects bun test as test runner", () => {
      const result = compressBashOutput("bun test", buildTestOutput());
      expect(result.compressed).toBe(true);
    });

    it("detects bun run test as test runner", () => {
      const result = compressBashOutput("bun run test", buildTestOutput());
      expect(result.compressed).toBe(true);
    });

    it("detects jest as test runner", () => {
      const result = compressBashOutput("jest", buildTestOutput());
      expect(result.compressed).toBe(true);
    });

    it("detects npx vitest as test runner", () => {
      const result = compressBashOutput("npx vitest", buildTestOutput());
      expect(result.compressed).toBe(true);
    });

    it("detects pytest as test runner", () => {
      const result = compressBashOutput("pytest", buildTestOutput());
      expect(result.compressed).toBe(true);
    });
  });

  describe("test runner compression", () => {
    it("keeps failure lines and strips passing tests", () => {
      const lines: string[] = [];
      for (let i = 0; i < 15; i++) lines.push(`✓ passing test ${i}`);
      lines.push("✗ test four breaks");
      lines.push("  Expected: 42");
      lines.push("  Received: 0");
      lines.push("    at test.ts:10:5");
      lines.push("✓ another passing one");
      lines.push("15 pass, 1 fail");

      const result = compressBashOutput("bun run test", lines.join("\n"));
      expect(result.compressed).toBe(true);
      expect(result.output).toContain("test four breaks");
      expect(result.output).toContain("Expected: 42");
      expect(result.output).toContain("Received: 0");
      expect(result.output).toContain("15 pass, 1 fail");
      expect(result.output).not.toContain("passing test 0");
    });

    it("does not compress test output with no failures", () => {
      const output = [
        "✓ test one",
        "✓ test two",
        "2 pass, 0 fail",
      ].join("\n");
      const result = compressBashOutput("bun run test", output);
      expect(result.compressed).toBe(false);
    });

    it("includes context lines before failure", () => {
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) lines.push(`✓ passing test ${i}`);
      lines.push("✗ this test fails");
      lines.push("  Expected: true");
      lines.push("1 pass, 1 fail");

      const result = compressBashOutput("bun run test", lines.join("\n"));
      expect(result.compressed).toBe(true);
      expect(result.output).toContain("passing test 16");
      expect(result.output).toContain("passing test 17");
      expect(result.output).toContain("passing test 18");
      expect(result.output).toContain("passing test 19");
      expect(result.output).not.toContain("passing test 10");
    });
  });

  describe("generic compression", () => {
    it("compresses generic output over 200 lines", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
      const result = compressBashOutput("ls -la", lines.join("\n"));
      expect(result.compressed).toBe(true);
      expect(result.output).toContain("line 1");
      expect(result.output).toContain("line 30");
      expect(result.output).toContain("line 300");
      expect(result.output).toContain("lines omitted");
      expect(result.compressedLines).toBeLessThan(300);
    });

    it("preserves error lines in generic compression", () => {
      const lines = Array.from({ length: 300 }, (_, i) => {
        if (i === 150) return "ERROR: something broke";
        if (i === 200) return "Warning: deprecated API";
        return `line ${i + 1}`;
      });
      const result = compressBashOutput("make build", lines.join("\n"));
      expect(result.compressed).toBe(true);
      expect(result.output).toContain("ERROR: something broke");
      expect(result.output).toContain("Warning: deprecated API");
    });

    it("does not compress short output", () => {
      const output = "hello\nworld\n";
      const result = compressBashOutput("echo hello", output);
      expect(result.compressed).toBe(false);
      expect(result.output).toBe(output);
    });
  });

  describe("bypass", () => {
    it("bypasses compression when FLYWHEEL_RAW_OUTPUT=1", () => {
      process.env.FLYWHEEL_RAW_OUTPUT = "1";
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
      const result = compressBashOutput("ls -la", lines.join("\n"));
      expect(result.compressed).toBe(false);
    });
  });

  describe("compression notice", () => {
    it("includes compression notice when compressed", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
      const result = compressBashOutput("ls -la", lines.join("\n"));
      expect(result.output).toMatch(/\[Output compressed: 300 lines -> \d+ lines \(\d+% reduction\)\]/);
    });

    it("does not include compression notice when not compressed", () => {
      const result = compressBashOutput("echo hi", "hello");
      expect(result.output).not.toContain("Output compressed");
    });
  });
});
