import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectInstructions } from "../src/orchestration/engines/providers/harness/project-instructions.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proj-instr-"));
  // Create a .git marker so the walk stops at our temp root
  await mkdir(join(root, ".git"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- Directory walk ---

describe("directory walk", () => {
  test("returns undefined when no instruction file exists", async () => {
    const result = await loadProjectInstructions(root);
    expect(result).toBeUndefined();
  });

  test("loads agents.md from cwd", async () => {
    await writeFile(join(root, "agents.md"), "project rules");
    const result = await loadProjectInstructions(root);
    expect(result).toBe("project rules");
  });

  test("loads AGENTS.md when agents.md is missing", async () => {
    await writeFile(join(root, "AGENTS.md"), "uppercase fallback");
    const result = await loadProjectInstructions(root);
    expect(result).toBe("uppercase fallback");
  });

  test("loads CLAUDE.md when no agents.md variant exists", async () => {
    await writeFile(join(root, "CLAUDE.md"), "claude instructions");
    const result = await loadProjectInstructions(root);
    expect(result).toBe("claude instructions");
  });

  test("picks only one file per directory (first candidate wins)", async () => {
    // On case-insensitive FS agents.md and AGENTS.md are the same file,
    // but CLAUDE.md is distinct. Verify agents.md wins over CLAUDE.md.
    await writeFile(join(root, "agents.md"), "agents wins");
    await writeFile(join(root, "CLAUDE.md"), "claude loses");
    const result = await loadProjectInstructions(root);
    expect(result).toBe("agents wins");
  });

  test("walks up and concatenates files root-first, cwd-last", async () => {
    const child = join(root, "sub");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "agents.md"), "root rules");
    await writeFile(join(child, "agents.md"), "child rules");

    const result = await loadProjectInstructions(child);
    expect(result).toContain("root rules");
    expect(result).toContain("child rules");

    const rootIdx = result!.indexOf("root rules");
    const childIdx = result!.indexOf("child rules");
    expect(rootIdx).toBeLessThan(childIdx);
  });

  test("stops at .git boundary", async () => {
    // Create a parent directory above root with an instruction file.
    // Since root has .git, the walk should NOT reach the parent's tmp dir.
    // We verify by checking the result only contains our root-level file.
    const child = join(root, "pkg");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "agents.md"), "repo root");
    await writeFile(join(child, "agents.md"), "package");

    const result = await loadProjectInstructions(child);
    expect(result).toContain("repo root");
    expect(result).toContain("package");
    // Only two sections
    const sectionCount = result!.split("---").length;
    expect(sectionCount).toBe(2);
  });

  test("deduplicates by path", async () => {
    await writeFile(join(root, "agents.md"), "once only");
    const result = await loadProjectInstructions(root);
    const count = result!.split("once only").length - 1;
    expect(count).toBe(1);
  });

  test("collects files from multiple ancestor levels", async () => {
    const a = join(root, "a");
    const b = join(a, "b");
    const c = join(b, "c");
    await mkdir(c, { recursive: true });
    await writeFile(join(root, "agents.md"), "L0");
    await writeFile(join(b, "agents.md"), "L2");
    await writeFile(join(c, "AGENTS.md"), "L3");

    const result = await loadProjectInstructions(c);
    expect(result).toContain("L0");
    expect(result).toContain("L2");
    expect(result).toContain("L3");

    const i0 = result!.indexOf("L0");
    const i2 = result!.indexOf("L2");
    const i3 = result!.indexOf("L3");
    expect(i0).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("mixes agents.md and CLAUDE.md across levels", async () => {
    const child = join(root, "sub");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "root claude");
    await writeFile(join(child, "agents.md"), "child agents");

    const result = await loadProjectInstructions(child);
    expect(result).toContain("root claude");
    expect(result).toContain("child agents");
  });
});

// --- Size cap ---

describe("size cap", () => {
  test("truncates root-end sections first when exceeding 32KB", async () => {
    const big = "x".repeat(20_000);
    const child = join(root, "sub");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "agents.md"), `ROOT ${big}`);
    await writeFile(join(child, "agents.md"), `CHILD ${big}`);

    const result = await loadProjectInstructions(child);
    // Child (closer to cwd) should be preserved; root may be dropped
    expect(result).toContain("CHILD");
    expect(Buffer.byteLength(result!, "utf-8")).toBeLessThanOrEqual(32_768);
  });

  test("includes truncation marker when sections are dropped", async () => {
    const big = "x".repeat(20_000);
    const child = join(root, "sub");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "agents.md"), `ROOT ${big}`);
    await writeFile(join(child, "agents.md"), `CHILD ${big}`);

    const result = await loadProjectInstructions(child);
    expect(result).toContain("[project instructions truncated]");
  });
});

// --- @-include expansion ---

describe("@-include directives", () => {
  test("expands @./relative paths", async () => {
    await writeFile(join(root, "extra.md"), "included content");
    await writeFile(join(root, "agents.md"), "main\n@./extra.md");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("included content");
  });

  test("expands bare relative paths", async () => {
    await writeFile(join(root, "rules.md"), "bare include");
    await writeFile(join(root, "agents.md"), "main\n@rules.md");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("bare include");
  });

  test("expands absolute paths", async () => {
    const absFile = join(root, "abs-target.md");
    await writeFile(absFile, "absolute content");
    await writeFile(join(root, "agents.md"), `main\n@${absFile}`);

    const result = await loadProjectInstructions(root);
    expect(result).toContain("absolute content");
  });

  test("silently skips non-existent includes", async () => {
    await writeFile(join(root, "agents.md"), "main\n@./does-not-exist.md");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("main");
    expect(result).toContain("@./does-not-exist.md");
  });

  test("handles nested includes up to depth limit", async () => {
    await writeFile(join(root, "agents.md"), "L0\n@./level1.md");
    await writeFile(join(root, "level1.md"), "L1\n@./level2.md");
    await writeFile(join(root, "level2.md"), "L2\n@./level3.md");
    await writeFile(join(root, "level3.md"), "L3");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("L0");
    expect(result).toContain("L1");
    expect(result).toContain("L2");
    expect(result).toContain("L3");
  });

  test("prevents circular includes", async () => {
    await writeFile(join(root, "agents.md"), "A\n@./b.md");
    await writeFile(join(root, "b.md"), "B\n@./agents.md");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("A");
    expect(result).toContain("B");
    // Should not loop infinitely — just complete
  });

  test("does not expand @-references inside code fences", async () => {
    const content = [
      "main",
      "```",
      "@./should-not-expand.md",
      "```",
    ].join("\n");
    await writeFile(join(root, "agents.md"), content);
    await writeFile(join(root, "should-not-expand.md"), "EXPANDED");

    const result = await loadProjectInstructions(root);
    expect(result).not.toContain("EXPANDED");
    expect(result).toContain("@./should-not-expand.md");
  });

  test("does not expand @-mentions (no path characters)", async () => {
    await writeFile(join(root, "agents.md"), "cc @someone for review");

    const result = await loadProjectInstructions(root);
    expect(result).toBe("cc @someone for review");
  });

  test("resolves include paths relative to the including file", async () => {
    const sub = join(root, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "detail.md"), "nested detail");
    await writeFile(join(root, "agents.md"), "root\n@./sub/mid.md");
    await writeFile(join(sub, "mid.md"), "mid\n@./detail.md");

    const result = await loadProjectInstructions(root);
    expect(result).toContain("nested detail");
  });
});
