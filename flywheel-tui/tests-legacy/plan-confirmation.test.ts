import { describe, it, expect } from "bun:test";
import type { PlanImportResult } from "../src/workflows/queue/shared/plan-import";
import {
  preparePlanSummary,
  type PlanSummaryDisplay,
  PLAN_ACTIONS,
  type PlanAction,
} from "../src/tui/components/plan-confirmation-logic";

// ---------------------------------------------------------------------------
// Test fixtures — JSON plans
// ---------------------------------------------------------------------------

const HEALTHY_PLAN: PlanImportResult = {
  status: "ready",
  steps: [
    {
      title: "Setup project structure",
      description: "Initialize the repo",
      acceptanceCriteria: ["Directories exist", "Config files present"],
    },
    {
      title: "Implement core features",
      description: "Build the main modules",
      acceptanceCriteria: ["Parser works", "Validator works", "Formatter works"],
    },
    {
      title: "Testing & polish",
      description: "Ensure quality",
      acceptanceCriteria: ["Unit tests pass", "Integration tests pass"],
    },
  ],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: [],
  summary: {
    stepCount: 3,
    totalSteps: 7,
    hasAcceptanceCriteria: true,
    contentHash: "abc123",
  },
  isJsonPlan: true,
};

const PLAN_WITH_ISSUES: PlanImportResult = {
  status: "needs-fix",
  steps: [],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: ["Missing acceptance criteria", "Step 2 has no steps"],
  summary: {
    stepCount: 1,
    totalSteps: 1,
    hasAcceptanceCriteria: false,
    contentHash: "def456",
  },
  isJsonPlan: true,
};

const EMPTY_PLAN: PlanImportResult = {
  status: "needs-fix",
  steps: [],
  behavioralContract: [],
  decisions: [],
  risks: [],
  issues: ["No steps found"],
  summary: {
    stepCount: 0,
    totalSteps: 0,
    hasAcceptanceCriteria: false,
    contentHash: "empty",
  },
  isJsonPlan: true,
};

// ---------------------------------------------------------------------------
// Test fixtures — JSON plans
// ---------------------------------------------------------------------------

const JSON_PLAN: PlanImportResult = {
  status: "ready",
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
    stepCount: 2,
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
  it("extracts step list with titles and acceptance criteria", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);

    expect(summary.steps).toHaveLength(3);
    expect(summary.steps[0].title).toBe("Setup project structure");
    expect(summary.steps[0].acceptanceCriteria).toEqual(["Directories exist", "Config files present"]);
    expect(summary.steps[1].title).toBe("Implement core features");
    expect(summary.steps[2].title).toBe("Testing & polish");
    // Only JSON plans are supported
  });

  it("reports total step and step counts", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.stepCount).toBe(3);
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
      "Step 2 has no steps",
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

  it("handles empty plan (no steps)", () => {
    const summary = preparePlanSummary(EMPTY_PLAN);
    expect(summary.steps).toEqual([]);
    expect(summary.stepCount).toBe(0);
    expect(summary.totalSteps).toBe(0);
    expect(summary.issues).toEqual(["No steps found"]);
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
    expect(summary).toHaveProperty("steps");
    expect(summary).toHaveProperty("behavioralContract");
    expect(summary).toHaveProperty("decisions");
    expect(summary).toHaveProperty("risks");
    expect(summary).toHaveProperty("stepCount");
    expect(summary).toHaveProperty("totalSteps");
    expect(summary).toHaveProperty("hasAcceptanceCriteria");
    expect(summary).toHaveProperty("issues");
    expect(summary).toHaveProperty("isJsonPlan");
  });

  it("only JSON plans are supported — no legacy markdown steps", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.isJsonPlan).toBe(true);
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
    expect(summary.stepCount).toBe(2);
    expect(summary.totalSteps).toBe(4);
    expect(summary.hasAcceptanceCriteria).toBe(true);
    expect(summary.issues).toEqual([]);
  });

  it("all plans are JSON native — isJsonPlan is true", () => {
    const summary = preparePlanSummary(HEALTHY_PLAN);
    expect(summary.isJsonPlan).toBe(true);
  });
});
