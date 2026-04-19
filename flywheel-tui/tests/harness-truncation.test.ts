import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { limitOutput, cleanupHarnessOutputs } from "../src/orchestration/engines/providers/harness/context/truncation.js";

describe("limitOutput", () => {
  const testDir = join("/tmp", `harness-truncation-test-${Date.now()}`);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns original output when under 30KB", async () => {
    const output = "short output";
    const result = await limitOutput(output);
    expect(result.text).toBe(output);
    expect(result.truncated).toBe(false);
  });

  test("truncates output over 30KB with first/last halves", async () => {
    const output = "A".repeat(50_000);
    const result = await limitOutput(output, undefined, testDir);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated:");
    expect(result.text).toContain("bytes omitted");
    expect(result.text.length).toBeLessThan(output.length);
  });

  test("does not allocate buffer for short output", async () => {
    const output = "hello";
    const result = await limitOutput(output);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  test("saves full output to per-session subdirectory when truncated", async () => {
    const output = "B".repeat(50_000);
    const sessionId = "test-session-123";
    const result = await limitOutput(output, undefined, testDir, sessionId);
    expect(result.truncated).toBe(true);

    const sessionDir = join(testDir, ".flywheel", "harness-outputs", sessionId);
    expect(existsSync(sessionDir)).toBe(true);
    const files = readdirSync(sessionDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^output_.*\.txt$/);
  });

  test("truncated message includes path to saved file", async () => {
    const output = "C".repeat(50_000);
    const result = await limitOutput(output, undefined, testDir, "sess-1");
    expect(result.text).toContain("Full output saved to");
    expect(result.text).toContain("harness-outputs/sess-1/");
  });

  test("saves to flat directory when no sessionId provided", async () => {
    const output = "D".repeat(50_000);
    const result = await limitOutput(output, undefined, testDir);
    expect(result.truncated).toBe(true);

    const flatDir = join(testDir, ".flywheel", "harness-outputs");
    expect(existsSync(flatDir)).toBe(true);
    const files = readdirSync(flatDir);
    expect(files.length).toBe(1);
  });
});

describe("cleanupHarnessOutputs", () => {
  const testDir = join("/tmp", `harness-cleanup-test-${Date.now()}`);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("removes per-session output directory", async () => {
    const sessionId = "cleanup-test";
    const sessionDir = join(testDir, ".flywheel", "harness-outputs", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    await Bun.write(join(sessionDir, "output.txt"), "test");

    cleanupHarnessOutputs(testDir, sessionId);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("does not throw if directory does not exist", () => {
    cleanupHarnessOutputs(testDir, "nonexistent");
  });

  test("preserves sibling session directories", async () => {
    const dir1 = join(testDir, ".flywheel", "harness-outputs", "session-a");
    const dir2 = join(testDir, ".flywheel", "harness-outputs", "session-b");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    await Bun.write(join(dir1, "output.txt"), "keep");
    await Bun.write(join(dir2, "output.txt"), "remove");

    cleanupHarnessOutputs(testDir, "session-b");
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(false);
  });
});
