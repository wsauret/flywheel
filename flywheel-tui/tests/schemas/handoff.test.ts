import { describe, it, expect } from "bun:test";
import {
  WorkerHandoffSchema,
} from "../../src/infra/handoff-schemas";
import { EvaluatorVerdictSchema } from "../../src/workflows/evaluator/schemas";
import { DispatcherDecisionHandoffSchema } from "../../src/workflows/dispatcher/schemas";

// ---------------------------------------------------------------------------
// WorkerHandoffSchema
// ---------------------------------------------------------------------------

describe("WorkerHandoffSchema", () => {
  // A valid summary: >= 20 chars, 1-10 sentences, no newlines
  const validSummary = "Implemented feature X with full test coverage. All 42 tests pass. Typecheck clean.";

  const validFull = {
    summary: validSummary,
    artifacts: {
      files_created: ["src/new.ts"],
      files_modified: ["src/existing.ts"],
      commands_run: ["bun test"],
    },
    decisions: ["Used approach A over B"],
    warnings: ["Large file detected"],
    verification: {
      tests_passed: true,
      test_output_summary: "12/12 pass with coverage report showing 95% line coverage.",
    },
    files_to_review: ["src/new.ts"],
    plan_file_path: "docs/plans/plan.md",
    review_file_path: "docs/reviews/review.md",
    finding_counts: { p1_critical: 0, p2_important: 1, p3_suggestion: 3 },
    p3_findings: [
      { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
    ],
  };

  const validMinimal = {
    summary: validSummary,
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

  it("enforces .min(20) on summary", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: "Too short string.", // < 20 chars
    });
    expect(result.success).toBe(false);
  });

  it("enforces .max(5000) on summary", () => {
    // Single very long sentence to avoid sentence count issues
    const result = WorkerHandoffSchema.safeParse({
      summary: "A".repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts summary at exact boundaries (20 and 5000)", () => {
    // 20 chars, 1 sentence — valid
    const atMin = WorkerHandoffSchema.safeParse({ summary: "This is twenty chars." });
    expect(atMin.success).toBe(true);

    // 5000 chars, 1 sentence (no periods except at end) — valid
    const atMax = WorkerHandoffSchema.safeParse({ summary: "A".repeat(4999) + "." });
    expect(atMax.success).toBe(true);
  });

  it("tolerates unknown fields (.passthrough())", () => {
    const result = WorkerHandoffSchema.safeParse({
      ...validMinimal,
      hallucinated_field: "should be tolerated",
    });
    expect(result.success).toBe(true);
  });

  it("parses handoff with partial artifacts (only files_created)", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      artifacts: {
        files_created: ["src/new.ts"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts!.files_created).toEqual(["src/new.ts"]);
      expect(result.data.artifacts!.files_modified).toBeUndefined();
      expect(result.data.artifacts!.commands_run).toBeUndefined();
    }
  });

  it("parses handoff with partial artifacts (only commands_run)", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      artifacts: {
        commands_run: ["bun test", "bunx tsc --noEmit"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts!.commands_run).toEqual(["bun test", "bunx tsc --noEmit"]);
    }
  });

  it("parses handoff with empty artifacts object", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      artifacts: {},
    });
    expect(result.success).toBe(true);
  });

  it("validates nested sub-schemas strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      artifacts: {
        files_created: [],
        files_modified: [],
        commands_run: [],
        extra_field: "should fail due to strict sub-schema",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates verification sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      verification: {
        tests_passed: true,
        test_output_summary: "All tests pass across 42 files.",
        extra: "fail",
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates finding_counts sub-schema strictly", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
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
      summary: validSummary,
      p3_findings: [
        { description: "d", suggestion: "s", extra: "fail" },
      ],
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Content quality enforcement (VAL-QUALITY-001 through VAL-QUALITY-005)
  // -------------------------------------------------------------------------

  describe("content quality enforcement", () => {
    // VAL-QUALITY-001: Summary minimum length enforced (20 chars)
    it("rejects summary shorter than 20 chars with descriptive error", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Short summary.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        // Error must include field name, constraint, and fix instruction
        expect(msg).toContain("summary");
        expect(msg).toContain("20");
      }
    });

    // VAL-QUALITY-005: Summary must not contain newlines
    it("rejects summary containing \\n with instruction to remove them", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "First line of summary.\nSecond line of summary here.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        expect(msg.toLowerCase()).toContain("newline");
      }
    });

    it("rejects summary containing \\r\\n with instruction to remove them", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "First line of summary.\r\nSecond line of summary here.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        expect(msg.toLowerCase()).toContain("newline");
      }
    });

    // VAL-QUALITY-003: Sentence counting (1-10 sentences)
    it("accepts summary with exactly 1 sentence", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented the full feature with comprehensive test coverage and type checking.",
      });
      expect(result.success).toBe(true);
    });

    it("accepts summary with exactly 10 sentences", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "First sentence done. Second sentence done. Third sentence done. Fourth sentence done. Fifth sentence done. Sixth sentence done. Seventh sentence done. Eighth sentence done. Ninth sentence done. Tenth sentence done.",
      });
      expect(result.success).toBe(true);
    });

    it("accepts summary with 7-8 sentences (previously rejected at max 6)", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "One. Two. Three. Four. Five. Six. Seven sentences total.",
      });
      expect(result.success).toBe(true);
    });

    it("rejects summary with more than 10 sentences with error stating count and range", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven sentences total.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        // Error must state count and allowed range
        expect(msg).toContain("summary");
        expect(msg).toMatch(/10/);
      }
    });

    it("rejects summary with 0 sentences (empty-ish content)", () => {
      // A string of spaces/punctuation with >= 20 chars but 0 detectable sentences
      const result = WorkerHandoffSchema.safeParse({
        summary: "                              ",
      });
      expect(result.success).toBe(false);
    });

    // VAL-QUALITY-002: Verification required for success claims
    it("requires test_output_summary >= 10 chars when tests_passed is true", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented feature with full test coverage and type safety.",
        verification: {
          tests_passed: true,
          test_output_summary: "pass", // only 4 chars — too short
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        expect(msg).toContain("test_output_summary");
        expect(msg).toContain("10");
      }
    });

    it("requires test_output_summary when tests_passed is true (missing field)", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented feature with full test coverage and type safety.",
        verification: {
          tests_passed: true,
          // test_output_summary is missing
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues.map(i => i.message).join(" ");
        expect(msg).toContain("test_output_summary");
      }
    });

    it("allows missing test_output_summary when tests_passed is false", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented feature but tests are currently failing.",
        verification: {
          tests_passed: false,
        },
      });
      expect(result.success).toBe(true);
    });

    it("allows missing test_output_summary when tests_passed is null", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented feature and tests were not applicable here.",
        verification: {
          tests_passed: null,
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts test_output_summary with >= 10 chars when tests_passed is true", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Implemented feature with full test coverage and type safety.",
        verification: {
          tests_passed: true,
          test_output_summary: "42 tests passing across 8 files.",
        },
      });
      expect(result.success).toBe(true);
    });

    // VAL-QUALITY-004: All quality errors include field name, constraint, and fix instruction
    it("summary min-length error includes field name, constraint, and fix", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "Way too short.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        const combined = msgs.join(" ");
        expect(combined).toContain("summary");
        expect(combined).toContain("20");
        expect(combined).toContain("character");
      }
    });

    it("sentence count error includes field name, constraint, and range", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven sentences is too many overall.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        const combined = msgs.join(" ");
        expect(combined).toContain("summary");
        expect(combined).toMatch(/1.*10|10.*1/); // mentions both bounds
      }
    });

    it("newline error includes instruction to remove line breaks", () => {
      const result = WorkerHandoffSchema.safeParse({
        summary: "First part of summary.\nSecond part continues here.",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map(i => i.message);
        const combined = msgs.join(" ");
        expect(combined.toLowerCase()).toContain("newline");
        expect(combined.toLowerCase()).toContain("remove");
      }
    });

    // Backward compatibility: existing valid handoffs still parse
    it("existing valid handoffs still parse correctly (backward compat)", () => {
      const result = WorkerHandoffSchema.safeParse(validFull);
      expect(result.success).toBe(true);
    });
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
    feedback: "Good implementation overall",
  };

  it("parses valid verdict", () => {
    const result = EvaluatorVerdictSchema.safeParse(validVerdict);
    expect(result.success).toBe(true);
  });

  it("tolerates unknown fields (.passthrough())", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...validVerdict,
      hallucinated: "should be tolerated",
    });
    expect(result.success).toBe(true);
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
    step_index: 0,
    task_content: "Implement feature X according to plan step 1",
    evaluation_criteria: {
      acceptance_criteria: ["Tests pass", "No lint errors"],
      required_tests: true,
      custom_checks: [],
      required_outputs: [],
    },
    context_files: ["src/foo.ts", "tests/foo.test.ts"],
    session_name: "work-session-1",
    reasoning: "Standard implementation step",
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
      step_index: 0,
      task_content: "Do something",
      context_files: [],
    };
    const result = DispatcherDecisionHandoffSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("tolerates unknown fields (.passthrough())", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      hallucinated_field: "should be tolerated",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerHandoffSchema — skillFeedback field (VAL-FEEDBACK-001, VAL-FEEDBACK-003)
// ---------------------------------------------------------------------------

describe("WorkerHandoffSchema — skillFeedback", () => {
  const validSummary = "Implemented feature X with full test coverage. All 42 tests pass. Typecheck clean.";

  // VAL-FEEDBACK-001: Handoff schema accepts skillFeedback field
  it("accepts handoff with valid skillFeedback", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      skillFeedback: {
        followedProcedure: true,
        deviations: [],
        suggestedChanges: ["Add more examples"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillFeedback).toBeDefined();
      expect(result.data.skillFeedback!.followedProcedure).toBe(true);
    }
  });

  it("accepts handoff with skillFeedback containing deviations", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      skillFeedback: {
        followedProcedure: false,
        deviations: [
          {
            step: "2. Write Tests First",
            whatIDidInstead: "Wrote implementation first",
            why: "Feature was too exploratory for TDD",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillFeedback!.deviations).toHaveLength(1);
    }
  });

  // VAL-FEEDBACK-003: Skill feedback is backward compatible
  it("accepts handoff without skillFeedback (backward compat)", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillFeedback).toBeUndefined();
    }
  });

  it("rejects invalid skillFeedback (missing followedProcedure)", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      skillFeedback: {
        deviations: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects skillFeedback with unknown fields (.strict())", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      skillFeedback: {
        followedProcedure: true,
        deviations: [],
        extra: "should fail",
      },
    });
    expect(result.success).toBe(false);
  });
});

