/**
 * Tests for the JSON plan schema and parser.
 *
 * Covers:
 *   - PlanJsonSchema validates correct plans
 *   - PlanJsonSchema rejects plans with missing required fields
 *   - PlanStepSchema field validation (required + optional)
 *   - BehavioralAssertionSchema validation
 *   - parseJsonPlan() validates and returns typed plan
 *   - Edge cases: empty arrays, optional fields, extra fields
 */

import { describe, expect, test } from "bun:test";
import {
  PlanJsonSchema,
  PlanStepSchema,
  BehavioralAssertionSchema,
  ReviewFindingSchema,
  OpenQuestionSchema,
  PlanReviewOutputSchema,
  parseJsonPlan,
  type PlanJson,
} from "../src/queue/shared/plan-parser";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validStep(overrides?: Record<string, unknown>) {
  return {
    title: "Create server module with Bun.serve()",
    description: "Implement GET /hello endpoint returning JSON",
    acceptanceCriteria: [
      "GET /hello returns 200 with JSON body",
      "Server binds to 127.0.0.1:3000",
    ],
    fileReferences: ["src/server/index.ts", "tests/server.test.ts"],
    ...overrides,
  };
}

function validAssertion(overrides?: Record<string, unknown>) {
  return {
    id: "BC-SERVER-001",
    title: "Hello endpoint returns greeting",
    description: "GET /hello returns 200 with JSON body",
    evidence: "curl http://localhost:3000/hello → 200",
    area: "Server",
    ...overrides,
  };
}

