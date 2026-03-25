import { describe, it, expect } from "bun:test";
import {
  WorkerHandoffSchema,
  EvaluatorVerdictSchema,
  DispatcherDecisionHandoffSchema,
  ArtifactsSchema,
  VerificationSchema,
  OpenQuestionSchema,
  FindingCountsSchema,
  P3FindingSchema,
  CompoundDocSchema,
} from "../../src/schemas/handoff";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

describe("ArtifactsSchema", () => {
  it("parses valid artifacts", () => {
    const result = ArtifactsSchema.parse({
      files_created: ["src/foo.ts"],
      files_modified: ["src/bar.ts"],
      commands_run: ["bun test"],
    });
    expect(result.files_created).toEqual(["src/foo.ts"]);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = ArtifactsSchema.safeParse({
      files_created: [],
      files_modified: [],
      commands_run: [],
      extra: "should fail",
    });
    expect(result.success).toBe(false);
  });
});

describe("VerificationSchema", () => {
  it("parses valid verification", () => {
    const result = VerificationSchema.parse({
      tests_passed: true,
      test_output_summary: "All 12 tests pass",
    });
    expect(result.tests_passed).toBe(true);
  });

  it("accepts null for tests_passed", () => {
    const result = VerificationSchema.parse({
      tests_passed: null,
    });
    expect(result.tests_passed).toBeNull();
  });

  it("rejects unknown fields (.strict())", () => {
    const result = VerificationSchema.safeParse({
      tests_passed: true,
      extra: "fail",
    });
    expect(result.success).toBe(false);
  });
});

describe("OpenQuestionSchema", () => {
  it("parses valid question", () => {
    const result = OpenQuestionSchema.parse({
      question: "Which approach?",
      options: ["A", "B"],
      header: "Architecture",
    });
    expect(result.question).toBe("Which approach?");
  });

  it("accepts without optional header", () => {
    const result = OpenQuestionSchema.parse({
      question: "Which approach?",
      options: ["A", "B"],
    });
    expect(result.header).toBeUndefined();
  });

  it("rejects unknown fields (.strict())", () => {
    const result = OpenQuestionSchema.safeParse({
      question: "x",
      options: [],
      extra: "fail",
    });
    expect(result.success).toBe(false);
  });
});

describe("FindingCountsSchema", () => {
  it("parses valid counts", () => {
    const result = FindingCountsSchema.parse({
      p1_critical: 0,
      p2_important: 3,
      p3_suggestion: 7,
    });
    expect(result.p2_important).toBe(3);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = FindingCountsSchema.safeParse({
      p1_critical: 0,
      p2_important: 0,
      p3_suggestion: 0,
      extra: "fail",
    });
    expect(result.success).toBe(false);
  });
});

describe("P3FindingSchema", () => {
  it("parses valid finding with all fields", () => {
    const result = P3FindingSchema.parse({
      description: "Consider extracting helper",
      location: "src/foo.ts:42",
      suggestion: "Extract into utils",
    });
    expect(result.description).toBe("Consider extracting helper");
  });

  it("accepts without optional location", () => {
    const result = P3FindingSchema.parse({
      description: "Consider extracting helper",
      suggestion: "Extract into utils",
    });
    expect(result.location).toBeUndefined();
  });

  it("rejects unknown fields (.strict())", () => {
    const result = P3FindingSchema.safeParse({
      description: "x",
      suggestion: "y",
      extra: "fail",
    });
    expect(result.success).toBe(false);
  });
});

