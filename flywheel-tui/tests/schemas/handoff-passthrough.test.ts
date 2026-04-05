import { describe, it, expect } from "bun:test";
import {
  WorkerHandoffSchema,
  WorkerHandoffBaseSchema,
} from "../../src/protocol/handoff-schemas";
import { EvaluatorVerdictSchema } from "../../src/evaluator/schemas";
import { DispatcherDecisionHandoffSchema } from "../../src/dispatcher/schemas";

// ---------------------------------------------------------------------------
// Tests for passthrough behavior on incoming handoff schemas.
// Schemas that validate INCOMING handoff data from LLMs should use
// .passthrough() instead of .strict() so that extra fields (e.g.,
// "warnings", "notes", "metadata") are tolerated without causing
// validation failures and retries.
// ---------------------------------------------------------------------------

describe("WorkerHandoffSchema passthrough", () => {
  const validSummary = "Implemented the authentication middleware with JWT token validation and refresh support.";

  it("accepts handoff with extra unknown fields (passthrough)", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      extra_llm_field: "should be tolerated",
      notes: "some notes the LLM added",
    });
    expect(result.success).toBe(true);
  });

  it("accepts handoff with extra 'warnings' key even if schema already has it", () => {
    // 'warnings' is already in the schema, but this tests the general
    // principle that extra keys don't break validation
    const result = WorkerHandoffSchema.safeParse({
      summary: validSummary,
      warnings: ["some warning"],
    });
    expect(result.success).toBe(true);
  });

  it("still validates required fields even with passthrough", () => {
    // Missing summary should still fail
    const result = WorkerHandoffSchema.safeParse({
      extra_field: "present",
    });
    expect(result.success).toBe(false);
  });

  it("still validates field types even with passthrough", () => {
    const result = WorkerHandoffSchema.safeParse({
      summary: 42, // should be string
      extra_field: "present",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkerHandoffBaseSchema passthrough", () => {
  const validSummary = "Implemented the authentication middleware with JWT token validation and refresh support.";

  it("accepts base schema with extra unknown fields", () => {
    const result = WorkerHandoffBaseSchema.safeParse({
      summary: validSummary,
      llm_hallucinated_key: "should be tolerated",
    });
    expect(result.success).toBe(true);
  });
});

describe("DispatcherDecisionHandoffSchema passthrough", () => {
  const validDecision = {
    schema_version: 1 as const,
    step_index: 0,
    task_content: "Implement feature X according to plan step 1",
    context_files: ["src/foo.ts"],
  };

  it("accepts dispatcher decision with extra 'warnings' key", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      warnings: ["extra warning from LLM"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts dispatcher decision with arbitrary extra fields", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      notes: "the LLM added this",
      confidence: 0.9,
      hallucinated_field: "should be tolerated",
    });
    expect(result.success).toBe(true);
  });

  it("still validates required fields even with passthrough", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      extra: "present",
    });
    expect(result.success).toBe(false);
  });

  it("still validates schema_version must be 1", () => {
    const result = DispatcherDecisionHandoffSchema.safeParse({
      ...validDecision,
      schema_version: 2,
      extra_field: "present",
    });
    expect(result.success).toBe(false);
  });
});

describe("EvaluatorVerdictSchema passthrough", () => {
  const validVerdict = {
    passed: true,
    reasoning: "All tests pass and implementation looks correct.",
    suggestions: [],
    confidence: 0.95,
    feedback: "Good implementation overall",
    files_to_review: ["src/feature.ts"],
  };

  it("accepts evaluator verdict with extra unknown fields", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...validVerdict,
      extra_from_llm: "should be tolerated",
      warnings: ["some warning"],
    });
    expect(result.success).toBe(true);
  });

  it("still validates required fields even with passthrough", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      passed: true,
      extra: "present",
    });
    expect(result.success).toBe(false);
  });
});
