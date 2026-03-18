import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/prompts/index";
import {
  buildWorkPhasePrompt,
  buildPlanResearchPrompt,
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  buildPlanConsolidatePrompt,
  buildReviewDispatchPrompt,
  buildShipPrompt,
  buildDebugPrompt,
} from "../src/prompts/index";
import {
  SEVERITY_DEFINITIONS,
  TDD_CYCLE,
  DOCUMENTARIAN_MODE,
  FILE_LINE_DISCIPLINE,
  READ_FULLY_RULE,
  LOCATOR_ANALYZER_PATTERN,
  SCOPE_DISCIPLINE,
  THREE_STRIKE_PROTOCOL,
  TOKEN_LIMITS,
  VERIFICATION_BANNED_PHRASES,
} from "../src/prompts/conventions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCtx: WorkflowStepContext = {
  planContent: "Implement user authentication with JWT tokens",
  keyDecisions: ["Using bcrypt for password hashing", "JWT expiry set to 24h"],
  fileReferences: ["src/auth/handler.ts", "src/middleware/jwt.ts"],
  projectCwd: "/home/user/project",
};

const minimalCtx: WorkflowStepContext = {
  planContent: "Fix the bug",
  keyDecisions: [],
  fileReferences: [],
};

// ---------------------------------------------------------------------------
// Orchestration leak phrases — must NEVER appear in any prompt output
// ---------------------------------------------------------------------------

const ORCHESTRATION_LEAKS = [
  "Phase 0:",
  "session.md",
  ".flywheel/session",
  "Ralph mode",
  "Ralph Mode",
  "question:",
  "carry on",
  "resume",
  "$ARGUMENTS",
];

// "Phase 1:" is allowed in draft/consolidate templates (it's a formatting example,
// not an orchestration cue). "checkpoint" is also not present in any template.
// We test those separately only for builders where they'd be actual leaks.

function assertNoOrchestrationLeaks(output: string) {
  for (const phrase of ORCHESTRATION_LEAKS) {
    expect(output).not.toContain(phrase);
  }
}

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

