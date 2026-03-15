import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlan, extractPhaseTitles } from "../src/controller/plan-parser";
import type { ParsedStateFile } from "../src/state/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// 4.1 Plan parser tests
// ---------------------------------------------------------------------------

describe("Plan parser", () => {
  describe("parsePlan", () => {
    it("extracts phase list from plan markdown", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases).toHaveLength(2);
      expect(phases[0].index).toBe(0);
      expect(phases[0].title).toBe("Setup project structure");
      expect(phases[1].index).toBe(1);
      expect(phases[1].title).toBe("Implement core logic");
    });

    it("extracts steps from top-level checklist items", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases[0].steps).toEqual([
        "Create directory layout",
        "Initialize configuration files",
        "Set up build system",
      ]);
      expect(phases[1].steps).toEqual([
        "Write data models",
        "Implement business rules",
        "Add validation layer",
      ]);
    });

    it("includes description content under phase heading", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases[0].description).toContain(
        "Create the initial project structure",
      );
      expect(phases[1].description).toContain(
        "Build the main application logic",
      );
    });

    it("ignores indented sub-items for step extraction", () => {
      const content = readFixture("three-phase-plan.md");
      const phases = parsePlan(content);

      // Phase 1 has sub-items under the first step
      expect(phases[0].steps).toEqual([
        "Define entity relationships",
        "Create migration scripts",
        "Seed test data",
      ]);
      // Sub-items should NOT appear as steps
      expect(phases[0].steps).not.toContain("Sub-item: should be ignored by parser");
    });

    it("indented sub-items are included in description", () => {
      const content = readFixture("three-phase-plan.md");
      const phases = parsePlan(content);

      // Sub-items should still be in the description
      expect(phases[0].description).toContain("Sub-item: should be ignored by parser");
    });

    it("defaults all phases to pending when no state provided", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases[0].status).toBe("pending");
      expect(phases[1].status).toBe("pending");
    });

    it("defaults all phases to pending when null state provided", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content, null);

      expect(phases[0].status).toBe("pending");
      expect(phases[1].status).toBe("pending");
    });

    it("cross-references with state file by index", () => {
      const content = readFixture("two-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: { plan: "two-phase-plan.md", schema_version: 3 },
        title: "Two Phase Test",
        phases: [
          { name: "Setup project structure", status: "completed", annotations: {} },
          { name: "Implement core logic", status: "pending", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);

      expect(phases[0].status).toBe("completed");
      expect(phases[1].status).toBe("pending");
    });

    it("handles in_progress status from state file", () => {
      const content = readFixture("two-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [
          { name: "Setup project structure", status: "completed", annotations: {} },
          { name: "Implement core logic", status: "in_progress", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);

      expect(phases[0].status).toBe("completed");
      expect(phases[1].status).toBe("in_progress");
    });

    it("handles trailing annotations in state phases", () => {
      const content = readFixture("two-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [
          {
            name: "Setup project structure",
            status: "completed",
            annotations: { commit: "abc123" },
          },
          { name: "Implement core logic", status: "pending", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);
      expect(phases[0].status).toBe("completed");
    });

    it("handles three-phase plan with mixed statuses", () => {
      const content = readFixture("three-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [
          { name: "Database schema", status: "completed", annotations: {} },
          { name: "API endpoints", status: "pending", annotations: {} },
          { name: "Manual verification", status: "in_progress", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);

      expect(phases).toHaveLength(3);
      expect(phases[0].status).toBe("completed");
      expect(phases[1].status).toBe("pending");
      expect(phases[2].status).toBe("in_progress");
    });

    it("phases beyond state file length default to pending", () => {
      const content = readFixture("three-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [
          { name: "Database schema", status: "completed", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);

      expect(phases[0].status).toBe("completed");
      expect(phases[1].status).toBe("pending");
      expect(phases[2].status).toBe("pending");
    });

    it("handles empty plan content", () => {
      const phases = parsePlan("");
      expect(phases).toHaveLength(0);
    });

    it("handles plan with no phases", () => {
      const content = "# Some Plan\n\nNo phases here.\n";
      const phases = parsePlan(content);
      expect(phases).toHaveLength(0);
    });

    it("handles plan with empty state file phases", () => {
      const content = readFixture("two-phase-plan.md");
      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);
      expect(phases[0].status).toBe("pending");
      expect(phases[1].status).toBe("pending");
    });
  });

  describe("extractPhaseTitles", () => {
    it("extracts just the titles from plan markdown", () => {
      const content = readFixture("two-phase-plan.md");
      const titles = extractPhaseTitles(content);

      expect(titles).toEqual([
        "Setup project structure",
        "Implement core logic",
      ]);
    });

    it("handles three-phase plan", () => {
      const content = readFixture("three-phase-plan.md");
      const titles = extractPhaseTitles(content);

      expect(titles).toEqual([
        "Database schema",
        "API endpoints",
        "Manual verification",
      ]);
    });

    it("returns empty array for plan with no phases", () => {
      const titles = extractPhaseTitles("# No phases\n");
      expect(titles).toEqual([]);
    });
  });
});
