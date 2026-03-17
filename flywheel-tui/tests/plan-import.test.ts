import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { importPlan } from "../src/controller/plan-import";
import type { PlanImportResult } from "../src/controller/plan-import";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TMP_DIR = path.join(
  os.tmpdir(),
  `flywheel-import-test-${process.pid}-${Date.now()}`,
);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function writeTmpFile(name: string, content: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Inline test fixtures
// ---------------------------------------------------------------------------

const VALID_PLAN = `# Plan: Complete

## Overview
Build it.

### Phase 1: Setup

- [ ] Create structure
- [ ] Initialize config

### Phase 2: Build

- [ ] Write models
- [ ] Add tests

## Acceptance Criteria

- All tests pass
`;

const VALID_PLAN_CRLF = VALID_PLAN.replace(/\n/g, "\r\n");

const INVALID_PLAN_NO_PHASES = `# Plan: Empty

## Overview
Nothing here.

## Acceptance Criteria
- Something
`;

const INVALID_PLAN_NO_STEPS = `# Plan: No Steps

### Phase 1: Setup

Just prose, no checklist items.

### Phase 2: Build

More prose.

## Acceptance Criteria
- Something
`;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importPlan", () => {
  describe("file path ingestion", () => {
    it("imports a valid plan from a file path", async () => {
      const filePath = writeTmpFile("valid-plan.md", VALID_PLAN);
      const result = await importPlan({ filePath });

      expect(result.status).toBe("ready");
      expect(result.phases).toHaveLength(2);
      expect(result.issues).toEqual([]);
      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(4);
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
      expect(result.summary.contentHash).toBe(sha256(VALID_PLAN));
    });

    it("imports from existing fixture file path", async () => {
      const filePath = path.join(FIXTURES_DIR, "two-phase-plan.md");
      const result = await importPlan({ filePath });

      // The fixture has no acceptance criteria section
      expect(result.phases).toHaveLength(2);
      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(6);
    });

    it("throws on non-existent file path", async () => {
      await expect(
        importPlan({ filePath: "/nonexistent/path/plan.md" }),
      ).rejects.toThrow();
    });
  });

  describe("pasted text ingestion", () => {
    it("imports a valid plan from pasted text", async () => {
      const result = await importPlan(VALID_PLAN);

      expect(result.status).toBe("ready");
      expect(result.phases).toHaveLength(2);
      expect(result.issues).toEqual([]);
    });

    it("normalizes CRLF in pasted text", async () => {
      const result = await importPlan(VALID_PLAN_CRLF);

      expect(result.status).toBe("ready");
      expect(result.phases).toHaveLength(2);
      // Content hash should be computed on the normalized content
      expect(result.summary.contentHash).toBe(sha256(VALID_PLAN));
    });
  });

  describe("valid plan produces confirmation data", () => {
    it("summary contains phase count, total steps, criteria flag, and content hash", async () => {
      const result = await importPlan(VALID_PLAN);

      expect(result.summary).toEqual({
        phaseCount: 2,
        totalSteps: 4,
        hasAcceptanceCriteria: true,
        contentHash: sha256(VALID_PLAN),
      });
    });

    it("phases contain titles and steps", async () => {
      const result = await importPlan(VALID_PLAN);

      expect(result.phases[0].title).toBe("Setup");
      expect(result.phases[0].steps).toEqual([
        "Create structure",
        "Initialize config",
      ]);
      expect(result.phases[1].title).toBe("Build");
      expect(result.phases[1].steps).toEqual(["Write models", "Add tests"]);
    });
  });

  describe("invalid plan produces issues list", () => {
    it("returns needs-fix when plan has no phases", async () => {
      const result = await importPlan(INVALID_PLAN_NO_PHASES);

      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => /phase/i.test(i))).toBe(true);
      expect(result.phases).toHaveLength(0);
    });

    it("returns needs-fix when phases have no steps", async () => {
      const result = await importPlan(INVALID_PLAN_NO_STEPS);

      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => /step/i.test(i))).toBe(true);
    });

    it("returns needs-fix with issues for empty content", async () => {
      const result = await importPlan("");

      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("still populates summary even on needs-fix", async () => {
      const result = await importPlan(INVALID_PLAN_NO_STEPS);

      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(0);
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
      expect(typeof result.summary.contentHash).toBe("string");
      expect(result.summary.contentHash.length).toBe(64); // sha256 hex
    });
  });
});
