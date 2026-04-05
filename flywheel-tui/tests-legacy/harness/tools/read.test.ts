/**
 * Read tool — file reading with hashline output, offset/limit,
 * error handling, and binary detection.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createReadTool } from "../../../src/harness/tools/read.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = path.join("/tmp", `flywheel-read-test-${Date.now()}`);
const SAMPLE_FILE = path.join(TEST_DIR, "sample.txt");
const EMPTY_FILE = path.join(TEST_DIR, "empty.txt");
const BINARY_FILE = path.join(TEST_DIR, "binary.bin");

const SAMPLE_CONTENT = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} content here`).join("\n");

const defaultContext: ToolContext = {
  cwd: TEST_DIR,
  env: {},
};

const readTool = createReadTool();

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(SAMPLE_FILE, SAMPLE_CONTENT);
  await fs.writeFile(EMPTY_FILE, "");

  // Create a binary file with null bytes
  const binaryData = Buffer.alloc(100);
  binaryData[0] = 0x89; // PNG-like header
  binaryData[1] = 0x00; // Null byte
  binaryData[2] = 0x50;
  await fs.writeFile(BINARY_FILE, binaryData);
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic reading with hashline output
// ---------------------------------------------------------------------------

describe("read tool — hashline output", () => {
  it("reads a file with hashline-tagged lines", async () => {
    const result = await readTool.execute(
      { file_path: SAMPLE_FILE },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();

    const lines = result.content.split("\n");
    // Each line should have the format: LINE#HASH:content
    const tagPattern = /^\d+#[ZPMQVRWSNKTXJBYH]{2}:/;
    for (const line of lines) {
      // Skip pagination hints
      if (line.startsWith("[") || line === "") continue;
      expect(line).toMatch(tagPattern);
    }

    // First line should be 1#XX:Line 1 content here
    expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:Line 1 content here$/);
  });

  it("preserves line content after the tag", async () => {
    const result = await readTool.execute(
      { file_path: SAMPLE_FILE },
      defaultContext,
    );
    // Extract content after tags
    const contentLines = result.content.split("\n").map((line) => {
      const colonIdx = line.indexOf(":");
      return colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
    });

    expect(contentLines[0]).toBe("Line 1 content here");
    expect(contentLines[19]).toBe("Line 20 content here");
  });
});

// ---------------------------------------------------------------------------
// Offset and limit
// ---------------------------------------------------------------------------

describe("read tool — offset and limit", () => {
  it("applies offset to skip initial lines", async () => {
    const result = await readTool.execute(
      { file_path: SAMPLE_FILE, offset: 5 },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();
    // First visible line should be line 6 (0-based offset 5 -> 1-indexed line 6)
    expect(result.content).toMatch(/^6#[ZPMQVRWSNKTXJBYH]{2}:Line 6 content here/);
  });

  it("applies limit to restrict line count", async () => {
    const result = await readTool.execute(
      { file_path: SAMPLE_FILE, offset: 0, limit: 3 },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();

    // Should have 3 content lines + pagination hint
    const lines = result.content.split("\n");
    const contentLines = lines.filter((l) => l.match(/^\d+#/));
    expect(contentLines).toHaveLength(3);

    // Should have a pagination hint
    expect(result.content).toContain("more lines");
    expect(result.content).toContain("offset=3");
  });

  it("handles offset at end of file", async () => {
    const result = await readTool.execute(
      { file_path: SAMPLE_FILE, offset: 100 },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("beyond end of file");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("read tool — error handling", () => {
  it("reports file not found", async () => {
    const result = await readTool.execute(
      { file_path: path.join(TEST_DIR, "nonexistent.txt") },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  it("handles empty files gracefully", async () => {
    const result = await readTool.execute(
      { file_path: EMPTY_FILE },
      defaultContext,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("(empty file)");
  });

  it("detects and rejects binary files", async () => {
    const result = await readTool.execute(
      { file_path: BINARY_FILE },
      defaultContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("binary file");
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("read tool — metadata", () => {
  it("has correct name and concurrency", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.concurrency).toBe("shared");
  });

  it("description mentions hashline format", () => {
    expect(readTool.description).toContain("hashline");
  });
});
