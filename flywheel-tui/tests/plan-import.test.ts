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

  // -----------------------------------------------------------------------
  // JSON plan import
  // -----------------------------------------------------------------------
  describe("JSON plan import", () => {
    const VALID_JSON_PLAN = JSON.stringify({
      steps: [
        {
          title: "Create server module",
          description: "Implement GET /hello endpoint",
          acceptanceCriteria: ["Returns 200", "JSON body"],
          fileReferences: ["src/server.ts"],
          feature: "server",
          fulfills: ["BC-001"],
          milestone: "Foundation",
          estimatedComplexity: "low",
        },
        {
          title: "Add auth middleware",
          description: "JWT validation middleware",
          acceptanceCriteria: ["Rejects invalid JWT"],
          feature: "auth",
        },
      ],
      behavioralContract: [
        {
          id: "BC-001",
          title: "Hello endpoint",
          description: "Returns 200 with greeting",
          evidence: "curl http://localhost:3000/hello",
          area: "Server",
        },
      ],
      decisions: ["Use Bun.serve()"],
      risks: ["Port 3000 conflict"],
    });

    it("imports a valid JSON plan from pasted text", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].title).toBe("Create server module");
      expect(result.steps[0].acceptanceCriteria).toEqual(["Returns 200", "JSON body"]);
      expect(result.steps[0].feature).toBe("server");
      expect(result.phases).toEqual([]); // Empty for JSON plans
    });

    it("imports behavioral contract from JSON plan", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.behavioralContract).toHaveLength(1);
      expect(result.behavioralContract[0].id).toBe("BC-001");
      expect(result.behavioralContract[0].area).toBe("Server");
    });

    it("imports decisions and risks from JSON plan", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.decisions).toEqual(["Use Bun.serve()"]);
      expect(result.risks).toEqual(["Port 3000 conflict"]);
    });

    it("imports JSON plan from .plan.json file path", async () => {
      const filePath = writeTmpFile("feat-hello.plan.json", VALID_JSON_PLAN);
      const result = await importPlan({ filePath });

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
    });

    it("returns needs-fix for invalid JSON plan", async () => {
      const result = await importPlan('{"steps": []}'); // Empty steps — fails min(1)

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("returns needs-fix for malformed JSON", async () => {
      const result = await importPlan("{invalid json}");

      // Content starts with { and ends with } — treated as JSON attempt
      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("needs-fix");
      expect(result.issues[0]).toContain("JSON");
    });

    it("computes content hash for JSON plans", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.summary.contentHash).toBe(sha256(VALID_JSON_PLAN));
      expect(result.summary.contentHash.length).toBe(64);
    });

    it("summary counts steps as phaseCount and criteria as totalSteps", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.summary.phaseCount).toBe(2); // 2 steps
      expect(result.summary.totalSteps).toBe(3); // 2 + 1 criteria total
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
    });

    it("markdown plans have isJsonPlan false", async () => {
      const result = await importPlan(VALID_PLAN);
      expect(result.isJsonPlan).toBe(false);
      expect(result.steps).toEqual([]);
      expect(result.behavioralContract).toEqual([]);
    });
  });
});
