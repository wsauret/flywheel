import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextIndexer } from "../src/orchestration/memory/indexer";
import type { ContextQuery } from "../src/orchestration/memory/indexer";
import { AvailableContextSchema } from "../src/workflows/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectCwd: string;

async function setupProject() {
  projectCwd = await mkdtemp(join(tmpdir(), "ctx-indexer-"));
  return projectCwd;
}

/** Write a standards file with frontmatter. */
async function writeStandard(
  name: string,
  opts: { title?: string; summary?: string; body?: string },
) {
  const dir = join(projectCwd, "docs", "standards");
  await mkdir(dir, { recursive: true });
  const lines = ["---"];
  if (opts.title !== undefined) lines.push(`title: "${opts.title}"`);
  if (opts.summary !== undefined) lines.push(`summary: "${opts.summary}"`);
  lines.push("---", "", opts.body ?? "Body content here.");
  await writeFile(join(dir, name), lines.join("\n"), "utf-8");
}

const defaultQuery: ContextQuery = {
  stepType: "work",
  stepDescription: "implement the feature",
};

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("ContextIndexer", () => {
  beforeEach(async () => {
    await setupProject();
  });

  afterEach(async () => {
    await rm(projectCwd, { recursive: true, force: true });
  });

  it("constructor accepts projectCwd and options", () => {
    const indexer = new ContextIndexer(projectCwd, {
      standardsDir: "custom/standards/",
      conventionFiles: ["CUSTOM.md"],
    });
    expect(indexer).toBeDefined();
    indexer.dispose();
  });

  it("constructor works with no options", () => {
    const indexer = new ContextIndexer(projectCwd);
    expect(indexer).toBeDefined();
    indexer.dispose();
  });

  // -------------------------------------------------------------------------
  // getRelevantContext shape
  // -------------------------------------------------------------------------

  describe("getRelevantContext", () => {
    it("returns AvailableContext shape (conventions, standards, learnings arrays)", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx).toHaveProperty("conventions");
      expect(ctx).toHaveProperty("standards");
      expect(ctx).toHaveProperty("learnings");
      expect(Array.isArray(ctx.conventions)).toBe(true);
      expect(Array.isArray(ctx.standards)).toBe(true);
      expect(Array.isArray(ctx.learnings)).toBe(true);
      indexer.dispose();
    });

    it("validates against AvailableContextSchema", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      const result = AvailableContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);
      indexer.dispose();
    });

    it("returns empty arrays when startIndexing() has not completed", () => {
      const indexer = new ContextIndexer(projectCwd);
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.conventions).toEqual([]);
      expect(ctx.standards).toEqual([]);
      expect(ctx.learnings).toEqual([]);
      indexer.dispose();
    });

    it("ContextQuery.stepType accepts StepType values", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      // All workflow types should be accepted
      for (const wt of ["work", "plan", "review", "ship", "debug", "research"] as const) {
        const query: ContextQuery = { stepType: wt, stepDescription: "test" };
        const ctx = indexer.getRelevantContext(query);
        expect(ctx).toHaveProperty("conventions");
      }
      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Convention scanner
  // -------------------------------------------------------------------------

  describe("convention scanner", () => {
    it("finds AGENTS.md at project root", async () => {
      await writeFile(join(projectCwd, "AGENTS.md"), "# Agent Instructions\nSome content", "utf-8");
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      const agents = ctx.conventions.find((c) => c.name === "AGENTS.md");
      expect(agents).toBeDefined();
      expect(agents!.path).toBe("AGENTS.md");
      expect(agents!.summary).toBe(
        "Project architecture, commands, TUI states, and developer conventions",
      );
      indexer.dispose();
    });

    it("entry has name, path, and summary", async () => {
      await writeFile(join(projectCwd, "CONTRIBUTING.md"), "# Contributing\nPlease read.", "utf-8");
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      const contrib = ctx.conventions.find((c) => c.name === "CONTRIBUTING.md");
      expect(contrib).toBeDefined();
      expect(contrib!.name).toBe("CONTRIBUTING.md");
      expect(contrib!.path).toBe("CONTRIBUTING.md");
      expect(typeof contrib!.summary).toBe("string");
      indexer.dispose();
    });

    it("supports configurable file list via options.conventionFiles", async () => {
      await writeFile(join(projectCwd, "CUSTOM.md"), "# Custom\nCustom conventions.", "utf-8");
      const indexer = new ContextIndexer(projectCwd, { conventionFiles: ["CUSTOM.md"] });
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.conventions.length).toBe(1);
      expect(ctx.conventions[0].name).toBe("CUSTOM.md");
      indexer.dispose();
    });

    it("skips missing convention files gracefully", async () => {
      const indexer = new ContextIndexer(projectCwd, {
        conventionFiles: ["NONEXISTENT.md"],
      });
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.conventions).toEqual([]);
      indexer.dispose();
    });

    it("scans .claude/ and .opencode/ config directories", async () => {
      await mkdir(join(projectCwd, ".claude"), { recursive: true });
      await writeFile(
        join(projectCwd, ".claude", "settings.md"),
        "# Settings\nClaude configuration.",
        "utf-8",
      );
      const indexer = new ContextIndexer(projectCwd, { conventionFiles: [] });
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      const settings = ctx.conventions.find((c) => c.name === "settings.md");
      expect(settings).toBeDefined();
      expect(settings!.path).toBe(".claude/settings.md");
      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Standards scanner
  // -------------------------------------------------------------------------

  describe("standards scanner", () => {
    it("discovers docs/standards/*.md with valid frontmatter", async () => {
      await writeStandard("coding.md", {
        title: "Coding Standards",
        summary: "How to write code",
      });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards.length).toBe(1);
      expect(ctx.standards[0].name).toBe("Coding Standards");
      indexer.dispose();
    });

    it("skips files without frontmatter (including README.md)", async () => {
      const dir = join(projectCwd, "docs", "standards");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "README.md"), "# Standards\nThis is a readme.", "utf-8");
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards.length).toBe(0);
      indexer.dispose();
    });

    it("frontmatter title maps to ContextEntry.name", async () => {
      await writeStandard("testing.md", { title: "Testing Standards" });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].name).toBe("Testing Standards");
      indexer.dispose();
    });

    it("path is relative to projectCwd", async () => {
      await writeStandard("api.md", { title: "API Standards" });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].path).toBe("docs/standards/api.md");
      indexer.dispose();
    });

    it("summary from frontmatter summary field", async () => {
      await writeStandard("code.md", {
        title: "Code Standards",
        summary: "Guidelines for code quality",
      });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].summary).toBe("Guidelines for code quality");
      indexer.dispose();
    });

    it("summary fallback: first non-heading content line (capped 100 chars)", async () => {
      await writeStandard("fallback.md", {
        title: "Fallback",
        body: "## Introduction\nThis is the first real content line for standards.",
      });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].summary).toBe(
        "This is the first real content line for standards.",
      );
      indexer.dispose();
    });

    it("summary is capped at 100 chars", async () => {
      const longSummary = "A".repeat(200);
      await writeStandard("long.md", { title: "Long", summary: longSummary });
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].summary.length).toBeLessThanOrEqual(100);
      indexer.dispose();
    });

    it("fallback name is filename without extension when title missing", async () => {
      const dir = join(projectCwd, "docs", "standards");
      await mkdir(dir, { recursive: true });
      // Frontmatter with no title field
      await writeFile(
        join(dir, "notitle.md"),
        "---\nsome_key: value\n---\nContent here.",
        "utf-8",
      );
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards[0].name).toBe("notitle");
      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Empty project
  // -------------------------------------------------------------------------

  describe("empty project", () => {
    it("returns empty arrays (no errors)", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.conventions).toEqual([]);
      expect(ctx.standards).toEqual([]);
      expect(ctx.learnings).toEqual([]);
      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Max-20 cap
  // -------------------------------------------------------------------------

  describe("max-20 cap", () => {
    it("respects max-20 cap from AvailableContextSchema", async () => {
      // Create 25 standard files
      const dir = join(projectCwd, "docs", "standards");
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 25; i++) {
        const content = `---\ntitle: "Standard ${i}"\n---\nContent for standard ${i}.`;
        await writeFile(join(dir, `std-${String(i).padStart(2, "0")}.md`), content, "utf-8");
      }
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx = indexer.getRelevantContext(defaultQuery);
      expect(ctx.standards.length).toBeLessThanOrEqual(20);
      // Validate against schema (which enforces max 20)
      const result = AvailableContextSchema.safeParse(ctx);
      expect(result.success).toBe(true);
      indexer.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    it("clears ready state", async () => {
      const indexer = new ContextIndexer(projectCwd);
      await indexer.startIndexing();
      const ctx1 = indexer.getRelevantContext(defaultQuery);
      expect(ctx1).toHaveProperty("conventions");

      indexer.dispose();

      // After dispose, should return empty
      const ctx2 = indexer.getRelevantContext(defaultQuery);
      expect(ctx2.conventions).toEqual([]);
      expect(ctx2.standards).toEqual([]);
      expect(ctx2.learnings).toEqual([]);
    });
  });
});
