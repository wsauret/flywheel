import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// enrichPromptWithContext tests (extracted from dispatcher.test.ts)
// ---------------------------------------------------------------------------

describe("enrichPromptWithContext", () => {
  let enrichPromptWithContext: typeof import("../src/controller/context-enrichment").enrichPromptWithContext;
  let INLINE_CONTENT_BUDGET: number;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import("../src/controller/context-enrichment");
    enrichPromptWithContext = mod.enrichPromptWithContext;
    INLINE_CONTENT_BUDGET = mod.INLINE_CONTENT_BUDGET;
    tmpDir = await mkdtemp(join(tmpdir(), "enrich-ctx-"));
  });

  afterAll(async () => {
    // Clean up any remaining temp dirs (best-effort)
    try {
      // Each test creates its own tmpDir — afterAll can't clean all of them,
      // but OS tmp cleanup handles it. Individual cleanup in tests is optional.
    } catch {}
  });

  it("returns prompt unchanged when contextToInline is empty", async () => {
    const prompt = "Execute phase 1";
    const result = await enrichPromptWithContext(prompt, [], tmpDir);
    expect(result).toBe(prompt);
  });

  it("prepends file content with header and file path sub-headers", async () => {
    const filePath = join(tmpDir, "conventions.md");
    await writeFile(filePath, "Always use TypeScript strict mode.");

    const prompt = "Execute phase 1";
    const result = await enrichPromptWithContext(prompt, [filePath], tmpDir);

    expect(result).toContain("## Relevant Context (from project standards and learnings)");
    expect(result).toContain(`### ${filePath}`);
    expect(result).toContain("Always use TypeScript strict mode.");
    // Original prompt is at the end
    expect(result).toContain("---\n\nExecute phase 1");
    // Verify ordering: context comes before prompt
    const contextIdx = result.indexOf("## Relevant Context");
    const promptIdx = result.indexOf("Execute phase 1");
    expect(contextIdx).toBeLessThan(promptIdx);
  });

  it("inlines multiple files in order with separate sub-headers", async () => {
    const file1 = join(tmpDir, "style.md");
    const file2 = join(tmpDir, "testing.md");
    await writeFile(file1, "Use 2-space indentation.");
    await writeFile(file2, "Always write unit tests.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [file1, file2], tmpDir);

    expect(result).toContain(`### ${file1}`);
    expect(result).toContain(`### ${file2}`);
    expect(result).toContain("Use 2-space indentation.");
    expect(result).toContain("Always write unit tests.");
    // file1 should appear before file2
    const idx1 = result.indexOf(`### ${file1}`);
    const idx2 = result.indexOf(`### ${file2}`);
    expect(idx1).toBeLessThan(idx2);
  });

  it("caps total inlined content at INLINE_CONTENT_BUDGET (8KB)", async () => {
    // Create a file that's under 8KB
    const file1 = join(tmpDir, "big1.md");
    await writeFile(file1, "A".repeat(6000));

    // Create a second file that would push over 8KB
    const file2 = join(tmpDir, "big2.md");
    await writeFile(file2, "B".repeat(3000));

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [file1, file2], tmpDir);

    // First file should be included
    expect(result).toContain(`### ${file1}`);
    // Second file should NOT be included (budget exceeded)
    expect(result).not.toContain(`### ${file2}`);
    // Original prompt still present
    expect(result).toContain("Original prompt");
  });

  it("skips non-existent files gracefully", async () => {
    const validFile = join(tmpDir, "exists.md");
    await writeFile(validFile, "Valid content.");
    const missingFile = join(tmpDir, "does-not-exist.md");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [missingFile, validFile], tmpDir);

    // Missing file skipped, valid file included
    expect(result).not.toContain(`### ${missingFile}`);
    expect(result).toContain(`### ${validFile}`);
    expect(result).toContain("Valid content.");
  });

  it("rejects paths outside projectCwd via isPathWithinBoundary()", async () => {
    // Create a file outside the project boundary
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    const outsideFile = join(outsideDir, "secret.md");
    await writeFile(outsideFile, "Secret content");

    const validFile = join(tmpDir, "safe.md");
    await writeFile(validFile, "Safe content.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [outsideFile, validFile], tmpDir);

    // Outside file should be rejected
    expect(result).not.toContain("Secret content");
    expect(result).not.toContain(`### ${outsideFile}`);
    // Safe file should be included
    expect(result).toContain(`### ${validFile}`);
    expect(result).toContain("Safe content.");

    // Cleanup outside dir
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("returns prompt unchanged when all paths are invalid", async () => {
    const missingFile = join(tmpDir, "nonexistent.md");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [missingFile], tmpDir);

    // No context could be inlined, so prompt should be unchanged
    expect(result).toBe(prompt);
  });

  it("INLINE_CONTENT_BUDGET is 8192", () => {
    expect(INLINE_CONTENT_BUDGET).toBe(8192);
  });

  it("truncates first file if it alone exceeds budget", async () => {
    const bigFile = join(tmpDir, "huge.md");
    // Write content much larger than 8KB
    await writeFile(bigFile, "X".repeat(20000));

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [bigFile], tmpDir);

    // Should still include something from the file (truncated)
    expect(result).toContain(`### ${bigFile}`);
    expect(result).toContain("[truncated]");
    // Original prompt should still be present
    expect(result).toContain("Original prompt");
    // Extract the file content section between the file path header and [truncated] marker.
    // This avoids counting X characters that may appear in the random temp dir path.
    const fileHeader = `### ${bigFile}\n`;
    const headerStart = result.indexOf(fileHeader);
    const contentStart = headerStart + fileHeader.length;
    const truncatedMarker = result.indexOf("\n[truncated]", contentStart);
    const fileContent = result.substring(contentStart, truncatedMarker);
    // Content bytes should be at most the budget
    const contentBytes = Buffer.byteLength(fileContent, "utf-8");
    expect(contentBytes).toBeLessThanOrEqual(INLINE_CONTENT_BUDGET);
    expect(contentBytes).toBeGreaterThan(0);
  });

  it("reads files with subdirectory paths within projectCwd", async () => {
    const subDir = join(tmpDir, "sub", "dir");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "nested.md");
    await writeFile(filePath, "Nested content.");

    const prompt = "Original prompt";
    const result = await enrichPromptWithContext(prompt, [filePath], tmpDir);

    expect(result).toContain(`### ${filePath}`);
    expect(result).toContain("Nested content.");
  });
});
