import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/prompts/index";
import {
  buildWorkStepPrompt,
  buildPlanResearchPrompt,
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  buildPlanConsolidatePrompt,
  buildReviewDispatchPrompt,
  buildShipPrompt,
  buildShipCompoundPrompt,
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
  UNDERSTAND_ACT_VERIFY,
  buildIterationBudgetInstruction,
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
  "Step 0:",
  "session.md",
  ".flywheel/session",
  "Ralph mode",
  "Ralph Mode",
  "question:",
  "carry on",
  "resume",
  "$ARGUMENTS",
];

// "Step 1:" is allowed in draft/consolidate templates (it's a formatting example,
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
    UNDERSTAND_ACT_VERIFY,
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

  it("UNDERSTAND_ACT_VERIFY contains Understand, Act, Verify steps", () => {
    expect(UNDERSTAND_ACT_VERIFY).toContain("UNDERSTAND");
    expect(UNDERSTAND_ACT_VERIFY).toContain("ACT");
    expect(UNDERSTAND_ACT_VERIFY).toContain("VERIFY");
    expect(UNDERSTAND_ACT_VERIFY).toContain("iteration budget");
  });
});

// ---------------------------------------------------------------------------
// buildIterationBudgetInstruction
// ---------------------------------------------------------------------------

describe("buildIterationBudgetInstruction", () => {
  it("returns a string containing the budget number", () => {
    const result = buildIterationBudgetInstruction(5);
    expect(typeof result).toBe("string");
    expect(result).toContain("5");
  });

  it("throws for budget of 0", () => {
    expect(() => buildIterationBudgetInstruction(0)).toThrow();
  });

  it("throws for negative budget", () => {
    expect(() => buildIterationBudgetInstruction(-1)).toThrow();
  });

  it("throws for Infinity", () => {
    expect(() => buildIterationBudgetInstruction(Infinity)).toThrow();
  });

  it("works for budget of 1", () => {
    const result = buildIterationBudgetInstruction(1);
    expect(result).toContain("1");
  });
});

// ---------------------------------------------------------------------------
// buildWorkStepPrompt
// ---------------------------------------------------------------------------

