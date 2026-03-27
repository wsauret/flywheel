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

const VALID_JSON_PLAN_OBJ = {
  steps: [
    {
      title: "Setup project",
      description: "Create initial structure",
      acceptanceCriteria: ["Directory exists", "Config initialized"],
      fileReferences: ["src/index.ts"],
      feature: "setup",
    },
    {
      title: "Build core",
      description: "Implement models and tests",
      acceptanceCriteria: ["Models work", "Tests pass"],
    },
  ],
  behavioralContract: [
    {
      id: "BC-001",
      title: "Setup check",
      description: "Project is set up",
      evidence: "ls src/",
      area: "Setup",
    },
  ],
  decisions: ["Use Bun"],
  risks: ["None"],
};

const VALID_JSON_PLAN = JSON.stringify(VALID_JSON_PLAN_OBJ);

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
    it("imports a valid JSON plan from a file path", async () => {
      const filePath = writeTmpFile("valid-plan.plan.json", VALID_JSON_PLAN);
      const result = await importPlan({ filePath });

      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
      expect(result.issues).toEqual([]);
      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(4); // 2 + 2 acceptance criteria
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
      expect(result.summary.contentHash).toBe(sha256(VALID_JSON_PLAN));
    });

    it("throws on non-existent file path", async () => {
      await expect(
        importPlan({ filePath: "/nonexistent/path/plan.json" }),
      ).rejects.toThrow();
    });
  });

  describe("pasted text ingestion", () => {
    it("imports a valid JSON plan from pasted text", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
      expect(result.issues).toEqual([]);
    });
  });

  describe("valid plan produces confirmation data", () => {
    it("summary contains step count, total criteria, criteria flag, and content hash", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(4);
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
      expect(result.summary.contentHash).toBe(sha256(VALID_JSON_PLAN));
    });

    it("steps contain titles and acceptance criteria", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.steps[0].title).toBe("Setup project");
      expect(result.steps[0].acceptanceCriteria).toEqual(["Directory exists", "Config initialized"]);
      expect(result.steps[1].title).toBe("Build core");
      expect(result.steps[1].acceptanceCriteria).toEqual(["Models work", "Tests pass"]);
    });
  });

  describe("invalid plan produces issues list", () => {
    it("returns needs-fix for empty JSON plan (no steps)", async () => {
      const result = await importPlan('{"steps": []}');

      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("returns needs-fix with issues for empty content", async () => {
      const result = await importPlan("");

      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("returns needs-fix for malformed JSON", async () => {
      const result = await importPlan("{invalid json}");

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("needs-fix");
      expect(result.issues[0]).toContain("JSON");
    });
  });

  describe("JSON plan import", () => {
    it("imports a valid JSON plan from pasted text", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].title).toBe("Setup project");
      expect(result.steps[0].acceptanceCriteria).toEqual(["Directory exists", "Config initialized"]);
      expect(result.steps[0].feature).toBe("setup");
    });

    it("imports behavioral contract from JSON plan", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.behavioralContract).toHaveLength(1);
      expect(result.behavioralContract[0].id).toBe("BC-001");
      expect(result.behavioralContract[0].area).toBe("Setup");
    });

    it("imports decisions and risks from JSON plan", async () => {
      const result = await importPlan(VALID_JSON_PLAN);

      expect(result.decisions).toEqual(["Use Bun"]);
      expect(result.risks).toEqual(["None"]);
    });

    it("imports JSON plan from .plan.json file path", async () => {
      const filePath = writeTmpFile("feat-hello.plan.json", VALID_JSON_PLAN);
      const result = await importPlan({ filePath });

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.steps).toHaveLength(2);
    });

    it("returns needs-fix for invalid JSON plan", async () => {
      const result = await importPlan('{"steps": []}');

      expect(result.isJsonPlan).toBe(true);
      expect(result.status).toBe("needs-fix");
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("returns needs-fix for malformed JSON", async () => {
      const result = await importPlan("{invalid json}");

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

      expect(result.summary.phaseCount).toBe(2);
      expect(result.summary.totalSteps).toBe(4);
      expect(result.summary.hasAcceptanceCriteria).toBe(true);
    });
  });
});
