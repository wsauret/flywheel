/**
 * Tests for Evaluator Handoff schema validation.
 *
 * Verifies:
 * - EvaluatorInput schema accepts optional handoff field
 * - EvaluatorHandoffDataSchema picks correct fields from SubprocessHandoff
 */

import { describe, it, expect } from "bun:test";
import type { EvaluatorInput } from "../../src/workflows/evaluator/schemas";
import { EvaluatorInputSchema, EvaluatorHandoffDataSchema } from "../../src/workflows/evaluator/schemas";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("EvaluatorInput schema with handoff field", () => {
  it("accepts input without handoff", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts input with handoff data", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
        verification: { tests_passed: true, test_output_summary: "12/12 pass" },
        artifacts: { files_created: ["a.ts"], files_modified: ["b.ts"], commands_run: ["bun test"] },
        files_to_review: ["a.ts"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts input with minimal handoff (summary only)", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("EvaluatorHandoffDataSchema", () => {
  it("picks only summary, verification, artifacts, files_to_review from SubprocessHandoff", () => {
    const data = {
      summary: "A".repeat(100),
      verification: { tests_passed: true },
      artifacts: { files_created: [], files_modified: [], commands_run: [] },
      files_to_review: ["src/foo.ts"],
    };
    const result = EvaluatorHandoffDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("tolerates fields not in pick set (inherits passthrough from SubprocessHandoff)", () => {
    const data = {
      summary: "A".repeat(100),
      plan_file_path: "not in pick set but tolerated",
    };
    const result = EvaluatorHandoffDataSchema.safeParse(data);
    // pick on a .passthrough() schema inherits passthrough — extra fields are tolerated
    expect(result.success).toBe(true);
  });
});
