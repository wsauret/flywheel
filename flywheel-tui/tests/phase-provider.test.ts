import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseInfo, PhaseProvider } from "../src/controller/phase-provider";
import { PlanFileProvider } from "../src/controller/plan-file-provider";
import { WorkflowDefinitionProvider } from "../src/controller/workflow-def-provider";
import { parseStateFile } from "../src/state/reader";
import type { WorkflowDefinition } from "../src/schemas/workflow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// PhaseProvider contract tests
// ---------------------------------------------------------------------------

/**
 * Shared contract tests that apply to any PhaseProvider implementation.
 * Validates that all providers return the expected PhaseInfo shape.
 */
function contractTests(name: string, createProvider: () => PhaseProvider, expectedCount: number) {
  describe(`PhaseProvider contract: ${name}`, () => {
    it("getPhases() returns PhaseInfo[]", () => {
      const provider = createProvider();
      const phases = provider.getPhases();

      expect(Array.isArray(phases)).toBe(true);
      expect(phases.length).toBeGreaterThan(0);
    });

    it("phaseCount matches getPhases().length", () => {
      const provider = createProvider();
      expect(provider.phaseCount).toBe(provider.getPhases().length);
    });

    it("phaseCount returns expected count", () => {
      const provider = createProvider();
      expect(provider.phaseCount).toBe(expectedCount);
    });

    it("each phase has { index, title, description, status }", () => {
      const provider = createProvider();
      const phases = provider.getPhases();

      for (const phase of phases) {
        expect(typeof phase.index).toBe("number");
        expect(typeof phase.title).toBe("string");
        expect(phase.title.length).toBeGreaterThan(0);
        expect(typeof phase.description).toBe("string");
        expect(["completed", "pending", "in_progress"]).toContain(phase.status);
      }
    });

    it("phases have sequential 0-based indices", () => {
      const provider = createProvider();
      const phases = provider.getPhases();

      for (let i = 0; i < phases.length; i++) {
        expect(phases[i].index).toBe(i);
      }
    });

    it("getPhases() returns same reference on repeated calls (caching)", () => {
      const provider = createProvider();
      const first = provider.getPhases();
      const second = provider.getPhases();
      expect(first).toBe(second);
    });
  });
}

// ---------------------------------------------------------------------------
// PlanFileProvider
// ---------------------------------------------------------------------------