describe("conventions", () => {
  const allConstants: Record<string, string> = {
    SEVERITY_DEFINITIONS,
    TDD_CYCLE,
    DOCUMENTARIAN_MODE,
    FILE_LINE_DISCIPLINE,
    READ_FULLY_RULE,
    LOCATOR_ANALYZER_PATTERN,
    SCOPE_DISCIPLINE,
    THREE_STRIKE_PROTOCOL,
    TOKEN_LIMITS,
    VERIFICATION_BANNED_PHRASES,
  };

  it("all exported constants are non-empty strings", () => {
    for (const [_name, value] of Object.entries(allConstants)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("each constant starts with ## (heading format)", () => {
    for (const [_name, value] of Object.entries(allConstants)) {
      expect(value.startsWith("## ")).toBe(true);
    }
  });

  it("SEVERITY_DEFINITIONS contains P1, P2, P3", () => {
    expect(SEVERITY_DEFINITIONS).toContain("P1");
    expect(SEVERITY_DEFINITIONS).toContain("P2");
    expect(SEVERITY_DEFINITIONS).toContain("P3");
  });

  it("TDD_CYCLE contains RED, GREEN, REFACTOR", () => {
    expect(TDD_CYCLE).toContain("RED");
    expect(TDD_CYCLE).toContain("GREEN");
    expect(TDD_CYCLE).toContain("REFACTOR");
  });

  it("VERIFICATION_BANNED_PHRASES contains all banned words", () => {
    const banned = [
      "Done",
      "Fixed",
      "Complete",
      "Passing",
      "Working",
      "Should work",
      "Probably",
      "Seems to",
      "Great!",
      "Perfect!",
      "Looks good!",
    ];
    for (const word of banned) {
      expect(VERIFICATION_BANNED_PHRASES).toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// buildWorkPhasePrompt
// ---------------------------------------------------------------------------

describe("buildWorkPhasePrompt", () => {
  it("produces non-empty output", () => {
    const result = buildWorkPhasePrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildWorkPhasePrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("includes key decisions", () => {
    const result = buildWorkPhasePrompt(baseCtx);
    for (const d of baseCtx.keyDecisions) {
      expect(result).toContain(d);
    }
  });

  it("includes file references", () => {
    const result = buildWorkPhasePrompt(baseCtx);
    for (const f of baseCtx.fileReferences) {
      expect(result).toContain(f);
    }
  });

  it("handles minimal context without crashing", () => {
    const result = buildWorkPhasePrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildWorkPhasePrompt(baseCtx);
    for (const kw of [
      "TDD",
      "Verification Protocol",
      "Two-Stage Review",
      "Evidence Requirements",
      "Banned Phrases",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildWorkPhasePrompt(baseCtx));
    assertNoOrchestrationLeaks(buildWorkPhasePrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// buildPlanResearchPrompt
// ---------------------------------------------------------------------------

describe("buildPlanResearchPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildPlanResearchPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildPlanResearchPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("includes file references", () => {
    const result = buildPlanResearchPrompt(baseCtx);
    for (const f of baseCtx.fileReferences) {
      expect(result).toContain(f);
    }
  });

  it("handles minimal context without crashing", () => {
    const result = buildPlanResearchPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildPlanResearchPrompt(baseCtx);
    for (const kw of [
      "Locator",
      "Analyzer",
      "Documentarian",
      "locator-codebase",
      "BLOCKING",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildPlanResearchPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildPlanResearchPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// buildPlanDraftPrompt
// ---------------------------------------------------------------------------

describe("buildPlanDraftPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildPlanDraftPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("includes key decisions", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    for (const d of baseCtx.keyDecisions) {
      expect(result).toContain(d);
    }
  });

  it("handles minimal context without crashing", () => {
    const result = buildPlanDraftPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    for (const kw of [
      "Implementation Checklist",
      "Phase N:",
      "Test-first",
      "kebab-case",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks (excluding template examples)", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // "Phase 1:" is part of the plan template example, not an orchestration cue.
    // We check all other leak phrases.
    for (const phrase of ORCHESTRATION_LEAKS) {
      expect(result).not.toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPlanReviewPrompt
// ---------------------------------------------------------------------------

describe("buildPlanReviewPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildPlanReviewPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildPlanReviewPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("handles minimal context without crashing", () => {
    const result = buildPlanReviewPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildPlanReviewPrompt(baseCtx);
    for (const kw of [
      "Do NOT write to any files",
      "Dedup",
      "Open Question",
      "P1",
      "P2",
      "P3",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildPlanReviewPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildPlanReviewPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// buildPlanConsolidatePrompt
// ---------------------------------------------------------------------------

describe("buildPlanConsolidatePrompt", () => {
  it("produces non-empty output", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildPlanConsolidatePrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("handles minimal context without crashing", () => {
    const result = buildPlanConsolidatePrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    for (const kw of [
      "Synthesis",
      "Deduplicate",
      "Integrate",
      "Executive Summary",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks (excluding template examples)", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    // "Phase 1:" is part of the consolidated plan template, not an orchestration cue.
    for (const phrase of ORCHESTRATION_LEAKS) {
      expect(result).not.toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------------------
// buildReviewDispatchPrompt
// ---------------------------------------------------------------------------

describe("buildReviewDispatchPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildReviewDispatchPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildReviewDispatchPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("handles minimal context without crashing", () => {
    const result = buildReviewDispatchPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildReviewDispatchPrompt(baseCtx);
    for (const kw of [
      "Phase Grouping",
      "Review Document",
      "P3 Triage",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("contains Plan Compliance content when baselinePlan is set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: { baselinePlan: "Phase 1: Setup auth" },
    };
    const result = buildReviewDispatchPrompt(ctx);
    expect(result).toContain("Plan Compliance");
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildReviewDispatchPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildReviewDispatchPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// buildShipPrompt
// ---------------------------------------------------------------------------

describe("buildShipPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildShipPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildShipPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("handles minimal context without crashing", () => {
    const result = buildShipPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildShipPrompt(baseCtx);
    for (const kw of [
      "NEVER",
      "Co-Authored-By",
      "imperative mood",
      "git add -A",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildShipPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildShipPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// buildDebugPrompt
// ---------------------------------------------------------------------------

describe("buildDebugPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildDebugPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildDebugPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("includes file references", () => {
    const result = buildDebugPrompt(baseCtx);
    for (const f of baseCtx.fileReferences) {
      expect(result).toContain(f);
    }
  });

  it("handles minimal context without crashing", () => {
    const result = buildDebugPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildDebugPrompt(baseCtx);
    for (const kw of [
      "Investigation",
      "Hypothesis",
      "Minimum change",
      "Three-Strike",
      "Escalation",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildDebugPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildDebugPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// Extra template-specific tests
// ---------------------------------------------------------------------------

describe("buildDebugPrompt extras", () => {
  it("includes verificationCommand from extra", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: { verificationCommand: "bun test tests/auth.test.ts" },
    };
    const result = buildDebugPrompt(ctx);
    expect(result).toContain("bun test tests/auth.test.ts");
  });

  it("shows placeholder when verificationCommand is absent", () => {
    const result = buildDebugPrompt(minimalCtx);
    expect(result).toContain("No verification command provided");
  });
});

describe("buildReviewDispatchPrompt extras", () => {
  it("includes plan compliance section when baselinePlan is set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        baselinePlan: "Phase 1: Setup auth\n- [ ] 1.1 Create JWT helpers",
      },
    };
    const result = buildReviewDispatchPrompt(ctx);
    expect(result).toContain("Plan Compliance Check");
    expect(result).toContain("baseline-plan");
    expect(result).toContain("Items implemented");
    expect(result).toContain("Items skipped");
    expect(result).toContain("Create JWT helpers");
  });

  it("omits plan compliance section when baselinePlan is absent", () => {
    const result = buildReviewDispatchPrompt(baseCtx);
    expect(result).not.toContain("Plan Compliance Check");
    expect(result).not.toContain("baseline-plan");
  });
});

describe("buildPlanConsolidatePrompt extras", () => {
  it("includes resolved questions from extra", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        resolvedQuestions: [
          { question: "Use Redis for session storage?", answers: ["Yes, Redis"], source: "user" },
          { question: "JWT refresh tokens are out of scope?", answers: ["Confirmed"], source: "auto" },
        ],
      },
    };
    const result = buildPlanConsolidatePrompt(ctx);
    expect(result).toContain("Use Redis for session storage?");
    expect(result).toContain("Yes, Redis");
    expect(result).toContain("JWT refresh tokens are out of scope?");
    expect(result).toContain("Confirmed");
  });

  it("shows placeholder when resolvedQuestions is absent", () => {
    const result = buildPlanConsolidatePrompt(minimalCtx);
    expect(result).toContain("No resolved questions");
  });
});
