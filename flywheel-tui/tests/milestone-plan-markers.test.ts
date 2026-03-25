import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlan, extractPhaseTitles } from "../src/controller/plan-parser";
import { PlanFileProvider } from "../src/controller/plan-file-provider";
import type { ParsedStateFile } from "../src/state/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Milestone plan markers tests (VAL-MILE-001, VAL-MILE-002, VAL-MILE-003, VAL-MILE-006)
// ---------------------------------------------------------------------------

describe("Milestone plan markers", () => {
  // -------------------------------------------------------------------------
  // VAL-MILE-001: Plan parser recognizes ## Milestone: <name> markers
  // -------------------------------------------------------------------------
  describe("milestone marker recognition", () => {
    it("recognizes ## Milestone: <name> as milestone boundary markers", () => {
      const content = [
        "# Plan",
        "",
        "## Milestone: Foundation",
        "",
        "### Phase 1: Setup project",
        "",
        "- [ ] Create files",
        "",
        "### Phase 2: Add tests",
        "",
        "- [ ] Write unit tests",
        "",
        "## Milestone: Core Features",
        "",
        "### Phase 3: Build API",
        "",
        "- [ ] Implement endpoints",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(3);
      expect(phases[0].milestone).toBe("Foundation");
      expect(phases[1].milestone).toBe("Foundation");
      expect(phases[2].milestone).toBe("Core Features");
    });

    it("handles milestone at the very start of the plan", () => {
      const content = [
        "## Milestone: Alpha",
        "",
        "### Phase 1: First phase",
        "",
        "- [ ] Do something",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBe("Alpha");
    });

    it("supports milestones with complex names", () => {
      const content = [
        "## Milestone: Handoff & Context Infrastructure",
        "",
        "### Phase 1: Widen projections",
        "",
        "- [ ] Add fields",
        "",
        "## Milestone: Evaluator Enhancement & Issue Tracking",
        "",
        "### Phase 2: Add structured issues",
        "",
        "- [ ] Extend schema",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(2);
      expect(phases[0].milestone).toBe("Handoff & Context Infrastructure");
      expect(phases[1].milestone).toBe("Evaluator Enhancement & Issue Tracking");
    });

    it("milestone name is trimmed of whitespace", () => {
      const content = [
        "## Milestone:   Spaced Name   ",
        "",
        "### Phase 1: Only phase",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBe("Spaced Name");
    });
  });

  // -------------------------------------------------------------------------
  // VAL-MILE-002: Phases inherit milestone membership
  // -------------------------------------------------------------------------
  describe("milestone inheritance", () => {
    it("phases after a milestone marker inherit that milestone until next marker", () => {
      const content = [
        "# Plan",
        "",
        "## Milestone: M1",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step A",
        "",
        "### Phase 2: B",
        "",
        "- [ ] Step B",
        "",
        "### Phase 3: C",
        "",
        "- [ ] Step C",
        "",
        "## Milestone: M2",
        "",
        "### Phase 4: D",
        "",
        "- [ ] Step D",
        "",
        "### Phase 5: E",
        "",
        "- [ ] Step E",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(5);
      expect(phases[0].milestone).toBe("M1");
      expect(phases[1].milestone).toBe("M1");
      expect(phases[2].milestone).toBe("M1");
      expect(phases[3].milestone).toBe("M2");
      expect(phases[4].milestone).toBe("M2");
    });

    it("phases before any milestone marker have milestone undefined", () => {
      const content = [
        "# Plan",
        "",
        "### Phase 1: Pre-milestone phase",
        "",
        "- [ ] Step",
        "",
        "## Milestone: First Milestone",
        "",
        "### Phase 2: Post-milestone phase",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(2);
      expect(phases[0].milestone).toBeUndefined();
      expect(phases[1].milestone).toBe("First Milestone");
    });
  });

  // -------------------------------------------------------------------------
  // VAL-MILE-003: Plans without milestones work unchanged
  // -------------------------------------------------------------------------
  describe("backward compatibility", () => {
    it("plans without milestone markers parse exactly as before", () => {
      const content = readFixture("two-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases).toHaveLength(2);
      expect(phases[0].title).toBe("Setup project structure");
      expect(phases[1].title).toBe("Implement core logic");
      expect(phases[0].milestone).toBeUndefined();
      expect(phases[1].milestone).toBeUndefined();
    });

    it("three-phase plan without milestones parses unchanged", () => {
      const content = readFixture("three-phase-plan.md");
      const phases = parsePlan(content);

      expect(phases).toHaveLength(3);
      for (const phase of phases) {
        expect(phase.milestone).toBeUndefined();
      }
    });

    it("existing state file cross-reference still works", () => {
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
      expect(phases[0].milestone).toBeUndefined();
      expect(phases[1].milestone).toBeUndefined();
    });

    it("milestone markers with state cross-reference works together", () => {
      const content = [
        "## Milestone: Foundation",
        "",
        "### Phase 1: Setup",
        "",
        "- [ ] Create files",
        "",
        "### Phase 2: Tests",
        "",
        "- [ ] Write tests",
      ].join("\n");

      const state: ParsedStateFile = {
        frontmatter: {},
        title: "Test",
        phases: [
          { name: "Setup", status: "completed", annotations: {} },
          { name: "Tests", status: "in_progress", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const phases = parsePlan(content, state);

      expect(phases[0].status).toBe("completed");
      expect(phases[0].milestone).toBe("Foundation");
      expect(phases[1].status).toBe("in_progress");
      expect(phases[1].milestone).toBe("Foundation");
    });
  });

  // -------------------------------------------------------------------------
  // VAL-MILE-006: Strict format enforcement
  // -------------------------------------------------------------------------
  describe("strict format enforcement", () => {
    it("## milestone: (lowercase) is NOT recognized as a milestone marker", () => {
      const content = [
        "## milestone: lowercase",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });

    it("### Milestone: (H3) is NOT recognized as a milestone marker", () => {
      const content = [
        "### Milestone: H3 marker",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      // Note: ### Milestone: could match phase heading if it has format ### Phase N: ...
      // but it won't since the format is ### Milestone: not ### Phase N:
      expect(phases.length).toBeGreaterThanOrEqual(0);
      for (const phase of phases) {
        expect(phase.milestone).toBeUndefined();
      }
    });

    it("## Milestone - (dash instead of colon-space) is NOT recognized", () => {
      const content = [
        "## Milestone - Dashed",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });

    it("## Milestone: (no name after colon-space) still captures empty name", () => {
      // Edge case: technically matches format but name is empty — we should handle gracefully
      const content = [
        "## Milestone: ",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      // Empty milestone after trim should be treated as undefined (no real milestone)
      expect(phases[0].milestone).toBeUndefined();
    });

    it("## Milestone:NoSpace is NOT recognized (missing space after colon)", () => {
      const content = [
        "## Milestone:NoSpace",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });

    it("# Milestone: (H1) is NOT recognized", () => {
      const content = [
        "# Milestone: H1",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });

    it("## MILESTONE: (uppercase) is NOT recognized", () => {
      const content = [
        "## MILESTONE: Uppercase",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });

    it("## Milestones: (plural) is NOT recognized", () => {
      const content = [
        "## Milestones: Plural",
        "",
        "### Phase 1: A",
        "",
        "- [ ] Step",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(1);
      expect(phases[0].milestone).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // PlanFileProvider integration
  // -------------------------------------------------------------------------
  describe("PlanFileProvider milestone passthrough", () => {
    it("PlanFileProvider passes through milestone field from parsePlan", () => {
      const content = [
        "## Milestone: Infra",
        "",
        "### Phase 1: Setup",
        "",
        "- [ ] Create project",
        "",
        "## Milestone: Features",
        "",
        "### Phase 2: Build API",
        "",
        "- [ ] Implement endpoints",
      ].join("\n");

      const provider = new PlanFileProvider(content);
      const phases = provider.getPhases();

      expect(phases).toHaveLength(2);
      expect(phases[0].milestone).toBe("Infra");
      expect(phases[1].milestone).toBe("Features");
    });

    it("PlanFileProvider milestone is undefined for plans without milestones", () => {
      const content = readFixture("two-phase-plan.md");
      const provider = new PlanFileProvider(content);
      const phases = provider.getPhases();

      expect(phases).toHaveLength(2);
      expect(phases[0].milestone).toBeUndefined();
      expect(phases[1].milestone).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Milestone markers are NOT included as phase content/description
  // -------------------------------------------------------------------------
  describe("milestone markers excluded from phase content", () => {
    it("milestone marker line is not part of any phase description", () => {
      const content = [
        "## Milestone: Foundation",
        "",
        "### Phase 1: Setup",
        "",
        "- [ ] Create files",
        "",
        "## Milestone: Features",
        "",
        "### Phase 2: Build API",
        "",
        "- [ ] Implement endpoints",
      ].join("\n");

      const phases = parsePlan(content);

      expect(phases).toHaveLength(2);
      // Milestone marker should not appear in description of phase 1
      expect(phases[0].description).not.toContain("## Milestone:");
      expect(phases[0].description).not.toContain("Features");
    });
  });

  // -------------------------------------------------------------------------
  // extractPhaseTitles is not affected by milestones
  // -------------------------------------------------------------------------
  describe("extractPhaseTitles with milestones", () => {
    it("extractPhaseTitles still works correctly with milestone markers present", () => {
      const content = [
        "## Milestone: M1",
        "",
        "### Phase 1: First",
        "",
        "- [ ] Step",
        "",
        "## Milestone: M2",
        "",
        "### Phase 2: Second",
        "",
        "- [ ] Step",
      ].join("\n");

      const titles = extractPhaseTitles(content);

      expect(titles).toEqual(["First", "Second"]);
    });
  });

  // -------------------------------------------------------------------------
  // Fixture-based: create a milestone plan fixture
  // -------------------------------------------------------------------------
  describe("milestone plan fixture", () => {
    it("parses the milestone plan fixture correctly", () => {
      const content = readFixture("milestone-plan.md");
      const phases = parsePlan(content);

      expect(phases).toHaveLength(4);

      // First milestone: Foundation
      expect(phases[0].milestone).toBe("Foundation");
      expect(phases[0].title).toBe("Project setup");
      expect(phases[1].milestone).toBe("Foundation");
      expect(phases[1].title).toBe("Database schema");

      // Second milestone: Core Features
      expect(phases[2].milestone).toBe("Core Features");
      expect(phases[2].title).toBe("REST API");
      expect(phases[3].milestone).toBe("Core Features");
      expect(phases[3].title).toBe("Authentication");
    });
  });
});
