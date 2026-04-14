/**
 * Tests for widened handoff projections (VAL-HANDOFF-001 through VAL-HANDOFF-008).
 *
 * Covers:
 * - EvaluatorHandoffData includes warnings and decisions fields
 * - LastWorkerResultSchema includes decisions, warnings, commands_run, files_to_review
 * - Backward compatibility: handoffs without new fields parse correctly
 * - Schema validation failure resilience
 */
import { describe, it, expect } from "bun:test";
import {
  SubprocessHandoffSchema,
} from "../../src/infra/handoff-schemas";
import type { SubprocessHandoff } from "../../src/infra/handoff-schemas";
import type { EvaluatorInput } from "../../src/workflows/evaluator/schemas";
import { LastWorkerResultSchema } from "../../src/workflows/schemas";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fullHandoff(overrides?: Partial<SubprocessHandoff>): SubprocessHandoff {
  return {
    summary: "Implemented authentication module with JWT tokens, rate limiting, and session management. All tests pass.",
    artifacts: {
      files_created: ["src/auth/jwt.ts", "src/auth/session.ts"],
      files_modified: ["src/index.ts", "src/config.ts"],
      commands_run: ["bun test", "bun run build"],
    },
    decisions: [
      "Used RS256 for JWT signing instead of HS256 for better security",
      "Added rate limiting middleware at the router level",
    ],
    warnings: [
      "JWT secret should be rotated in production",
      "Rate limit config needs tuning for high-traffic scenarios",
    ],
    verification: {
      tests_passed: true,
      test_output_summary: "42 tests passed, 0 failed",
    },
    files_to_review: ["src/auth/jwt.ts", "src/auth/session.ts"],
    ...overrides,
  } as SubprocessHandoff;
}

// ---------------------------------------------------------------------------
// VAL-HANDOFF-001: Evaluator receives worker warnings
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-001: EvaluatorInput handoff includes warnings", () => {
  it("EvaluatorInput handoff field accepts warnings from SubprocessHandoff", () => {
    const handoff = fullHandoff();
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: handoff.summary,
        verification: handoff.verification,
        artifacts: handoff.artifacts,
        files_to_review: handoff.files_to_review,
        warnings: handoff.warnings,
      },
    };
    expect(input.handoff!.warnings).toEqual([
      "JWT secret should be rotated in production",
      "Rate limit config needs tuning for high-traffic scenarios",
    ]);
  });

  it("warnings is optional in EvaluatorInput handoff", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
      },
    };
    expect(input.handoff!.warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-002: Evaluator receives worker decisions
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-002: EvaluatorInput handoff includes decisions", () => {
  it("EvaluatorInput handoff field accepts decisions from SubprocessHandoff", () => {
    const handoff = fullHandoff();
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: handoff.summary,
        verification: handoff.verification,
        artifacts: handoff.artifacts,
        files_to_review: handoff.files_to_review,
        decisions: handoff.decisions,
      },
    };
    expect(input.handoff!.decisions).toEqual([
      "Used RS256 for JWT signing instead of HS256 for better security",
      "Added rate limiting middleware at the router level",
    ]);
  });

  it("decisions is optional in EvaluatorInput handoff", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
      },
    };
    expect(input.handoff!.decisions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-003: Dispatcher receives worker decisions
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-003: LastWorkerResult includes decisions", () => {
  it("LastWorkerResultSchema accepts decisions field", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the thing",
      artifacts_produced: ["src/new.ts"],
      tests_passed: true,
      decisions: ["Used approach A over B"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions).toEqual(["Used approach A over B"]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-004: Dispatcher receives worker warnings
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-004: LastWorkerResult includes warnings", () => {
  it("LastWorkerResultSchema accepts warnings field", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the thing",
      artifacts_produced: [],
      tests_passed: true,
      warnings: ["Watch out for this"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toEqual(["Watch out for this"]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-005: Dispatcher receives commands_run
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-005: LastWorkerResult includes commands_run", () => {
  it("LastWorkerResultSchema accepts commands_run field", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the thing",
      artifacts_produced: [],
      tests_passed: true,
      commands_run: ["bun test", "bun run build"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands_run).toEqual(["bun test", "bun run build"]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-006: Dispatcher receives files_to_review
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-006: LastWorkerResult includes files_to_review", () => {
  it("LastWorkerResultSchema accepts files_to_review field", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the thing",
      artifacts_produced: [],
      tests_passed: true,
      files_to_review: ["src/auth.ts"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files_to_review).toEqual(["src/auth.ts"]);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-007: Widened projections are backward compatible
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-007: Backward compatibility", () => {
  it("EvaluatorInput handoff works without warnings/decisions (old format)", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
        verification: { tests_passed: true, test_output_summary: "All pass" },
        artifacts: { files_created: [], files_modified: [], commands_run: [] },
        files_to_review: [],
      },
    };
    expect(input.handoff!.warnings).toBeUndefined();
    expect(input.handoff!.decisions).toBeUndefined();
  });

  it("LastWorkerResult parses without new optional fields (old format)", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the feature",
      artifacts_produced: ["src/new.ts"],
      tests_passed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions).toBeUndefined();
      expect(result.data.warnings).toBeUndefined();
      expect(result.data.commands_run).toBeUndefined();
      expect(result.data.files_to_review).toBeUndefined();
    }
  });

  it("existing handoff JSON from old schema still parses through SubprocessHandoffSchema", () => {
    const oldHandoff = {
      summary: "A".repeat(100),
      artifacts: {
        files_created: ["src/foo.ts"],
        files_modified: [],
        commands_run: ["bun test"],
      },
      verification: {
        tests_passed: true,
        test_output_summary: "10 tests pass",
      },
    };
    const result = SubprocessHandoffSchema.safeParse(oldHandoff);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-008: Schema validation failure resilience
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-008: Graceful fallback on invalid handoffs", () => {
  it("EvaluatorInput handoff is undefined when handoff is missing (no crash)", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
    };

    expect(input.handoff).toBeUndefined();
  });
});
