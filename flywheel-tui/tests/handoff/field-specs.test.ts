import { describe, it, expect } from "bun:test";
import {
  renderHandoffInstruction,
  renderEvaluatorHandoffInstruction,
  renderDispatcherHandoffInstruction,
  type HandoffFieldSpec,
} from "../../src/queue/shared/handoff-render";
import { WORK_STEP_FIELDS } from "../../src/queue/steps/work/fields";
import { PLAN_DRAFT_FIELDS } from "../../src/queue/steps/plan-draft/fields";
import { PLAN_REVIEW_FIELDS } from "../../src/queue/steps/plan-review/fields";
import { PLAN_CONSOLIDATE_FIELDS } from "../../src/queue/steps/plan-consolidate/fields";
import { REVIEW_FIELDS } from "../../src/queue/steps/review-consolidate/fields";
import { SHIP_FIELDS } from "../../src/queue/steps/ship-commit/fields";

// ---------------------------------------------------------------------------
// renderHandoffInstruction
// ---------------------------------------------------------------------------

describe("renderHandoffInstruction", () => {
  const testPath = "/tmp/handoff.json";

  it("includes the handoff path in output", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain(testPath);
  });

  it("includes field descriptions for specified fields", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    // summary is always included
    expect(output).toContain("summary");
    // Each field from WORK_STEP_FIELDS should have its description
    for (const field of WORK_STEP_FIELDS) {
      expect(output).toContain(field.key);
      expect(output).toContain(field.description);
    }
  });

  it("includes examples for specified fields", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    for (const field of WORK_STEP_FIELDS) {
      expect(output).toContain(field.example);
    }
  });

  it("always includes summary even if not in fields array", () => {
    const fieldsWithoutSummary: HandoffFieldSpec[] = [
      {
        key: "decisions",
        description: "Key decisions made",
        example: '["Used approach A"]',
      },
    ];
    const output = renderHandoffInstruction(fieldsWithoutSummary, testPath);
    expect(output).toContain("summary");
  });

  it("different field sets produce different prompts", () => {
    const workOutput = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    const planOutput = renderHandoffInstruction(PLAN_DRAFT_FIELDS, testPath);
    const reviewOutput = renderHandoffInstruction(REVIEW_FIELDS, testPath);

    // All three should be different
    expect(workOutput).not.toBe(planOutput);
    expect(workOutput).not.toBe(reviewOutput);
    expect(planOutput).not.toBe(reviewOutput);
  });

  it("output is under 4000 bytes for any field set", () => {
    const allFieldSets = [
      WORK_STEP_FIELDS,
      PLAN_DRAFT_FIELDS,
      PLAN_REVIEW_FIELDS,
      PLAN_CONSOLIDATE_FIELDS,
      REVIEW_FIELDS,
      SHIP_FIELDS,
    ];

    for (const fields of allFieldSets) {
      const output = renderHandoffInstruction(fields, testPath);
      const bytes = new TextEncoder().encode(output).length;
      expect(bytes).toBeLessThan(4000);
    }
  });
});

// ---------------------------------------------------------------------------
// HandoffFieldSpec.key typing
// ---------------------------------------------------------------------------

describe("HandoffFieldSpec.key typing", () => {
  it("WORK_STEP_FIELDS keys are valid WorkerHandoff keys", () => {
    // This is primarily a compile-time check — if the keys were wrong,
    // TypeScript would fail to compile. At runtime we verify they're strings.
    for (const field of WORK_STEP_FIELDS) {
      expect(typeof field.key).toBe("string");
      expect(field.key.length).toBeGreaterThan(0);
    }
  });

  it("all field registries have non-empty fields", () => {
    expect(WORK_STEP_FIELDS.length).toBeGreaterThan(0);
    expect(PLAN_DRAFT_FIELDS.length).toBeGreaterThan(0);
    expect(PLAN_REVIEW_FIELDS.length).toBeGreaterThan(0);
    expect(PLAN_CONSOLIDATE_FIELDS.length).toBeGreaterThan(0);
    expect(REVIEW_FIELDS.length).toBeGreaterThan(0);
    expect(SHIP_FIELDS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// renderEvaluatorHandoffInstruction / renderDispatcherHandoffInstruction
// ---------------------------------------------------------------------------

describe("renderEvaluatorHandoffInstruction", () => {
  it("includes the handoff path in output", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    expect(output).toContain("/tmp/eval.json");
  });

  it("includes evaluator-specific fields", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    expect(output).toContain("passed");
    expect(output).toContain("confidence");
    expect(output).toContain("reasoning");
    expect(output).toContain("feedback");
  });

  it("output is under 4000 bytes", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    const bytes = new TextEncoder().encode(output).length;
    expect(bytes).toBeLessThan(4000);
  });
});

describe("renderDispatcherHandoffInstruction", () => {
  it("includes the handoff path in output", () => {
    const output = renderDispatcherHandoffInstruction("/tmp/dispatch.json");
    expect(output).toContain("/tmp/dispatch.json");
  });

  it("includes dispatcher-specific fields", () => {
    const output = renderDispatcherHandoffInstruction("/tmp/dispatch.json");
    expect(output).toContain("schema_version");
    expect(output).toContain("step_index");
    expect(output).toContain("task_content");
    expect(output).toContain("context_files");
  });

  it("output is under 4000 bytes", () => {
    const output = renderDispatcherHandoffInstruction("/tmp/dispatch.json");
    const bytes = new TextEncoder().encode(output).length;
    expect(bytes).toBeLessThan(4000);
  });
});