describe("buildWorkStepPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildWorkStepPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildWorkStepPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("includes key decisions", () => {
    const result = buildWorkStepPrompt(baseCtx);
    for (const d of baseCtx.keyDecisions) {
      expect(result).toContain(d);
    }
  });

  it("includes file references", () => {
    const result = buildWorkStepPrompt(baseCtx);
    for (const f of baseCtx.fileReferences) {
      expect(result).toContain(f);
    }
  });

  it("handles minimal context without crashing", () => {
    const result = buildWorkStepPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains domain-specific content", () => {
    const result = buildWorkStepPrompt(baseCtx);
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

  it("includes Understand-Act-Verify section", () => {
    const result = buildWorkStepPrompt(baseCtx);
    expect(result).toContain("Understand-Act-Verify");
    expect(result).toContain("UNDERSTAND");
    expect(result).toContain("ACT");
    expect(result).toContain("VERIFY");
  });

  it("includes iteration budget instruction when extra.iterationBudget is set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: { iterationBudget: 5 },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("5");
    expect(result).toContain("iteration");
  });

  it("omits iteration budget instruction when extra.iterationBudget is absent", () => {
    const result = buildWorkStepPrompt(baseCtx);
    // Should not contain the budget instruction phrasing
    expect(result).not.toContain("iteration cycles");
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildWorkStepPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildWorkStepPrompt(minimalCtx));
  });

  // ---- Project Context section ----

  it("includes Project Context section when conventions are set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        conventions: [
          { name: "AGENTS.md", path: "AGENTS.md", summary: "Project architecture, commands, TUI states, and developer conventions" },
        ],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("### Conventions");
    expect(result).toContain("`AGENTS.md`");
    expect(result).toContain("Project architecture, commands, TUI states, and developer conventions");
  });

  it("includes Project Context section when standards are set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        standards: [
          { name: "Testing Standards", path: "docs/standards/testing.md", summary: "Testing standards and patterns" },
        ],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("### Standards");
    expect(result).toContain("`docs/standards/testing.md`");
    expect(result).toContain("Testing standards and patterns");
  });

  it("includes Project Context section when learnings are set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        learnings: [
          { name: "Retry Pattern", path: ".flywheel/solutions/retry-pattern.md", summary: "Retry pattern for flaky network calls" },
        ],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("### Learnings");
    expect(result).toContain("`.flywheel/solutions/retry-pattern.md`");
    expect(result).toContain("Retry pattern for flaky network calls");
  });

  it("renders all three subsections when conventions, standards, and learnings are set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        conventions: [
          { name: "AGENTS.md", path: "AGENTS.md", summary: "Developer conventions" },
        ],
        standards: [
          { name: "Testing", path: "docs/standards/testing.md", summary: "Testing patterns" },
        ],
        learnings: [
          { name: "Retry", path: ".flywheel/solutions/retry.md", summary: "Retry pattern" },
        ],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("### Conventions");
    expect(result).toContain("### Standards");
    expect(result).toContain("### Learnings");
    expect(result).toContain("Read them before starting implementation");
  });

  it("omits Project Context section when all context arrays are empty", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        conventions: [],
        standards: [],
        learnings: [],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).not.toContain("## Project Context");
    expect(result).not.toContain("### Conventions");
    expect(result).not.toContain("### Standards");
    expect(result).not.toContain("### Learnings");
  });

  it("omits Project Context section when extra is absent", () => {
    const ctx: WorkflowStepContext = {
      ...minimalCtx,
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).not.toContain("## Project Context");
  });

  it("only renders subsections that have entries", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        conventions: [
          { name: "AGENTS.md", path: "AGENTS.md", summary: "Conventions file" },
        ],
        standards: [],
        learnings: [],
      },
    };
    const result = buildWorkStepPrompt(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("### Conventions");
    expect(result).not.toContain("### Standards");
    expect(result).not.toContain("### Learnings");
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
      "plan.json",
      "steps",
      "behavioralContract",
      "Test-first",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks (excluding template examples)", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // "Step 1:" is part of the plan template example, not an orchestration cue.
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
      "openQuestions",
      "P1",
      "P2",
      "P3",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("instructs producing annotated JSON with openQuestions", () => {
    const result = buildPlanReviewPrompt(baseCtx);
    expect(result).toContain("openQuestions");
    expect(result).toContain("annotated JSON");
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
      "Merge findings INTO steps",
      "plan.json",
      "behavioralContract",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("has no orchestration leaks (excluding template examples)", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    // "Step 1:" is part of the consolidated plan template, not an orchestration cue.
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
      "Step Grouping",
      "Output Format",
      "P3 Triage",
    ]) {
      expect(result).toContain(kw);
    }
  });

  it("contains Plan Compliance content when baselinePlan is set", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: { baselinePlan: "Step 1: Setup auth" },
    };
    const result = buildReviewDispatchPrompt(ctx);
    expect(result).toContain("Plan Compliance");
  });

  it("instructs agent to use exact ## Findings and ## Minor Findings headings", () => {
    const result = buildReviewDispatchPrompt(baseCtx);
    expect(result).toContain("## Findings");
    expect(result).toContain("## Minor Findings");
    expect(result).toContain("Severity");
    expect(result).toContain("MUST include a \"Severity\" column");
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
        baselinePlan: "Step 1: Setup auth\n- [ ] 1.1 Create JWT helpers",
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

// ---------------------------------------------------------------------------
// buildShipCompoundPrompt
// ---------------------------------------------------------------------------

describe("buildShipCompoundPrompt", () => {
  it("produces non-empty output", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes planContent", () => {
    expect(buildShipCompoundPrompt(baseCtx)).toContain(baseCtx.planContent);
  });

  it("handles minimal context without crashing", () => {
    const result = buildShipCompoundPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes target directory .flywheel/solutions/", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain(".flywheel/solutions/");
  });

  it("includes complete YAML frontmatter format", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain("type: compound");
    expect(result).toContain("title:");
    expect(result).toContain("tags:");
    expect(result).toContain("date:");
    expect(result).toContain("extraction_hash:");
  });

  it("includes compound doc section headings", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain("## Problem");
    expect(result).toContain("## Solution");
    expect(result).toContain("## Context");
  });

  it("includes dedup explanation", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain("Dedup");
    expect(result).toContain("extraction_hash");
  });

  it("instructs worker to output structured compound docs", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain("YAML frontmatter");
    expect(result).toContain("---");
  });

  it("has no orchestration leaks", () => {
    assertNoOrchestrationLeaks(buildShipCompoundPrompt(baseCtx));
    assertNoOrchestrationLeaks(buildShipCompoundPrompt(minimalCtx));
  });

  it("includes projectCwd when present", () => {
    const result = buildShipCompoundPrompt(baseCtx);
    expect(result).toContain(baseCtx.projectCwd!);
  });

  it("omits Working Directory section when projectCwd is absent", () => {
    const result = buildShipCompoundPrompt(minimalCtx);
    expect(result).not.toContain("Working Directory");
  });
});

describe("buildPlanConsolidatePrompt extras", () => {
  it("includes resolved questions from extra as 'Decisions Made'", () => {
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
    expect(result).toContain("## Decisions Made");
    expect(result).toContain("Use Redis for session storage?");
    expect(result).toContain("Yes, Redis");
    expect(result).toContain("JWT refresh tokens are out of scope?");
    expect(result).toContain("Confirmed");
  });

  it("includes unresolved questions from extra as 'Open Questions to Resolve'", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {
        unresolvedQuestions: [
          {
            question: "Should `auto_chain` default to `true` or `false`?",
            header: "auto_chain default",
            options: [
              { label: "true", description: "" },
              { label: "false", description: "" },
            ],
          },
          {
            question: "How should sessions be managed?",
            header: "session management",
            options: [],
          },
        ],
        questionDirective: "resolve-best-judgment",
      },
    };
    const result = buildPlanConsolidatePrompt(ctx);
    expect(result).toContain("## Open Questions to Resolve");
    expect(result).toContain("Resolve each question using your best judgment");
    expect(result).toContain("Should `auto_chain` default to `true` or `false`?");
    expect(result).toContain("How should sessions be managed?");
    expect(result).toContain("- true");
    expect(result).toContain("- false");
    // The dynamic section should be "Open Questions to Resolve", not "Decisions Made"
    // (Note: "## Decisions Made" also appears in the template example, so we check the dynamic heading)
    expect(result).toContain("## Open Questions to Resolve");
  });

  it("shows placeholder when no questions of either type", () => {
    const result = buildPlanConsolidatePrompt(minimalCtx);
    expect(result).toContain("No open questions");
  });
});
