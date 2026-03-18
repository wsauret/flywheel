import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractPlanPath,
  verifyPlanFile,
  scanForNewPlan,
} from "../src/workflows/plan-output-extractor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-plan-extract-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// extractPlanPath
// ---------------------------------------------------------------------------

describe("extractPlanPath", () => {
  it("extracts feat-<description>.md from worker output", async () => {
    const output = `
I've created the plan file at docs/plans/feat-auth-jwt.md with all phases.

Here's a summary of what was done...
    `;
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-auth-jwt.md");
  });

  it("extracts fix-<description>.md from worker output", async () => {
    const output = "Plan saved to docs/plans/fix-memory-leak.md";
    const result = await extractPlanPath(output);
    expect(result).toBe("fix-memory-leak.md");
  });

  it("extracts refactor-<description>.md from worker output", async () => {
    const output = "Created `docs/plans/refactor-event-system.md`";
    const result = await extractPlanPath(output);
    expect(result).toBe("refactor-event-system.md");
  });

  it("extracts chore-<description>.md from worker output", async () => {
    const output = "The plan has been written to docs/plans/chore-update-deps.md.";
    const result = await extractPlanPath(output);
    expect(result).toBe("chore-update-deps.md");
  });

  it("extracts docs-<description>.md from worker output", async () => {
    const output = "See docs/plans/docs-api-reference.md for the full plan.";
    const result = await extractPlanPath(output);
    expect(result).toBe("docs-api-reference.md");
  });

  it("handles backtick-wrapped paths", async () => {
    const output = "Plan written to `docs/plans/feat-new-feature.md`";
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-new-feature.md");
  });

  it("handles full path references", async () => {
    const output = "File created at /home/user/project/docs/plans/feat-widget.md";
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-widget.md");
  });

  it("returns the last match when multiple plan filenames appear", async () => {
    const output = `
Originally I considered docs/plans/feat-old-name.md but renamed to
docs/plans/feat-final-name.md which is the consolidated version.
    `;
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-final-name.md");
  });

  it("returns null when no plan filename found", async () => {
    const output = "No plan was created. Something went wrong.";
    const result = await extractPlanPath(output);
    expect(result).toBeNull();
  });

  it("returns null for empty output", async () => {
    const result = await extractPlanPath("");
    expect(result).toBeNull();
  });

  it("returns null for output with .md files that don't match type pattern", async () => {
    const output = "Created README.md and CHANGELOG.md";
    const result = await extractPlanPath(output);
    expect(result).toBeNull();
  });

  it("handles multi-word kebab-case descriptions", async () => {
    const output = "Plan: docs/plans/feat-add-user-auth-with-jwt-tokens.md";
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-add-user-auth-with-jwt-tokens.md");
  });

  it("extracts filenames with mixed-case words", async () => {
    const output = "Plan saved to docs/plans/feat-Add-Auth.md";
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-Add-Auth.md");
  });

  it("extracts filenames with mixed-case and numbers", async () => {
    const output = "Created docs/plans/feat-OAuth2-Setup.md for the feature.";
    const result = await extractPlanPath(output);
    expect(result).toBe("feat-OAuth2-Setup.md");
  });
});

// ---------------------------------------------------------------------------
// verifyPlanFile
// ---------------------------------------------------------------------------

describe("verifyPlanFile", () => {
  it("returns full path when file exists in docs/plans/", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "feat-test.md"), "# Plan");

    const result = await verifyPlanFile(dir, "feat-test.md");
    expect(result).toBe(path.join(plansDir, "feat-test.md"));
  });

  it("returns null when file does not exist", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const result = await verifyPlanFile(dir, "feat-nonexistent.md");
    expect(result).toBeNull();
  });

  it("returns null when docs/plans/ directory does not exist", async () => {
    const dir = ensureTmpDir();

    const result = await verifyPlanFile(dir, "feat-test.md");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scanForNewPlan
// ---------------------------------------------------------------------------

describe("scanForNewPlan", () => {
  it("finds a newly created plan file after beforeTimestamp", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    // Create a file with a timestamp in the past
    const oldFile = path.join(plansDir, "feat-old.md");
    fs.writeFileSync(oldFile, "# Old Plan");
    // Set mtime to the past
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, pastTime, pastTime);

    const beforeTimestamp = Date.now() - 30_000; // 30 seconds ago

    // Create a new file (will have current mtime)
    const newFile = path.join(plansDir, "feat-new-feature.md");
    fs.writeFileSync(newFile, "# New Plan");

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBe("feat-new-feature.md");
  });

  it("returns the most recently modified file when multiple new files exist", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const beforeTimestamp = Date.now() - 1000;

    // Create two new files
    const file1 = path.join(plansDir, "feat-first.md");
    fs.writeFileSync(file1, "# First");
    // Set slightly older mtime
    const olderTime = new Date(Date.now() - 500);
    fs.utimesSync(file1, olderTime, olderTime);

    const file2 = path.join(plansDir, "feat-second.md");
    fs.writeFileSync(file2, "# Second");
    // This one has the latest mtime (now)

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBe("feat-second.md");
  });

  it("only matches files with valid type prefixes", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const beforeTimestamp = Date.now() - 1000;

    // Create a non-matching file
    fs.writeFileSync(path.join(plansDir, "README.md"), "# Readme");
    // Create a matching file
    fs.writeFileSync(path.join(plansDir, "fix-bug.md"), "# Fix");

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBe("fix-bug.md");
  });

  it("returns null when no new plan files exist after beforeTimestamp", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    // Create a file with old mtime
    const oldFile = path.join(plansDir, "feat-old.md");
    fs.writeFileSync(oldFile, "# Old");
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, pastTime, pastTime);

    const beforeTimestamp = Date.now();

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBeNull();
  });

  it("returns null when docs/plans/ directory does not exist", async () => {
    const dir = ensureTmpDir();

    const result = await scanForNewPlan(dir, Date.now() - 1000);
    expect(result).toBeNull();
  });

  it("returns null when docs/plans/ is empty", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const result = await scanForNewPlan(dir, Date.now() - 1000);
    expect(result).toBeNull();
  });

  it("excludes files ending in .context.md, .state.md, and .baseline.md", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const beforeTimestamp = Date.now() - 1000;

    // Create excluded metadata files (these match the plan pattern but should be filtered)
    fs.writeFileSync(path.join(plansDir, "feat-auth.context.md"), "# Context");
    fs.writeFileSync(path.join(plansDir, "feat-auth.state.md"), "# State");
    fs.writeFileSync(path.join(plansDir, "feat-auth.baseline.md"), "# Baseline");

    // Create a valid plan file
    fs.writeFileSync(path.join(plansDir, "feat-auth.md"), "# Plan");

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBe("feat-auth.md");
  });

  it("returns null when only excluded metadata files exist", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const beforeTimestamp = Date.now() - 1000;

    // Only metadata files — no valid plan
    fs.writeFileSync(path.join(plansDir, "feat-setup.context.md"), "# Context");
    fs.writeFileSync(path.join(plansDir, "feat-setup.state.md"), "# State");
    fs.writeFileSync(path.join(plansDir, "feat-setup.baseline.md"), "# Baseline");

    const result = await scanForNewPlan(dir, beforeTimestamp);
    expect(result).toBeNull();
  });
});
