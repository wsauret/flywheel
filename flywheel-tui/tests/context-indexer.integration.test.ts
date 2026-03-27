/**
 * Integration tests for the Progressive Context Disclosure system (WP4).
 *
 * Tests the full ContextIndexer → AvailableContextSchema → enrichPromptWithContext
 * pipeline including path security boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextIndexer } from "../src/memory/indexer";
import { AvailableContextSchema } from "../src/schemas/shared";
import { enrichPromptWithContext } from "../src/controller/context-enrichment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectCwd: string;

async function setupProject(): Promise<string> {
  projectCwd = await mkdtemp(join(tmpdir(), "ctx-integration-"));
  return projectCwd;
}

/** Write AGENTS.md at project root. */
async function writeConvention(content: string) {
  await writeFile(join(projectCwd, "AGENTS.md"), content, "utf-8");
}

/** Write a standards file with YAML frontmatter. */
async function writeStandard(
  name: string,
  opts: { title: string; summary: string; tags: string[]; body: string },
) {
  const dir = join(projectCwd, "docs", "standards");
  await mkdir(dir, { recursive: true });
  const tagsYaml = `[${opts.tags.join(", ")}]`;
  const doc = [
    "---",
    `title: "${opts.title}"`,
    `summary: "${opts.summary}"`,
    `tags: ${tagsYaml}`,
    "---",
    "",
    opts.body,
  ].join("\n");
  await writeFile(join(dir, name), doc, "utf-8");
}