describe("PlanFileProvider", () => {
  const twoPhasePlan = readFixture("two-phase-plan.md");
  const threePhasePlan = readFixture("three-phase-plan.md");

  // Run shared contract tests
  contractTests(
    "PlanFileProvider (two-phase)",
    () => new PlanFileProvider(twoPhasePlan),
    2,
  );

  contractTests(
    "PlanFileProvider (three-phase)",
    () => new PlanFileProvider(threePhasePlan),
    3,
  );

  it("getPhases() returns PhaseInfo[] from a plan markdown file", () => {
    const provider = new PlanFileProvider(twoPhasePlan);
    const phases = provider.getPhases();

    expect(phases).toHaveLength(2);
    expect(phases[0].title).toBe("Setup project structure");
    expect(phases[1].title).toBe("Implement core logic");
  });

  it("phases include steps (checklist items)", () => {
    const provider = new PlanFileProvider(twoPhasePlan);
    const phases = provider.getPhases();

    expect(phases[0].steps).toBeDefined();
    expect(phases[0].steps!.length).toBe(3);
    expect(phases[0].steps).toContain("Create directory layout");
    expect(phases[0].steps).toContain("Initialize configuration files");
    expect(phases[0].steps).toContain("Set up build system");
  });

  it("getPhases() respects status from state file (completed phases)", () => {
    // Build a state where phase 1 is completed
    const stateContent = [
      "---",
      "plan: two-phase-plan.md",
      "status: in_progress",
      "schema_version: 3",
      "---",
      "",
      "# Execution State",
      "",
      "## Progress",
      "- [x] Phase 1: Setup project structure",
      "- [ ] Phase 2: Implement core logic",
      "",
      "## Key Decisions",
      "",
      "## Error Log",
      "| Error | Attempt | Approach | Outcome |",
      "|-------|---------|----------|---------|",
    ].join("\n");

    const state = parseStateFile(stateContent);
    const provider = new PlanFileProvider(twoPhasePlan, state);
    const phases = provider.getPhases();

    expect(phases[0].status).toBe("completed");
    expect(phases[1].status).toBe("pending");
  });

  it("getPhases() detects in_progress [~] phases from state file", () => {
    const stateContent = [
      "---",
      "plan: three-phase-plan.md",
      "status: in_progress",
      "schema_version: 3",
      "---",
      "",
      "# Execution State",
      "",
      "## Progress",
      "- [x] Phase 1: Database schema",
      "- [x] Phase 2: API endpoints",
      "- [~] Phase 3: Manual verification",
      "",
      "## Key Decisions",
      "",
      "## Error Log",
      "| Error | Attempt | Approach | Outcome |",
      "|-------|---------|----------|---------|",
    ].join("\n");

    const state = parseStateFile(stateContent);
    const provider = new PlanFileProvider(threePhasePlan, state);
    const phases = provider.getPhases();

    expect(phases[0].status).toBe("completed");
    expect(phases[1].status).toBe("completed");
    expect(phases[2].status).toBe("in_progress");
  });

  it("without state, all phases are pending", () => {
    const provider = new PlanFileProvider(twoPhasePlan);
    const phases = provider.getPhases();

    for (const phase of phases) {
      expect(phase.status).toBe("pending");
    }
  });

  it("fromFile() reads a plan file from disk", () => {
    const planPath = path.join(FIXTURES_DIR, "two-phase-plan.md");
    const provider = PlanFileProvider.fromFile(planPath);
    const phases = provider.getPhases();

    expect(phases).toHaveLength(2);
    expect(phases[0].title).toBe("Setup project structure");
  });

  it("fromFile() throws on missing file", () => {
    expect(() => PlanFileProvider.fromFile("/nonexistent/plan.md")).toThrow(
      "Plan file not found",
    );
  });

  it("description contains the full content under the phase heading", () => {
    const provider = new PlanFileProvider(twoPhasePlan);
    const phases = provider.getPhases();

    // Description should contain the checklist items
    expect(phases[0].description).toContain("Create directory layout");
    expect(phases[0].description).toContain("Initialize configuration files");
  });
});

// ---------------------------------------------------------------------------
// WorkflowDefinitionProvider
// ---------------------------------------------------------------------------

describe("WorkflowDefinitionProvider", () => {
  const testWorkflow: WorkflowDefinition = {
    name: "test-workflow",
    description: "A test workflow",
    steps: [
      { description: "Analyze the codebase" },
      { description: "Generate implementation plan" },
      { description: "Execute changes" },
    ],
  };

  const singleStepWorkflow: WorkflowDefinition = {
    name: "single-step",
    description: "One step only",
    steps: [{ description: "Do the thing" }],
  };

  // Run shared contract tests
  contractTests(
    "WorkflowDefinitionProvider (3-step)",
    () => new WorkflowDefinitionProvider(testWorkflow),
    3,
  );

  contractTests(
    "WorkflowDefinitionProvider (1-step)",
    () => new WorkflowDefinitionProvider(singleStepWorkflow),
    1,
  );

  it("getPhases() returns PhaseInfo[] from a WorkflowDefinition", () => {
    const provider = new WorkflowDefinitionProvider(testWorkflow);
    const phases = provider.getPhases();

    expect(phases).toHaveLength(3);
    expect(phases[0].title).toBe("Analyze the codebase");
    expect(phases[1].title).toBe("Generate implementation plan");
    expect(phases[2].title).toBe("Execute changes");
  });

  it("getPhases() always returns all phases as pending", () => {
    const provider = new WorkflowDefinitionProvider(testWorkflow);
    const phases = provider.getPhases();

    for (const phase of phases) {
      expect(phase.status).toBe("pending");
    }
  });

  it("phases have no steps (non-work workflows)", () => {
    const provider = new WorkflowDefinitionProvider(testWorkflow);
    const phases = provider.getPhases();

    for (const phase of phases) {
      expect(phase.steps).toBeUndefined();
    }
  });

  it("description matches step description", () => {
    const provider = new WorkflowDefinitionProvider(testWorkflow);
    const phases = provider.getPhases();

    expect(phases[0].description).toBe("Analyze the codebase");
    expect(phases[1].description).toBe("Generate implementation plan");
  });

  it("phaseCount matches workflow.steps.length", () => {
    const provider = new WorkflowDefinitionProvider(testWorkflow);
    expect(provider.phaseCount).toBe(3);
  });
});
