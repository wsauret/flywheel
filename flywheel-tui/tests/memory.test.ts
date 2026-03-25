import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractLearning, computeHash, CompoundDocSchema } from "../src/memory/extract";
import { SESMemoryRetriever } from "../src/memory/retrieve";
import type { ExtractionInput } from "../src/memory/extract";
import {
  createShipOnStepComplete,
  COMPOUND_STEP_INDEX,
} from "../src/workflows/ship-output-extractor";
import type { WorkerResult } from "../src/schemas/worker";
import type { CompoundDoc } from "../src/schemas/handoff";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_INPUT: ExtractionInput = {
  title: "Fix Docker compose on macOS",
  problem: "Docker compose v2 fails with volume permission errors on macOS Ventura.",
  solution: "Add :delegated flag to volume mounts in compose file.",
  tags: ["docker", "macos"],
  context: "Observed on M1 and M2 Macs with Docker Desktop 4.x",
};

const MINIMAL_INPUT: ExtractionInput = {
  title: "Min",
  problem: "p",
  solution: "s",
  tags: ["t"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let solutionsDir: string;
let draftsDir: string;

async function setupDirs() {
  const base = await mkdtemp(join(tmpdir(), "ses-memory-"));
  solutionsDir = join(base, "solutions");
  draftsDir = join(base, "drafts");
  await mkdir(solutionsDir, { recursive: true });
  await mkdir(draftsDir, { recursive: true });
  return base;
}

// ---------------------------------------------------------------------------
// CompoundDocSchema validation
// ---------------------------------------------------------------------------

describe("CompoundDocSchema", () => {
  it("accepts a valid extraction input", () => {
    const result = CompoundDocSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("requires non-empty title", () => {
    const result = CompoundDocSchema.safeParse({ ...VALID_INPUT, title: "" });
    expect(result.success).toBe(false);
  });

  it("requires non-empty problem", () => {
    const result = CompoundDocSchema.safeParse({ ...VALID_INPUT, problem: "" });
    expect(result.success).toBe(false);
  });

  it("requires non-empty solution", () => {
    const result = CompoundDocSchema.safeParse({ ...VALID_INPUT, solution: "" });
    expect(result.success).toBe(false);
  });

  it("requires at least one tag", () => {
    const result = CompoundDocSchema.safeParse({ ...VALID_INPUT, tags: [] });
    expect(result.success).toBe(false);
  });

  it("allows optional context", () => {
    const { context, ...noContext } = VALID_INPUT;
    const result = CompoundDocSchema.safeParse(noContext);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

describe("computeHash", () => {
  it("returns a 64-char hex SHA-256 string", () => {
    const hash = computeHash(VALID_INPUT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input -> same hash)", () => {
    expect(computeHash(VALID_INPUT)).toBe(computeHash(VALID_INPUT));
  });

  it("ignores key order (canonical sorting)", () => {
    const reversed: ExtractionInput = {
      tags: ["docker", "macos"],
      solution: "Add :delegated flag to volume mounts in compose file.",
      problem: "Docker compose v2 fails with volume permission errors on macOS Ventura.",
      title: "Fix Docker compose on macOS",
      context: "Observed on M1 and M2 Macs with Docker Desktop 4.x",
    };
    expect(computeHash(VALID_INPUT)).toBe(computeHash(reversed));
  });

  it("strips leading/trailing whitespace from fields", () => {
    const padded: ExtractionInput = {
      ...VALID_INPUT,
      title: "  Fix Docker compose on macOS  ",
      problem: "  Docker compose v2 fails with volume permission errors on macOS Ventura.  ",
      solution: "  Add :delegated flag to volume mounts in compose file.  ",
    };
    expect(computeHash(VALID_INPUT)).toBe(computeHash(padded));
  });

  it("sorts tags for canonical form", () => {
    const reordered: ExtractionInput = {
      ...VALID_INPUT,
      tags: ["macos", "docker"],
    };
    expect(computeHash(VALID_INPUT)).toBe(computeHash(reordered));
  });

  it("different content produces different hash", () => {
    const different: ExtractionInput = {
      ...VALID_INPUT,
      solution: "Use a different solution entirely.",
    };
    expect(computeHash(VALID_INPUT)).not.toBe(computeHash(different));
  });
});

// ---------------------------------------------------------------------------
// Extractor: extractLearning
// ---------------------------------------------------------------------------

describe("extractLearning", () => {
  let base: string;

  beforeEach(async () => {
    base = await setupDirs();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("writes a valid extraction to solutionsDir", () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    expect(result.written).toBe(true);
    expect(result.reason).toBe("success");
    expect(result.path.startsWith(solutionsDir)).toBe(true);
    expect(result.path.endsWith(".md")).toBe(true);
  });

  it("file contains YAML frontmatter with extraction_hash", async () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("type: compound");
    expect(content).toContain(`extraction_hash: "${result.hash}"`);
    expect(content).toContain("tags:");
    expect(content).toContain("## Problem");
    expect(content).toContain("## Solution");
  });

  it("file contains title in frontmatter", async () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain(`title: "Fix Docker compose on macOS"`);
  });

  it("file contains date in frontmatter", async () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const content = await readFile(result.path, "utf-8");
    // Date format: YYYY-MM-DD
    expect(content).toMatch(/date: "\d{4}-\d{2}-\d{2}"/);
  });

  it("file body includes problem and solution sections", async () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain(VALID_INPUT.problem);
    expect(content).toContain(VALID_INPUT.solution);
  });

  it("dedup: duplicate content is skipped", () => {
    const r1 = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const r2 = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    expect(r1.written).toBe(true);
    expect(r1.reason).toBe("success");
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe("duplicate");
    expect(r2.hash).toBe(r1.hash);
  });

  it("dedup: different content is NOT skipped", () => {
    const r1 = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const different = { ...VALID_INPUT, solution: "A completely different fix." };
    const r2 = extractLearning(different, { solutionsDir, draftsDir });
    expect(r1.written).toBe(true);
    expect(r2.written).toBe(true);
    expect(r1.hash).not.toBe(r2.hash);
  });

  it("invalid input → stored in draftsDir", () => {
    const invalid = { ...VALID_INPUT, title: "", problem: "" };
    const result = extractLearning(invalid as ExtractionInput, { solutionsDir, draftsDir });
    expect(result.written).toBe(true);
    expect(result.reason).toBe("validation_failed");
    expect(result.path.startsWith(draftsDir)).toBe(true);
  });

  it("invalid input is NOT written to solutionsDir", async () => {
    const invalid = { ...VALID_INPUT, title: "", problem: "" };
    extractLearning(invalid as ExtractionInput, { solutionsDir, draftsDir });
    const files = await readdir(solutionsDir);
    expect(files.length).toBe(0);
  });

  it("returns the correct hash even for invalid input", () => {
    const invalid = { ...VALID_INPUT, title: "" };
    const result = extractLearning(invalid as ExtractionInput, { solutionsDir, draftsDir });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates solutionsDir if it does not exist", async () => {
    const nested = join(base, "deep", "nested", "solutions");
    const result = extractLearning(VALID_INPUT, { solutionsDir: nested, draftsDir });
    expect(result.written).toBe(true);
    expect(result.path.startsWith(nested)).toBe(true);
  });

  it("creates draftsDir if it does not exist", async () => {
    const nested = join(base, "deep", "nested", "drafts");
    const invalid = { ...VALID_INPUT, title: "" };
    const result = extractLearning(invalid as ExtractionInput, { solutionsDir, draftsDir: nested });
    expect(result.written).toBe(true);
    expect(result.path.startsWith(nested)).toBe(true);
  });

  it("generates slug-based filename from title", () => {
    const result = extractLearning(VALID_INPUT, { solutionsDir, draftsDir });
    const filename = result.path.split("/").pop()!;
    expect(filename).toContain("fix-docker-compose-on-macos");
  });

  it("handles special characters in title for filename", () => {
    const special = { ...VALID_INPUT, title: "Fix: Docker's \"compose\" <v2> on macOS!" };
    const result = extractLearning(special, { solutionsDir, draftsDir });
    const filename = result.path.split("/").pop()!;
    // Should not contain special chars
    expect(filename).toMatch(/^[a-z0-9-]+\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Retriever: SESMemoryRetriever
// ---------------------------------------------------------------------------

describe("SESMemoryRetriever", () => {
  let base: string;

  beforeEach(async () => {
    base = await setupDirs();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // Helper: write a compound doc to solutionsDir
  async function writeSolutionFile(opts: {
    title: string;
    tags: string[];
    hash: string;
    problem: string;
    solution: string;
  }) {
    const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const filename = `${slug}.md`;
    const content = [
      "---",
      "type: compound",
      `title: "${opts.title}"`,
      `tags: [${opts.tags.join(", ")}]`,
      `date: "2026-03-16"`,
      `extraction_hash: "${opts.hash}"`,
      "---",
      "",
      "## Problem",
      opts.problem,
      "",
      "## Solution",
      opts.solution,
    ].join("\n");
    const filePath = join(solutionsDir, filename);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("isReady() returns false before indexing starts", () => {
    const retriever = new SESMemoryRetriever(solutionsDir);
    expect(retriever.isReady()).toBe(false);
    retriever.dispose();
  });

  it("returns empty results when not ready", () => {
    const retriever = new SESMemoryRetriever(solutionsDir);
    const results = retriever.retrieve(["docker"]);
    expect(results).toEqual([]);
    retriever.dispose();
  });

  it("isReady() returns true after indexing completes", async () => {
    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    expect(retriever.isReady()).toBe(true);
    retriever.dispose();
  });

  it("retrieves entries matching a single tag", async () => {
    await writeSolutionFile({
      title: "Docker Fix",
      tags: ["docker", "macos"],
      hash: "abc123",
      problem: "Docker fails",
      solution: "Fix it",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["docker"]);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Docker Fix");
    retriever.dispose();
  });

  it("retrieves entries matching multiple tags", async () => {
    await writeSolutionFile({
      title: "Docker Fix",
      tags: ["docker", "macos"],
      hash: "abc123",
      problem: "Docker fails",
      solution: "Fix it",
    });
    await writeSolutionFile({
      title: "Node Fix",
      tags: ["node", "macos"],
      hash: "def456",
      problem: "Node fails",
      solution: "Fix node",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["macos"]);
    expect(results.length).toBe(2);
    retriever.dispose();
  });

  it("ranks results by number of matching tags", async () => {
    await writeSolutionFile({
      title: "Docker+macOS Fix",
      tags: ["docker", "macos", "compose"],
      hash: "aaa",
      problem: "Docker fails",
      solution: "Fix it",
    });
    await writeSolutionFile({
      title: "macOS Only Fix",
      tags: ["macos"],
      hash: "bbb",
      problem: "macOS issue",
      solution: "Fix macOS",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["docker", "macos"]);
    // Docker+macOS Fix matches 2 tags, macOS Only Fix matches 1
    expect(results[0].title).toBe("Docker+macOS Fix");
    expect(results[1].title).toBe("macOS Only Fix");
    retriever.dispose();
  });

  it("respects maxResults limit", async () => {
    await writeSolutionFile({
      title: "Fix A",
      tags: ["tag"],
      hash: "h1",
      problem: "p1",
      solution: "s1",
    });
    await writeSolutionFile({
      title: "Fix B",
      tags: ["tag"],
      hash: "h2",
      problem: "p2",
      solution: "s2",
    });
    await writeSolutionFile({
      title: "Fix C",
      tags: ["tag"],
      hash: "h3",
      problem: "p3",
      solution: "s3",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["tag"], 2);
    expect(results.length).toBe(2);
    retriever.dispose();
  });

  it("returns empty for non-matching tags", async () => {
    await writeSolutionFile({
      title: "Docker Fix",
      tags: ["docker"],
      hash: "abc",
      problem: "p",
      solution: "s",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["python"]);
    expect(results).toEqual([]);
    retriever.dispose();
  });

  it("returns empty for empty solutions dir", async () => {
    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["anything"]);
    expect(results).toEqual([]);
    retriever.dispose();
  });

  it("entry includes filePath, hash, tags, content, and title", async () => {
    const fp = await writeSolutionFile({
      title: "Docker Fix",
      tags: ["docker"],
      hash: "abc123",
      problem: "Docker fails",
      solution: "Fix it",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const results = retriever.retrieve(["docker"]);
    expect(results[0].title).toBe("Docker Fix");
    expect(results[0].tags).toEqual(["docker"]);
    expect(results[0].hash).toBe("abc123");
    expect(results[0].filePath).toBe(fp);
    expect(results[0].content).toContain("Docker fails");
    retriever.dispose();
  });

  it("TTL re-read picks up new files after expiry", async () => {
    const retriever = new SESMemoryRetriever(solutionsDir, { ttlMs: 50 });
    await retriever.startIndexing();

    // Initially empty
    expect(retriever.retrieve(["newfile"])).toEqual([]);

    // Write a new file
    await writeSolutionFile({
      title: "New Entry",
      tags: ["newfile"],
      hash: "new123",
      problem: "new problem",
      solution: "new solution",
    });

    // Wait for TTL to expire and re-read
    await new Promise((r) => setTimeout(r, 100));

    const results = retriever.retrieve(["newfile"]);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("New Entry");
    retriever.dispose();
  });

  it("dispose stops the TTL timer", async () => {
    const retriever = new SESMemoryRetriever(solutionsDir, { ttlMs: 50 });
    await retriever.startIndexing();
    retriever.dispose();
    // Should not throw after dispose
    expect(retriever.isReady()).toBe(false);
  });

  it("handles malformed YAML files gracefully (skips them)", async () => {
    // Write a malformed file
    await writeFile(
      join(solutionsDir, "bad.md"),
      "---\nbroken: [yaml: {{{\n---\nno good",
      "utf-8",
    );
    await writeSolutionFile({
      title: "Good Entry",
      tags: ["good"],
      hash: "good123",
      problem: "good problem",
      solution: "good solution",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    // Should have parsed the good entry, skipped the bad one
    const results = retriever.retrieve(["good"]);
    expect(results.length).toBe(1);
    retriever.dispose();
  });

  it("getHashes() returns set of all extraction_hash values", async () => {
    await writeSolutionFile({
      title: "Fix A",
      tags: ["docker"],
      hash: "aaaa",
      problem: "p1",
      solution: "s1",
    });
    await writeSolutionFile({
      title: "Fix B",
      tags: ["node"],
      hash: "bbbb",
      problem: "p2",
      solution: "s2",
    });

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const hashes = retriever.getHashes();
    expect(hashes.size).toBe(2);
    expect(hashes.has("aaaa")).toBe(true);
    expect(hashes.has("bbbb")).toBe(true);
    retriever.dispose();
  });

  it("getHashes() returns empty set before indexing", () => {
    const retriever = new SESMemoryRetriever(solutionsDir);
    const hashes = retriever.getHashes();
    expect(hashes.size).toBe(0);
    retriever.dispose();
  });

  it("getHashes() excludes entries with empty hash", async () => {
    // Write a file with no extraction_hash
    await writeFile(
      join(solutionsDir, "no-hash.md"),
      '---\ntype: compound\ntitle: "No Hash"\ntags: [test]\ndate: "2026-03-22"\n---\n\n## Problem\np\n\n## Solution\ns',
      "utf-8",
    );

    const retriever = new SESMemoryRetriever(solutionsDir);
    await retriever.startIndexing();
    const hashes = retriever.getHashes();
    // Empty string hashes should be filtered out
    expect(hashes.has("")).toBe(false);
    retriever.dispose();
  });
});

// ---------------------------------------------------------------------------
// extractLearning with knownHashes
// ---------------------------------------------------------------------------

describe("extractLearning with knownHashes", () => {
  let base: string;

  beforeEach(async () => {
    base = await setupDirs();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("uses knownHashes for dedup instead of disk scan", () => {
    const hash = computeHash(VALID_INPUT);
    const knownHashes = new Set([hash]);

    const result = extractLearning(VALID_INPUT, {
      solutionsDir,
      draftsDir,
      knownHashes,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("duplicate");
  });

  it("writes when knownHashes does not contain the hash", () => {
    const knownHashes = new Set(["other-hash"]);

    const result = extractLearning(VALID_INPUT, {
      solutionsDir,
      draftsDir,
      knownHashes,
    });
    expect(result.written).toBe(true);
    expect(result.reason).toBe("success");
  });

  it("writes when knownHashes is empty", () => {
    const knownHashes = new Set<string>();

    const result = extractLearning(VALID_INPUT, {
      solutionsDir,
      draftsDir,
      knownHashes,
    });
    expect(result.written).toBe(true);
    expect(result.reason).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// createShipOnStepComplete (handoff-based)
// ---------------------------------------------------------------------------

describe("createShipOnStepComplete", () => {
  let base: string;
  let handoffsDir: string;

  beforeEach(async () => {
    base = await setupDirs();
    handoffsDir = join(base, ".flywheel", "handoffs");
    await mkdir(join(base, "docs", "solutions"), { recursive: true });
    await mkdir(join(base, ".flywheel", "cache", "ses-drafts"), { recursive: true });
    await mkdir(handoffsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Write a handoff file and return a WorkerResult pointing to it. */
  async function makeHandoffResult(handoff: Record<string, unknown>): Promise<WorkerResult> {
    const id = crypto.randomUUID();
    const handoffPath = join(handoffsDir, `${id}.json`);
    await writeFile(handoffPath, JSON.stringify(handoff));
    return {
      output: "",
      exitCode: 0,
      truncated: false,
      durationMs: 1000,
      handoffPath,
    };
  }

  function makeWorkerResult(): WorkerResult {
    return {
      output: "",
      exitCode: 0,
      truncated: false,
      durationMs: 1000,
      handoffPath: "",
    };
  }

  it("returns empty object for steps other than COMPOUND_STEP_INDEX", async () => {
    const hook = createShipOnStepComplete(base);
    const result = await hook(0, makeWorkerResult(), {});
    expect(result).toEqual({});
  });

  it("returns learningsExtracted: 0 when handoff has no compound_docs", async () => {
    const hook = createShipOnStepComplete(base);
    const wr = await makeHandoffResult({
      summary: "a".repeat(100),
    });
    const result = await hook(COMPOUND_STEP_INDEX, wr, {});
    expect(result.learningsExtracted).toBe(0);
  });

  it("extracts and writes compound docs from handoff", async () => {
    const hook = createShipOnStepComplete(base);
    const wr = await makeHandoffResult({
      summary: "a".repeat(100),
      compound_docs: [{
        title: "Fix Test Flakiness",
        type: "bug-fix",
        tags: ["testing", "flaky"],
        problem: "Tests were flaky due to timing.",
        solution: "Added retry logic with exponential backoff.",
        context: "CI environment with limited resources.",
      }],
    });

    const result = await hook(COMPOUND_STEP_INDEX, wr, {});
    expect(result.learningsExtracted).toBe(1);
    expect(result.learningsDuplicate).toBe(0);
    expect(result.learningsFailed).toBe(0);

    // Verify file was written
    const files = await readdir(join(base, ".flywheel", "solutions"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("fix-test-flakiness");
  });

  it("handles duplicate compound docs gracefully", async () => {
    const hook = createShipOnStepComplete(base);
    const doc: CompoundDoc = {
      title: "Same Learning",
      type: "bug-fix",
      tags: ["test"],
      problem: "A problem",
      solution: "A solution",
    };

    // First call writes
    const wr1 = await makeHandoffResult({ summary: "a".repeat(100), compound_docs: [doc] });
    await hook(COMPOUND_STEP_INDEX, wr1, {});

    // Second call should detect duplicate
    const wr2 = await makeHandoffResult({ summary: "a".repeat(100), compound_docs: [doc] });
    const result = await hook(COMPOUND_STEP_INDEX, wr2, {});
    expect(result.learningsExtracted).toBe(0);
    expect(result.learningsDuplicate).toBe(1);
  });

  it("uses knownHashes for dedup when provided", async () => {
    const hash = computeHash({
      title: "Known Learning",
      problem: "A problem",
      solution: "A solution",
      tags: ["test"],
    });
    const knownHashes = new Set([hash]);

    const hook = createShipOnStepComplete(base, knownHashes);
    const wr = await makeHandoffResult({
      summary: "a".repeat(100),
      compound_docs: [{
        title: "Known Learning",
        type: "bug-fix",
        tags: ["test"],
        problem: "A problem",
        solution: "A solution",
      }],
    });

    const result = await hook(COMPOUND_STEP_INDEX, wr, {});
    expect(result.learningsExtracted).toBe(0);
    expect(result.learningsDuplicate).toBe(1);

    // Nothing should be written to disk
    const files = await readdir(join(base, "docs", "solutions"));
    expect(files.length).toBe(0);
  });

  it("returns learningsExtracted: 0 when handoff read fails", async () => {
    const hook = createShipOnStepComplete(base);
    // Empty handoffPath means missing handoff
    const result = await hook(COMPOUND_STEP_INDEX, makeWorkerResult(), {});
    expect(result.learningsExtracted).toBe(0);
  });
});
