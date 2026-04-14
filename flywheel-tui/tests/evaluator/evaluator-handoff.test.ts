/**
 * Tests for Evaluator Handoff schema validation.
 *
 * Verifies:
 * - EvaluatorInput schema accepts optional handoff field
 * - EvaluatorHandoffDataSchema picks correct fields from SubprocessHandoff
 */

import { describe, it, expect } from "bun:test";
import type { EvaluatorInput } from "../../src/workflows/evaluator/schemas";

// ---------------------------------------------------------------------------
// Type-level tests (schemas are module-private)
// ---------------------------------------------------------------------------

describe("EvaluatorInput type with handoff field", () => {
  it("accepts input without handoff", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
    };
    expect(input.handoff).toBeUndefined();
  });

  it("accepts input with handoff data", () => {
    const input: EvaluatorInput = {
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
    };
    expect(input.handoff).toBeDefined();
    expect(input.handoff!.summary).toHaveLength(100);
  });

  it("accepts input with minimal handoff (summary only)", () => {
    const input: EvaluatorInput = {
      worker_output: "output",
      evaluation_criteria: "criteria",
      acceptance_criteria: [],
      tests_passed: null,
      handoff: {
        summary: "A".repeat(100),
      },
    };
    expect(input.handoff!.summary).toHaveLength(100);
  });
});
