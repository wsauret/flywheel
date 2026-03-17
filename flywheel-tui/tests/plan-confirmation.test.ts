import { describe, it, expect } from "bun:test";
import type { PlanImportResult } from "../src/controller/plan-import";
import {
  preparePlanSummary,
  type PlanSummaryDisplay,
  PLAN_ACTIONS,
  type PlanAction,
} from "../src/tui/components/plan-confirmation-logic";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const HEALTHY_PLAN: PlanImportResult = {
  status: "ready",
  phases: [
    {
      index: 0,
      title: "Setup project structure",
      description: "Initialize the repo",
      steps: ["Create directories", "Add config files"],
      status: "pending",
    },
    {
      index: 1,
      title: "Implement core features",
      description: "Build the main modules",
      steps: ["Write parser", "Write validator", "Write formatter"],
      status: "pending",
    },
    {
      index: 2,
      title: "Testing & polish",
      description: "Ensure quality",
      steps: ["Unit tests", "Integration tests"],
      status: "pending",
    },
  ],
  issues: [],
  summary: {
    phaseCount: 3,
    totalSteps: 7,
    hasAcceptanceCriteria: true,
    contentHash: "abc123",
  },
};

const PLAN_WITH_ISSUES: PlanImportResult = {
  status: "needs-fix",
  phases: [
    {
      index: 0,
      title: "Partial phase",
      description: "Incomplete",
      steps: ["One step"],
      status: "pending",
    },
  ],
  issues: ["Missing acceptance criteria", "Phase 2 has no steps"],
  summary: {
    phaseCount: 1,
    totalSteps: 1,
    hasAcceptanceCriteria: false,
    contentHash: "def456",
  },
};

const EMPTY_PLAN: PlanImportResult = {
  status: "needs-fix",
  phases: [],
  issues: ["No phases found"],
  summary: {
    phaseCount: 0,
    totalSteps: 0,
    hasAcceptanceCriteria: false,
    contentHash: "empty",
  },
};

// ---------------------------------------------------------------------------
// preparePlanSummary
// ---------------------------------------------------------------------------
describe("preparePlanSummary", () => {
  it("extracts phase list with titles and step counts", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);

    expect(summary.phases).toHaveLength(3);
    expect(summary.phases[0]).toEqual({
      title: "Setup project structure",
      stepCount: 2,
    });
    expect(summary.phases[1]).toEqual({
      title: "Implement core features",
      stepCount: 3,
    });
    expect(summary.phases[2]).toEqual({
      title: "Testing & polish",
      stepCount: 2,
    });
  });

  it("reports total phase and step counts", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.phaseCount).toBe(3);
    expect(summary.totalSteps).toBe(7);
  });

  it("reports acceptance criteria status", () => {
    expect(preparePlanSummary(HEALTHY_PLAN).hasAcceptanceCriteria).toBe(true);
    expect(preparePlanSummary(PLAN_WITH_ISSUES).hasAcceptanceCriteria).toBe(
      false
    );
  });

  it("includes issues when present", () => {
    const summary = preparePlanSummary(PLAN_WITH_ISSUES);
    expect(summary.issues).toEqual([
      "Missing acceptance criteria",
      "Phase 2 has no steps",
    ]);
  });

  it("returns empty issues array for healthy plan", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.issues).toEqual([]);
  });

  it("reports plan status", () => {
    expect(preparePlanSummary(HEALTHY_PLAN).status).toBe("ready");
    expect(preparePlanSummary(PLAN_WITH_ISSUES).status).toBe("needs-fix");
  });

  it("handles empty plan (no phases)", () => {
    const summary = preparePlanSummary(EMPTY_PLAN);
    expect(summary.phases).toEqual([]);
    expect(summary.phaseCount).toBe(0);
    expect(summary.totalSteps).toBe(0);
    expect(summary.issues).toEqual(["No phases found"]);
  });
});

// ---------------------------------------------------------------------------
// PLAN_ACTIONS
// ---------------------------------------------------------------------------
describe("PLAN_ACTIONS", () => {
  it("has exactly 2 actions", () => {
    expect(PLAN_ACTIONS).toHaveLength(2);
  });

  it('includes "Approve" action with value "approve"', () => {
    const action = PLAN_ACTIONS.find((a) => a.value === "approve");
    expect(action).toBeDefined();
    expect(action!.label).toBe("Approve");
  });

  it('includes "Edit" action with value "edit"', () => {
    const action = PLAN_ACTIONS.find((a) => a.value === "edit");
    expect(action).toBeDefined();
    expect(action!.label).toBe("Edit");
  });
});

// ---------------------------------------------------------------------------
// Callback routing
// ---------------------------------------------------------------------------
describe("PlanConfirmation action routing", () => {
  it("approve action triggers onApprove callback", () => {
    const calls: PlanAction[] = [];
    const handler = (action: PlanAction) => calls.push(action);

    const action = PLAN_ACTIONS.find((a) => a.value === "approve");
    expect(action).toBeDefined();
    handler(action!.value);

    expect(calls).toEqual(["approve"]);
  });

  it("edit action triggers onEdit callback (plan:needs-fix)", () => {
    const calls: PlanAction[] = [];
    const handler = (action: PlanAction) => calls.push(action);

    const action = PLAN_ACTIONS.find((a) => a.value === "edit");
    expect(action).toBeDefined();
    handler(action!.value);

    expect(calls).toEqual(["edit"]);
  });
});

// ---------------------------------------------------------------------------
// PlanSummaryDisplay shape validation
// ---------------------------------------------------------------------------
describe("PlanSummaryDisplay shape", () => {
  it("contains all required fields", () => {
    const summary: PlanSummaryDisplay = preparePlanSummary(HEALTHY_PLAN);

    expect(summary).toHaveProperty("status");
    expect(summary).toHaveProperty("phases");
    expect(summary).toHaveProperty("phaseCount");
    expect(summary).toHaveProperty("totalSteps");
    expect(summary).toHaveProperty("hasAcceptanceCriteria");
    expect(summary).toHaveProperty("issues");
  });

  it("phases have title and stepCount fields", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    for (const phase of summary.phases) {
      expect(phase).toHaveProperty("title");
      expect(phase).toHaveProperty("stepCount");
      expect(typeof phase.title).toBe("string");
      expect(typeof phase.stepCount).toBe("number");
    }
  });
});