describe("CompoundDocSchema", () => {
  it("parses valid doc with all fields", () => {
    const result = CompoundDocSchema.parse({
      title: "Fix flaky test",
      type: "bug-fix",
      tags: ["testing", "ci"],
      problem: "Test was flaky due to timing",
      solution: "Added retry logic",
      context: "Only affects CI environment",
    });
    expect(result.title).toBe("Fix flaky test");
  });

  it("accepts without optional context", () => {
    const result = CompoundDocSchema.parse({
      title: "Fix flaky test",
      type: "bug-fix",
      tags: ["testing"],
      problem: "Flaky",
      solution: "Fixed",
    });
    expect(result.context).toBeUndefined();
  });

  it("rejects unknown fields (.strict())", () => {
    const result = CompoundDocSchema.safeParse({
      title: "x",
      type: "y",
      tags: [],
      problem: "p",
      solution: "s",
      extra: "fail",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerHandoffSchema
// ---------------------------------------------------------------------------

describe("WorkerHandoffSchema", () => {
  const validFull = {
    summary: "A".repeat(100), // exactly 100 chars — at min boundary
    artifacts: {
      files_created: ["src/new.ts"],
      files_modified: ["src/existing.ts"],
      commands_run: ["bun test"],
    },
    decisions: ["Used approach A over B"],
    warnings: ["Large file detected"],
    verification: {
      tests_passed: true,
      test_output_summary: "12/12 pass",
    },
    files_to_review: ["src/new.ts"],
    plan_file_path: "docs/plans/plan.md",
    open_questions: [
      { question: "Which DB?", options: ["Postgres", "SQLite"], header: "Storage" },
    ],
    review_file_path: "docs/reviews/review.md",
    finding_counts: { p1_critical: 0, p2_important: 1, p3_suggestion: 3 },
    p3_findings: [
      { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
    ],
    compound_docs: [
      {
        title: "Fix flaky test",
        type: "bug-fix",
        tags: ["testing"],
        problem: "Timing issue",
        solution: "Added retry",
        context: "CI only",
      },
    ],
  };

  const validMinimal = {
    summary: "A".repeat(100),
  };

  it("parses valid full handoff", () => {
    const result = WorkerHandoffSchema.safeParse(validFull);
    expect(result.success).toBe(true);
  });

  it("parses valid minimal handoff (summary only)", () => {
    const result = WorkerHandoffSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
  });

  it("fails when summary is missing", () => {
    const result = WorkerHandoffSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const summaryError = result.error.issues.find(
        (i) => i.path.includes("summary"),
      );
      expect(summaryError).toBeDefined();
    }
  });

  it("enforces .min(100) on summary", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(99), // 1 char too short
    });
    expect(result.success).toBe(false);
  });

  it("enforces .max(5000) on summary", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(5001), // 1 char too long
    });
    expect(result.success).toBe(false);
  });

  it("accepts summary at exact boundaries (100 and 5000)", () => {
    const atMin = WorkerHandoffSchema.safeParse({ summary: "A".repeat(100) });
    expect(atMin.success).toBe(true);

    const atMax = WorkerHandoffSchema.safeParse({ summary: "A".repeat(5000) });
    expect(atMax.success).toBe(true);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = WorkerHandoffSchema.safeParse({
      ...validMinimal,
      hallucinated_field: "should fail",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod strict mode produces "unrecognized_keys" issue
      const unrecognized = result.error.issues.find(
        (i) => i.code === "unrecognized_keys",
      );
      expect(unrecognized).toBeDefined();
    }
  });

  it("validates nested sub-schemas strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      artifacts: {
        files_created: [],
        files_modified: [],
        commands_run: [],
        extra_field: "should fail due to strict sub-schema",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates open_questions sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      open_questions: [
        { question: "Q?", options: ["A"], extra: "fail" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("validates verification sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      verification: {
        tests_passed: true,
        extra: "fail",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates finding_counts sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      finding_counts: {
        p1_critical: 0,
        p2_important: 0,
        p3_suggestion: 0,
        extra: "fail",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates p3_findings sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      p3_findings: [
        { description: "d", suggestion: "s", extra: "fail" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("validates compound_docs sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(100),
      compound_docs: [
        { title: "t", type: "ty", tags: [], problem: "p", solution: "s", extra: "fail" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorVerdictSchema
// ---------------------------------------------------------------------------

describe("EvaluatorVerdictSchema", () => {
  const validVerdict = {
    passed: true,
    reasoning: "All acceptance criteria met",
    suggestions: ["Consider adding edge case tests"],
    confidence: 0.92,
    feedback: "Good implementation overall",
    files_to_review: ["src/feature.ts"],
  };

  it("parses valid verdict", () => {
    const result = EvaluatorVerdictSchema.safeParse(validVerdict);
    expect(result.success).toBe(true);
  });

  it("accepts confidence at 0", () => {
    const result = EvaluatorVerdictSchema.parse({
      ...validVerdict,
      confidence: 0,
    });
    expect(result.confidence).toBe(0);
  });

  it("accepts confidence at 1", () => {
    const result = EvaluatorVerdictSchema.parse({
      ...validVerdict,
      confidence: 1,
    });
    expect(result.confidence).toBe(1);
  });

  it("rejects confidence below 0", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...validVerdict,
      confidence: -0.01,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...validVerdict,
      confidence: 1.01,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...validVerdict,
      hallucinated: "should fail",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.find(
        (i) => i.code === "unrecognized_keys",
      );
      expect(unrecognized).toBeDefined();
    }
  });

  it("rejects missing required fields", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      passed: true,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DispatcherDecisionHandoffSchema
// ---------------------------------------------------------------------------

describe("DispatcherDecisionHandoffSchema", () => {
  const validDecision = {
    schema_version: 1 as const,
    phase_index: 0,
    task_content: "Implement feature X according to plan phase 1",
    validation_criteria: "Tests pass, no lint errors",
    context_files: ["src/foo.ts", "tests/foo.test.ts"],
    session_name: "work-session-1",
    reasoning: "Standard implementation phase",
    worker_config: {
      model_override: null,
      timeout_minutes: 30,
    },
  };

  it("parses valid decision", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse(validDecision);
    expect(result.success).toBe(true);
  });

  it("requires schema_version: 1", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      schema_version: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing schema_version", () => {
    const { schema_version, ...noVersion } = validDecision;
    const result = DispatcherDecisionHandoffSchema.safeParse(noVersion);
    expect(result.success).toBe(false);
  });

  it("accepts minimal decision (only required fields)", () => {
    const minimal = {
      schema_version: 1 as const,
      phase_index: 0,
      task_content: "Do something",
      context_files: [],
    };
    const result = DispatcherDecisionHandoffSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      hallucinated_field: "should fail",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.find(
        (i) => i.code === "unrecognized_keys",
      );
      expect(unrecognized).toBeDefined();
    }
  });

  it("rejects missing required fields", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