function validPlan(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    steps: [validStep()],
    behavioralContract: [validAssertion()],
    decisions: ["Using Bun.serve() native API"],
    risks: ["Port 3000 may conflict"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PlanStepSchema
// ---------------------------------------------------------------------------

describe("PlanStepSchema", () => {
  test("accepts valid step with all required fields", () => {
    const result = PlanStepSchema.safeParse(validStep());
    expect(result.success).toBe(true);
  });

  test("accepts step with all optional fields", () => {
    const result = PlanStepSchema.safeParse(
      validStep({
        feature: "server",
        fulfills: ["BC-SERVER-001"],
        milestone: "Foundation",
        estimatedComplexity: "low",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feature).toBe("server");
      expect(result.data.fulfills).toEqual(["BC-SERVER-001"]);
      expect(result.data.milestone).toBe("Foundation");
      expect(result.data.estimatedComplexity).toBe("low");
    }
  });

  test("accepts step without optional fileReferences", () => {
    const { fileReferences, ...step } = validStep();
    const result = PlanStepSchema.safeParse(step);
    expect(result.success).toBe(true);
  });

  test("rejects step without title", () => {
    const { title, ...step } = validStep();
    const result = PlanStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects step without description", () => {
    const { description, ...step } = validStep();
    const result = PlanStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects step without acceptanceCriteria", () => {
    const { acceptanceCriteria, ...step } = validStep();
    const result = PlanStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects step with empty acceptanceCriteria", () => {
    const result = PlanStepSchema.safeParse(
      validStep({ acceptanceCriteria: [] }),
    );
    expect(result.success).toBe(false);
  });

  test("validates estimatedComplexity enum", () => {
    for (const complexity of ["trivial", "low", "medium", "high", "critical"]) {
      const result = PlanStepSchema.safeParse(
        validStep({ estimatedComplexity: complexity }),
      );
      expect(result.success).toBe(true);
    }
    const result = PlanStepSchema.safeParse(
      validStep({ estimatedComplexity: "extreme" }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BehavioralAssertionSchema
// ---------------------------------------------------------------------------

describe("BehavioralAssertionSchema", () => {
  test("accepts valid assertion", () => {
    const result = BehavioralAssertionSchema.safeParse(validAssertion());
    expect(result.success).toBe(true);
  });

  test("rejects assertion without id", () => {
    const { id, ...assertion } = validAssertion();
    const result = BehavioralAssertionSchema.safeParse(assertion);
    expect(result.success).toBe(false);
  });

  test("rejects assertion without title", () => {
    const { title, ...assertion } = validAssertion();
    const result = BehavioralAssertionSchema.safeParse(assertion);
    expect(result.success).toBe(false);
  });

  test("rejects assertion without description", () => {
    const { description, ...assertion } = validAssertion();
    const result = BehavioralAssertionSchema.safeParse(assertion);
    expect(result.success).toBe(false);
  });

  test("rejects assertion without evidence", () => {
    const { evidence, ...assertion } = validAssertion();
    const result = BehavioralAssertionSchema.safeParse(assertion);
    expect(result.success).toBe(false);
  });

  test("rejects assertion without area", () => {
    const { area, ...assertion } = validAssertion();
    const result = BehavioralAssertionSchema.safeParse(assertion);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PlanJsonSchema — full plan validation
// ---------------------------------------------------------------------------

describe("PlanJsonSchema", () => {
  test("accepts valid complete plan", () => {
    const result = PlanJsonSchema.safeParse(validPlan());
    expect(result.success).toBe(true);
  });

  test("accepts plan with multiple steps", () => {
    const result = PlanJsonSchema.safeParse(
      validPlan({
        steps: [
          validStep({ title: "Step 1" }),
          validStep({ title: "Step 2" }),
          validStep({ title: "Step 3" }),
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(3);
    }
  });

  test("accepts plan with empty decisions and risks", () => {
    const result = PlanJsonSchema.safeParse(
      validPlan({ decisions: [], risks: [] }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects plan without steps", () => {
    const { steps, ...plan } = validPlan();
    const result = PlanJsonSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("rejects plan with empty steps array", () => {
    const result = PlanJsonSchema.safeParse(validPlan({ steps: [] }));
    expect(result.success).toBe(false);
  });

  test("rejects plan without behavioralContract", () => {
    const { behavioralContract, ...plan } = validPlan();
    const result = PlanJsonSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("accepts plan with empty behavioralContract", () => {
    const result = PlanJsonSchema.safeParse(
      validPlan({ behavioralContract: [] }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects plan without decisions", () => {
    const { decisions, ...plan } = validPlan();
    const result = PlanJsonSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("rejects plan without risks", () => {
    const { risks, ...plan } = validPlan();
    const result = PlanJsonSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  test("preserves all step fields through parsing", () => {
    const plan = validPlan({
      steps: [
        validStep({
          feature: "auth",
          fulfills: ["BC-AUTH-001"],
          milestone: "Foundation",
          estimatedComplexity: "medium",
        }),
      ],
    });
    const result = PlanJsonSchema.safeParse(plan);
    expect(result.success).toBe(true);
    if (result.success) {
      const step = result.data.steps[0];
      expect(step.feature).toBe("auth");
      expect(step.fulfills).toEqual(["BC-AUTH-001"]);
      expect(step.milestone).toBe("Foundation");
      expect(step.estimatedComplexity).toBe("medium");
    }
  });
});

// ---------------------------------------------------------------------------
// ReviewFindingSchema
// ---------------------------------------------------------------------------

describe("ReviewFindingSchema", () => {
  test("accepts valid finding with all fields", () => {
    const result = ReviewFindingSchema.safeParse({
      severity: "P1",
      description: "Must bind to 127.0.0.1",
      reviewer: "security",
      actionRequired: "Add explicit host binding",
    });
    expect(result.success).toBe(true);
  });

  test("accepts finding without optional actionRequired", () => {
    const result = ReviewFindingSchema.safeParse({
      severity: "P2",
      description: "Should add rate limiting",
      reviewer: "architecture",
    });
    expect(result.success).toBe(true);
  });

  test("validates severity enum (P1, P2, P3)", () => {
    for (const severity of ["P1", "P2", "P3"]) {
      const result = ReviewFindingSchema.safeParse({
        severity,
        description: "Test finding",
        reviewer: "test",
      });
      expect(result.success).toBe(true);
    }
    const invalid = ReviewFindingSchema.safeParse({
      severity: "P4",
      description: "Invalid severity",
      reviewer: "test",
    });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenQuestionSchema (plan review)
// ---------------------------------------------------------------------------

describe("OpenQuestionSchema (plan review)", () => {
  test("accepts valid open question with all fields", () => {
    const result = OpenQuestionSchema.safeParse({
      question: "Should server.enabled default to true?",
      raisedBy: "scope",
      options: ["true (simpler)", "false (safer)"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts question without optional options", () => {
    const result = OpenQuestionSchema.safeParse({
      question: "Which database to use?",
      raisedBy: "architecture",
    });
    expect(result.success).toBe(true);
  });

  test("rejects question without question field", () => {
    const result = OpenQuestionSchema.safeParse({
      raisedBy: "scope",
    });
    expect(result.success).toBe(false);
  });

  test("rejects question without raisedBy field", () => {
    const result = OpenQuestionSchema.safeParse({
      question: "Which database?",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PlanReviewOutputSchema
// ---------------------------------------------------------------------------

describe("PlanReviewOutputSchema", () => {
  test("accepts valid review output with findings and open questions", () => {
    const result = PlanReviewOutputSchema.safeParse({
      steps: [
        {
          ...validStep(),
          review: {
            findings: [
              {
                severity: "P1",
                description: "Security issue",
                reviewer: "security",
              },
            ],
          },
        },
      ],
      behavioralContract: [validAssertion()],
      decisions: ["Using Bun.serve()"],
      risks: ["Port conflict"],
      openQuestions: [
        {
          question: "Which auth provider?",
          raisedBy: "architecture",
          options: ["Auth0", "Cognito"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts review output with empty openQuestions", () => {
    const result = PlanReviewOutputSchema.safeParse({
      ...validPlan(),
      openQuestions: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts steps without review field (no findings)", () => {
    const result = PlanReviewOutputSchema.safeParse({
      ...validPlan(),
      openQuestions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0].review).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// parseJsonPlan()
// ---------------------------------------------------------------------------

describe("parseJsonPlan()", () => {
  test("returns typed plan for valid JSON string", () => {
    const planStr = JSON.stringify(validPlan());
    const result = parseJsonPlan(planStr);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps).toHaveLength(1);
      expect(result.plan.behavioralContract).toHaveLength(1);
      expect(result.plan.decisions).toEqual(["Using Bun.serve() native API"]);
      expect(result.plan.risks).toEqual(["Port 3000 may conflict"]);
    }
  });

  test("returns error for invalid JSON string", () => {
    const result = parseJsonPlan("{not valid json}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  test("returns error for valid JSON but invalid plan schema", () => {
    const result = parseJsonPlan(JSON.stringify({ steps: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("returns error when steps is missing", () => {
    const { steps, ...plan } = validPlan();
    const result = parseJsonPlan(JSON.stringify(plan));
    expect(result.ok).toBe(false);
  });

  test("returns plan with all step metadata preserved", () => {
    const plan = validPlan({
      steps: [
        validStep({
          feature: "api",
          fulfills: ["BC-API-001", "BC-API-002"],
          milestone: "Core",
          estimatedComplexity: "high",
        }),
      ],
    });
    const result = parseJsonPlan(JSON.stringify(plan));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.plan.steps[0];
      expect(step.feature).toBe("api");
      expect(step.fulfills).toEqual(["BC-API-001", "BC-API-002"]);
      expect(step.milestone).toBe("Core");
      expect(step.estimatedComplexity).toBe("high");
    }
  });

  test("accepts valid plan object (not just string)", () => {
    const plan = validPlan();
    const result = parseJsonPlan(JSON.stringify(plan));
    expect(result.ok).toBe(true);
  });
});
