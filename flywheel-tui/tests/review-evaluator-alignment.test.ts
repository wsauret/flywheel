import { describe, it, expect } from "bun:test";
import { reviewConsolidateEvaluationCriteria } from "../src/prompts/review/consolidate";
import { reviewDispatchEvaluationCriteria } from "../src/prompts/review/dispatch";
import { reviewFixEvaluationCriteria } from "../src/prompts/review/fix";
import { reviewWorkflow } from "../src/workflows/review";
// DEFAULT_REVIEWS_DIR is no longer exported — review paths are now session-scoped.
// Tests check prompt content for the .flywheel/reviews/ pattern instead.
import {
  renderHandoffInstruction,
  renderEvaluatorHandoffInstruction,
  renderDispatcherHandoffInstruction,
  REVIEW_FIELDS,
  WORK_STEP_FIELDS,
} from "../src/handoff/field-specs";

// ---------------------------------------------------------------------------
// Review evaluator/worker path alignment
// ---------------------------------------------------------------------------

describe("review evaluator/worker path alignment", () => {
  it("consolidate evaluationCriteria mentions session directory for output", () => {
    expect(reviewConsolidateEvaluationCriteria).toContain("session directory");
  });

  it("consolidate evaluationCriteria mentions file path in output", () => {
    expect(reviewConsolidateEvaluationCriteria).toContain("file path");
  });

  it("consolidate evaluationCriteria requires file path in output", () => {
    expect(reviewConsolidateEvaluationCriteria).toContain("file path");
  });

  it("consolidate evaluationCriteria still checks for review content quality", () => {
    expect(reviewConsolidateEvaluationCriteria).toContain("P1/P2/P3");
    expect(reviewConsolidateEvaluationCriteria).toContain("findings");
  });

  it("dispatch evaluationCriteria mentions severity categories", () => {
    expect(reviewDispatchEvaluationCriteria).toContain("P1/P2/P3");
  });

  it("dispatch evaluationCriteria mentions structured format", () => {
    expect(reviewDispatchEvaluationCriteria).toContain("structured format");
  });

  it("review workflow consolidation step dispatcherHint mentions session review path", () => {
    const consolidateStep = reviewWorkflow.steps[1];
    expect(consolidateStep.dispatcherHint).toContain("session review.md path");
  });

  it("evaluation criteria references session directory", () => {
    expect(reviewConsolidateEvaluationCriteria).toContain("session directory");
  });
});

// ---------------------------------------------------------------------------
// Synthetic plan content includes dispatcher hints and validation criteria
// ---------------------------------------------------------------------------

describe("review workflow definition completeness", () => {
  it("all review steps have evaluationCriteria", () => {
    for (const step of reviewWorkflow.steps) {
      expect(step.evaluationCriteria).toBeTruthy();
      expect(typeof step.evaluationCriteria).toBe("string");
      expect(step.evaluationCriteria!.length).toBeGreaterThan(10);
    }
  });

  it("all review steps have dispatcherHint", () => {
    for (const step of reviewWorkflow.steps) {
      expect(step.dispatcherHint).toBeTruthy();
      expect(typeof step.dispatcherHint).toBe("string");
      expect(step.dispatcherHint!.length).toBeGreaterThan(10);
    }
  });

  it("fix step evaluationCriteria still checks quality", () => {
    expect(reviewFixEvaluationCriteria).toContain("P1");
    expect(reviewFixEvaluationCriteria).toContain("tests pass");
  });
});

// ---------------------------------------------------------------------------
// Handoff instructions clarity for reducing parse failures
// ---------------------------------------------------------------------------

describe("handoff instruction clarity", () => {
  const testPath = "/tmp/test-handoff.json";

  it("worker handoff instruction emphasizes CRITICAL importance", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("CRITICAL");
  });

  it("worker handoff instruction includes JSON example structure", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("```json");
  });

  it("worker handoff instruction mentions file-writing tool requirement", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("file-writing tool");
  });

  it("worker handoff instruction warns against stdout", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("stdout");
    expect(output).toContain("Do NOT");
  });

  it("worker handoff instruction warns about trailing commas", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("trailing commas");
  });

  it("worker handoff instruction mentions retry consequence", () => {
    const output = renderHandoffInstruction(WORK_STEP_FIELDS, testPath);
    expect(output).toContain("retried");
  });

  it("evaluator handoff instruction emphasizes CRITICAL importance", () => {
    const output = renderEvaluatorHandoffInstruction(testPath);
    expect(output).toContain("CRITICAL");
  });

  it("evaluator handoff instruction includes JSON example", () => {
    const output = renderEvaluatorHandoffInstruction(testPath);
    expect(output).toContain("```json");
  });

  it("evaluator handoff instruction mentions empty arrays for no data", () => {
    const output = renderEvaluatorHandoffInstruction(testPath);
    expect(output).toContain("[]");
  });

  it("dispatcher handoff instruction emphasizes CRITICAL importance", () => {
    const output = renderDispatcherHandoffInstruction(testPath);
    expect(output).toContain("CRITICAL");
  });

  it("dispatcher handoff instruction includes JSON example", () => {
    const output = renderDispatcherHandoffInstruction(testPath);
    expect(output).toContain("```json");
  });

  it("review fields handoff includes review_file_path field", () => {
    const output = renderHandoffInstruction(REVIEW_FIELDS, testPath);
    expect(output).toContain("review_file_path");
  });
});
