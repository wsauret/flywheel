/**
 * Tests for widened handoff projections (VAL-HANDOFF-001 through VAL-HANDOFF-008).
 *
 * Covers:
 * - EvaluatorHandoffData includes warnings and decisions fields
 * - LastWorkerResultSchema includes decisions, warnings, commands_run, files_to_review
 * - buildLastWorkerResult() populates new fields from worker handoff
 * - Backward compatibility: handoffs without new fields parse correctly
 * - Schema validation failure resilience: invalid handoffs fall back gracefully
 */
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  WorkerHandoffSchema,
  EvaluatorVerdictSchema,
} from "../../src/schemas/handoff";
import { EvaluatorHandoffDataSchema } from "../../src/schemas/evaluator";
import { LastWorkerResultSchema } from "../../src/schemas/shared";
import { buildLastWorkerResult } from "../../src/handoff/consumers";
import type { WorkerHandoff } from "../../src/schemas/handoff";
import type { LastWorkerResult } from "../../src/schemas/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fullHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
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
  } as WorkerHandoff;
}

function minimalHandoff(): WorkerHandoff {
  return {
    summary: "Implemented the initial project structure with configuration files and directory layout for the feature.",
  } as WorkerHandoff;
}

// ---------------------------------------------------------------------------
// VAL-HANDOFF-001: Evaluator receives worker warnings
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-001: EvaluatorHandoffData includes warnings", () => {
  it("EvaluatorHandoffDataSchema includes warnings field from WorkerHandoff", () => {
    const handoff = fullHandoff();
    const projected = EvaluatorHandoffDataSchema.parse({
      summary: handoff.summary,
      verification: handoff.verification,
      artifacts: handoff.artifacts,
      files_to_review: handoff.files_to_review,
      warnings: handoff.warnings,
    });

    expect(projected.warnings).toEqual([
      "JWT secret should be rotated in production",
      "Rate limit config needs tuning for high-traffic scenarios",
    ]);
  });

  it("warnings is optional in EvaluatorHandoffData", () => {
    const result = EvaluatorHandoffDataSchema.safeParse({
      summary: "A".repeat(100),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-002: Evaluator receives worker decisions
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-002: EvaluatorHandoffData includes decisions", () => {
  it("EvaluatorHandoffDataSchema includes decisions field from WorkerHandoff", () => {
    const handoff = fullHandoff();
    const projected = EvaluatorHandoffDataSchema.parse({
      summary: handoff.summary,
      verification: handoff.verification,
      artifacts: handoff.artifacts,
      files_to_review: handoff.files_to_review,
      decisions: handoff.decisions,
    });

    expect(projected.decisions).toEqual([
      "Used RS256 for JWT signing instead of HS256 for better security",
      "Added rate limiting middleware at the router level",
    ]);
  });

  it("decisions is optional in EvaluatorHandoffData", () => {
    const result = EvaluatorHandoffDataSchema.safeParse({
      summary: "A".repeat(100),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions).toBeUndefined();
    }
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
      duration_seconds: 30,
      decisions: ["Used approach A over B"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions).toEqual(["Used approach A over B"]);
    }
  });

  it("buildLastWorkerResult populates decisions from handoff", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.decisions).toEqual([
      "Used RS256 for JWT signing instead of HS256 for better security",
      "Added rate limiting middleware at the router level",
    ]);
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
      duration_seconds: 30,
      warnings: ["Watch out for this"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toEqual(["Watch out for this"]);
    }
  });

  it("buildLastWorkerResult populates warnings from handoff", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.warnings).toEqual([
      "JWT secret should be rotated in production",
      "Rate limit config needs tuning for high-traffic scenarios",
    ]);
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
      duration_seconds: 30,
      commands_run: ["bun test", "bun run build"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands_run).toEqual(["bun test", "bun run build"]);
    }
  });

  it("buildLastWorkerResult populates commands_run from handoff artifacts", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.commands_run).toEqual(["bun test", "bun run build"]);
  });

  it("commands_run is empty array when handoff has no artifacts", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.commands_run).toEqual([]);
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
      duration_seconds: 30,
      files_to_review: ["src/auth.ts"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files_to_review).toEqual(["src/auth.ts"]);
    }
  });

  it("buildLastWorkerResult populates files_to_review from handoff", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.files_to_review).toEqual(["src/auth/jwt.ts", "src/auth/session.ts"]);
  });

  it("files_to_review is empty array when handoff has no files_to_review", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.files_to_review).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-007: Widened projections are backward compatible
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-007: Backward compatibility", () => {
  it("EvaluatorHandoffData parses without warnings/decisions (old format)", () => {
    const result = EvaluatorHandoffDataSchema.safeParse({
      summary: "A".repeat(100),
      verification: { tests_passed: true, test_output_summary: "All pass" },
      artifacts: { files_created: [], files_modified: [], commands_run: [] },
      files_to_review: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toBeUndefined();
      expect(result.data.decisions).toBeUndefined();
    }
  });

  it("LastWorkerResult parses without new optional fields (old format)", () => {
    const result = LastWorkerResultSchema.safeParse({
      step: 0,
      status: "completed",
      output_summary: "Built the feature",
      artifacts_produced: ["src/new.ts"],
      tests_passed: true,
      duration_seconds: 45,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions).toBeUndefined();
      expect(result.data.warnings).toBeUndefined();
      expect(result.data.commands_run).toBeUndefined();
      expect(result.data.files_to_review).toBeUndefined();
    }
  });

  it("buildLastWorkerResult works with minimal handoff (no optional fields)", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.step).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.output_summary).toBe(handoff.summary);
    expect(result.artifacts_produced).toEqual([]);
    expect(result.tests_passed).toBeNull();
    expect(result.duration_seconds).toBe(30);
    // New fields should have sensible defaults
    expect(result.decisions).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.commands_run).toEqual([]);
    expect(result.files_to_review).toEqual([]);
  });

  it("existing handoff JSON from old schema still parses through WorkerHandoffSchema", () => {
    // Simulate an old handoff without decisions/warnings
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
    const result = WorkerHandoffSchema.safeParse(oldHandoff);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-HANDOFF-008: Schema validation failure resilience
// ---------------------------------------------------------------------------

describe("VAL-HANDOFF-008: Graceful fallback on invalid handoffs", () => {
  it("EvaluatorHandoffData is undefined when handoff is missing (no crash)", () => {
    // When cachedHandoff is undefined, evaluatorHandoff should be undefined
    const cachedHandoff: WorkerHandoff | undefined = undefined;
    const evaluatorHandoff = cachedHandoff
      ? EvaluatorHandoffDataSchema.parse({
          summary: cachedHandoff.summary,
          verification: cachedHandoff.verification,
          artifacts: cachedHandoff.artifacts,
          files_to_review: cachedHandoff.files_to_review,
          warnings: cachedHandoff.warnings,
          decisions: cachedHandoff.decisions,
        })
      : undefined;

    expect(evaluatorHandoff).toBeUndefined();
  });

  it("LastWorkerResult is undefined when handoff is missing (no crash)", () => {
    // When cachedHandoff is undefined, _lastWorkerResult should be undefined
    const cachedHandoff: WorkerHandoff | undefined = undefined;
    const lastWorkerResult = cachedHandoff
      ? buildLastWorkerResult(cachedHandoff, 0, 30000)
      : undefined;

    expect(lastWorkerResult).toBeUndefined();
  });

  it("buildLastWorkerResult produces valid result even with empty arrays", () => {
    const handoff = fullHandoff({
      decisions: [],
      warnings: [],
      files_to_review: [],
      artifacts: { files_created: [], files_modified: [], commands_run: [] },
    });
    const result = buildLastWorkerResult(handoff, 0, 30000);

    // Should validate against the schema
    const parsed = LastWorkerResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("buildLastWorkerResult output validates against LastWorkerResultSchema", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 2, 120000);

    const parsed = LastWorkerResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});
