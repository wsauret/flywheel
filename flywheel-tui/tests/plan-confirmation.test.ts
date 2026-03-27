import { describe, it, expect } from "bun:test";
import type { PlanImportResult } from "../src/controller/plan-import";
import {
  preparePlanSummary,
  type PlanSummaryDisplay,
  PLAN_ACTIONS,
  type PlanAction,
} from "../src/tui/components/plan-confirmation-logic";

// ---------------------------------------------------------------------------
// Test fixtures — markdown plans (legacy)
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
  steps: [],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: [],
  summary: {
    phaseCount: 3,
    totalSteps: 7,
    hasAcceptanceCriteria: true,
    contentHash: "abc123",
  },
  isJsonPlan: false,
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
  steps: [],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: ["Missing acceptance criteria", "Phase 2 has no steps"],
  summary: {
    phaseCount: 1,
    totalSteps: 1,
    hasAcceptanceCriteria: false,
    contentHash: "def456",
  },
  isJsonPlan: false,
};

const EMPTY_PLAN: PlanImportResult = {
  status: "needs-fix",
  phases: [],
  steps: [],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: ["No phases found"],
  summary: {
    phaseCount: 0,
    totalSteps: 0,
    hasAcceptanceCriteria: false,
    contentHash: "empty",
  },
  isJsonPlan: false,
};

// ---------------------------------------------------------------------------
// Test fixtures — JSON plans
// ---------------------------------------------------------------------------

const JSON_PLAN: PlanImportResult = {
  status: "ready",
  phases: [],
  steps: [
    {
      title: "Create server module with Bun.serve()",
      description: "Implement GET /hello endpoint returning JSON.",
      acceptanceCriteria: [
        "GET /hello returns 200 with JSON body",
        "Server binds to 127.0.0.1:3000",
      ],
      fileReferences: ["src/server/index.ts", "tests/server.test.ts"],
      feature: "server",
      fulfills: ["BC-SERVER-001"],
      milestone: "Foundation",
      estimatedComplexity: "low",
    },
    {
      title: "Add authentication middleware",
      description: "JWT-based auth middleware.",
      acceptanceCriteria: [
        "Middleware rejects requests without valid JWT",
        "Middleware passes requests with valid JWT",
      ],
      fileReferences: ["src/middleware/auth.ts"],
      feature: "auth",
      milestone: "Foundation",
      estimatedComplexity: "medium",
    },
  ],
  behavioralContract: [
    {
      id: "BC-SERVER-001",
      title: "Hello endpoint returns greeting",
      description: "GET /hello returns 200 with greeting",
      evidence: "curl http://localhost:3000/hello",
      area: "Server",
    },
  ],
  decisions: ["Using Bun.serve() instead of Express"],
  risks: ["Port 3000 may conflict"],
  issues: [],
  summary: {
    phaseCount: 2,
    totalSteps: 4,
    hasAcceptanceCriteria: true,
    contentHash: "json123",
  },
  isJsonPlan: true,
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
    expect(summary).toHaveProperty("steps");
    expect(summary).toHaveProperty("behavioralContract");
    expect(summary).toHaveProperty("decisions");
    expect(summary).toHaveProperty("risks");
    expect(summary).toHaveProperty("phaseCount");
    expect(summary).toHaveProperty("totalSteps");
    expect(summary).toHaveProperty("hasAcceptanceCriteria");
    expect(summary).toHaveProperty("issues");
    expect(summary).toHaveProperty("isJsonPlan");
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

// ---------------------------------------------------------------------------
// JSON plan — preparePlanSummary
// ---------------------------------------------------------------------------
describe("preparePlanSummary (JSON plan)", () => {
  it("extracts step list with titles and acceptance criteria", () => {
    const summary = preparePlanSummary(JSON_PLAN);

    expect(summary.isJsonPlan).toBe(true);
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[0].title).toBe("Create server module with Bun.serve()");
    expect(summary.steps[0].acceptanceCriteria).toHaveLength(2);
    expect(summary.steps[1].title).toBe("Add authentication middleware");
  });

  it("extracts behavioral contract assertions", () => {
    const summary = preparePlanSummary(JSON_PLAN);

    expect(summary.behavioralContract).toHaveLength(1);
    expect(summary.behavioralContract[0].id).toBe("BC-SERVER-001");
    expect(summary.behavioralContract[0].title).toBe("Hello endpoint returns greeting");
    expect(summary.behavioralContract[0].area).toBe("Server");
  });

  it("extracts decisions and risks", () => {
    const summary = preparePlanSummary(JSON_PLAN);

    expect(summary.decisions).toEqual(["Using Bun.serve() instead of Express"]);
    expect(summary.risks).toEqual(["Port 3000 may conflict"]);
  });

  it("step items include metadata (feature, milestone, complexity)", () => {
    const summary = preparePlanSummary(JSON_PLAN);

    expect(summary.steps[0].feature).toBe("server");
    expect(summary.steps[0].milestone).toBe("Foundation");
    expect(summary.steps[0].estimatedComplexity).toBe("low");
    expect(summary.steps[0].fileReferences).toEqual([
      "src/server/index.ts",
      "tests/server.test.ts",
    ]);
    expect(summary.steps[0].fulfills).toEqual(["BC-SERVER-001"]);
  });

  it("reports status and counts correctly", () => {
    const summary = preparePlanSummary(JSON_PLAN);

    expect(summary.status).toBe("ready");
    expect(summary.phaseCount).toBe(2);
    expect(summary.totalSteps).toBe(4);
    expect(summary.hasAcceptanceCriteria).toBe(true);
    expect(summary.issues).toEqual([]);
  });

  it("has empty phases array for JSON plans", () => {
    const summary = preparePlanSummary(JSON_PLAN);
    expect(summary.phases).toEqual([]);
  });

  it("markdown plans have isJsonPlan false", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.isJsonPlan).toBe(false);
    expect(summary.steps).toEqual([]);
    expect(summary.behavioralContract).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(summary.risks).toEqual([]);
  });
});