/** Write a solution (learning) file with compound frontmatter. */
async function writeSolution(
  name: string,
  opts: { title: string; tags: string[]; hash: string; content: string },
) {
  const dir = join(projectCwd, ".flywheel", "solutions");
  await mkdir(dir, { recursive: true });
  const tagsYaml = `[${opts.tags.join(", ")}]`;
  const doc = [
    "---",
    "type: compound",
    `title: "${opts.title}"`,
    `tags: ${tagsYaml}`,
    `date: "2026-03-22"`,
    `extraction_hash: "${opts.hash}"`,
    "---",
    "",
    opts.content,
  ].join("\n");
  await writeFile(join(dir, name), doc, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Context Indexer Integration", () => {
  beforeEach(async () => {
    await setupProject();
  });

  afterEach(async () => {
    await rm(projectCwd, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Full 3-category indexing
  // -------------------------------------------------------------------------

  describe("full 3-category indexing", () => {
    it("returns entries from conventions, standards, and learnings", async () => {
      // Set up all three categories
      await writeConvention("# Agent Instructions\nProject conventions and architecture.");
      await writeStandard("testing.md", {
        title: "Testing Standards",
        summary: "Testing conventions and patterns",
        tags: ["testing"],
        body: "Always write unit tests before integration tests.",
      });
      await writeSolution("retry-pattern.md", {
        title: "Retry Pattern",
        tags: ["retry", "resilience"],
        hash: "abc123def456",
        content:
          "## Problem\nConnection drops.\n\n## Solution\nExponential backoff with jitter.",
      });

      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "implement retry resilience testing",
      });

      // Conventions: AGENTS.md should be found
      expect(ctx.conventions.length).toBeGreaterThanOrEqual(1);
      const agents = ctx.conventions.find((c) => c.name === "AGENTS.md");
      expect(agents).toBeDefined();
      expect(agents!.path).toBe("AGENTS.md");

      // Standards: testing.md should be found
      expect(ctx.standards.length).toBeGreaterThanOrEqual(1);
      const testing = ctx.standards.find((s) => s.name === "Testing Standards");
      expect(testing).toBeDefined();
      expect(testing!.path).toBe("docs/standards/testing.md");
      expect(testing!.summary).toBe("Testing conventions and patterns");

      // Learnings: retry-pattern.md should be found
      expect(ctx.learnings.length).toBeGreaterThanOrEqual(1);
      const retry = ctx.learnings.find((l) => l.name === "Retry Pattern");
      expect(retry).toBeDefined();
      expect(retry!.path).toBe(".flywheel/solutions/retry-pattern.md");

      indexer.dispose();
    });

    it("each category entry has name, path, and summary", async () => {
      await writeConvention("# Conventions\nProject-wide conventions.");
      await writeStandard("api.md", {
        title: "API Standards",
        summary: "REST API design guidelines",
        tags: ["api"],
        body: "Use consistent error responses.",
      });
      await writeSolution("caching.md", {
        title: "Caching Strategy",
        tags: ["caching"],
        hash: "cache-hash-001",
        content: "Use TTL-based caching for API responses. Invalidate on write.",
      });

      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "build api caching layer",
      });

      // Verify shape of each category's entries
      for (const entry of ctx.conventions) {
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.path).toBe("string");
        expect(typeof entry.summary).toBe("string");
      }
      for (const entry of ctx.standards) {
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.path).toBe("string");
        expect(typeof entry.summary).toBe("string");
      }
      for (const entry of ctx.learnings) {
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.path).toBe("string");
        expect(typeof entry.summary).toBe("string");
      }

      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Schema validation
  // -------------------------------------------------------------------------

  describe("schema validation", () => {
    it("entries conform to AvailableContextSchema (Zod parse)", async () => {
      await writeConvention("# Agent Instructions\nArchitecture docs.");
      await writeStandard("code.md", {
        title: "Code Standards",
        summary: "Code quality guidelines",
        tags: ["code"],
        body: "Use TypeScript strict mode.",
      });
      await writeSolution("error-handling.md", {
        title: "Error Handling",
        tags: ["errors", "resilience"],
        hash: "err-hash-001",
        content: "Wrap all async calls. Log structured errors.",
      });

      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "handle errors resilience",
      });

      // Strict Zod parse — throws on failure
      const parsed = AvailableContextSchema.parse(ctx);
      expect(parsed.conventions.length).toBeGreaterThanOrEqual(1);
      expect(parsed.standards.length).toBeGreaterThanOrEqual(1);
      expect(parsed.learnings.length).toBeGreaterThanOrEqual(1);

      indexer.dispose();
    });

    it("safeParse succeeds for each individual entry", async () => {
      await writeConvention("# Conventions\nSome content.");
      await writeStandard("testing.md", {
        title: "Testing",
        summary: "Test patterns",
        tags: ["test"],
        body: "Write tests.",
      });
      await writeSolution("retry.md", {
        title: "Retry",
        tags: ["retry"],
        hash: "retry-001",
        content: "Retry with backoff. Keep it simple.",
      });

      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "retry test implementation",
      });

      const result = AvailableContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify arrays are present and non-empty
        expect(result.data.conventions.length).toBeGreaterThan(0);
        expect(result.data.standards.length).toBeGreaterThan(0);
        expect(result.data.learnings.length).toBeGreaterThan(0);
      }

      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // 3. context_to_inline enrichment
  // -------------------------------------------------------------------------

  describe("context_to_inline enrichment", () => {
    it("enriches prompt with file content for valid paths", async () => {
      // Create a standards file to inline
      const standardsDir = join(projectCwd, "docs", "standards");
      await mkdir(standardsDir, { recursive: true });
      const filePath = join(standardsDir, "testing.md");
      const fileContent = [
        "---",
        'title: "Testing Standards"',
        'summary: "How to test"',
        "---",
        "",
        "Always write unit tests first.",
      ].join("\n");
      await writeFile(filePath, fileContent, "utf-8");

      const basePrompt = "Implement the feature as described.";
      const enriched = await enrichPromptWithContext(
        basePrompt,
        [filePath],
        projectCwd,
      );

      // Enriched prompt should contain the original prompt
      expect(enriched).toContain(basePrompt);
      // Enriched prompt should contain the file content
      expect(enriched).toContain("Always write unit tests first.");
      // Enriched prompt should contain the context header
      expect(enriched).toContain("Relevant Context");
      // File content should appear before the original prompt
      const contextIdx = enriched.indexOf("Relevant Context");
      const promptIdx = enriched.indexOf(basePrompt);
      expect(contextIdx).toBeLessThan(promptIdx);
    });

    it("enriches prompt with multiple files", async () => {
      const standardsDir = join(projectCwd, "docs", "standards");
      await mkdir(standardsDir, { recursive: true });

      const file1 = join(standardsDir, "coding.md");
      await writeFile(file1, "---\ntitle: Coding\n---\nUse strict mode.", "utf-8");

      const file2 = join(standardsDir, "testing.md");
      await writeFile(file2, "---\ntitle: Testing\n---\nWrite unit tests.", "utf-8");

      const enriched = await enrichPromptWithContext(
        "Build the feature.",
        [file1, file2],
        projectCwd,
      );

      expect(enriched).toContain("Use strict mode.");
      expect(enriched).toContain("Write unit tests.");
    });

    it("returns original prompt when contextToInline is empty", async () => {
      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(prompt, [], projectCwd);
      expect(enriched).toBe(prompt);
    });

    it("skips non-existent files without error", async () => {
      const nonExistent = join(projectCwd, "does-not-exist.md");
      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(
        prompt,
        [nonExistent],
        projectCwd,
      );
      // No file content to add, so prompt should be unchanged
      expect(enriched).toBe(prompt);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Path security
  // -------------------------------------------------------------------------

  describe("path security", () => {
    it("rejects paths outside project boundary (../../etc/passwd)", async () => {
      const maliciousPath = join(projectCwd, "..", "..", "etc", "passwd");
      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(
        prompt,
        [maliciousPath],
        projectCwd,
      );

      // Should not contain /etc/passwd content
      expect(enriched).not.toContain("root:");
      // Prompt should be returned unchanged (malicious path skipped)
      expect(enriched).toBe(prompt);
    });

    it("rejects absolute paths outside project boundary", async () => {
      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(
        prompt,
        ["/etc/passwd"],
        projectCwd,
      );

      expect(enriched).not.toContain("root:");
      expect(enriched).toBe(prompt);
    });

    it("accepts valid paths within project boundary", async () => {
      const validFile = join(projectCwd, "README.md");
      await writeFile(validFile, "# My Project\nThis is valid content.", "utf-8");

      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(
        prompt,
        [validFile],
        projectCwd,
      );

      expect(enriched).toContain("This is valid content.");
      expect(enriched).toContain(prompt);
    });

    it("mixes valid and invalid paths — only valid content is inlined", async () => {
      const validFile = join(projectCwd, "safe.md");
      await writeFile(validFile, "Safe content here.", "utf-8");
      const maliciousPath = join(projectCwd, "..", "..", "etc", "passwd");

      const prompt = "Do the work.";
      const enriched = await enrichPromptWithContext(
        prompt,
        [maliciousPath, validFile],
        projectCwd,
      );

      // Should contain valid content
      expect(enriched).toContain("Safe content here.");
      // Should not contain /etc/passwd content
      expect(enriched).not.toContain("root:");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Empty project
  // -------------------------------------------------------------------------

  describe("empty project", () => {
    it("returns empty arrays without errors", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "implement something",
      });

      expect(ctx.conventions).toEqual([]);
      expect(ctx.standards).toEqual([]);
      expect(ctx.learnings).toEqual([]);

      // Should still validate against schema
      const result = AvailableContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);

      indexer.dispose();
    });

    it("empty project with no docs directories at all", async () => {
      // projectCwd exists but has absolutely nothing in it
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "plan",
        stepDescription: "create initial plan",
      });

      expect(ctx.conventions).toEqual([]);
      expect(ctx.standards).toEqual([]);
      expect(ctx.learnings).toEqual([]);

      indexer.dispose();
    });

    it("empty project with empty docs directories", async () => {
      await mkdir(join(projectCwd, "docs", "standards"), { recursive: true });
      await mkdir(join(projectCwd, "docs", "solutions"), { recursive: true });

      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();

      const ctx = indexer.getRelevantContext({
        stepType: "work",
        stepDescription: "build feature",
      });

      expect(ctx.conventions).toEqual([]);
      expect(ctx.standards).toEqual([]);
      expect(ctx.learnings).toEqual([]);

      indexer.dispose();
    });
  });
});
