import { describe, it, expect } from "bun:test";
import { reviewConsolidateValidationCriteria } from "../src/prompts/review/consolidate";
import { reviewDispatchValidationCriteria } from "../src/prompts/review/dispatch";
import { reviewFixValidationCriteria } from "../src/prompts/review/fix";
import { reviewWorkflow } from "../src/workflows/review";
import { DEFAULT_REVIEWS_DIR } from "../src/config/paths";
import {
  renderHandoffInstruction,
  renderEvaluatorHandoffInstruction,
  renderDispatcherHandoffInstruction,
  REVIEW_FIELDS,
  WORK_PHASE_FIELDS,
} from "../src/handoff/field-specs";

// ---------------------------------------------------------------------------
// Review evaluator/worker path alignment
// ---------------------------------------------------------------------------

describe("review evaluator/worker path alignment", () => {
  it("consolidate validationCriteria mentions .flywheel/reviews/ path pattern", () => {
    expect(reviewConsolidateValidationCriteria).toContain(".flywheel/reviews/");
  });

  it("consolidate validationCriteria mentions date-slug filename pattern", () => {
    expect(reviewConsolidateValidationCriteria).toContain("<date>");
    expect(reviewConsolidateValidationCriteria).toContain("<slug>");
  });

  it("consolidate validationCriteria requires file path in output", () => {
    expect(reviewConsolidateValidationCriteria).toContain("file path");
  });

  it("consolidate validationCriteria still checks for review content quality", () => {
    expect(reviewConsolidateValidationCriteria).toContain("P1/P2/P3");
    expect(reviewConsolidateValidationCriteria).toContain("findings");
  });

  it("dispatch validationCriteria mentions severity categories", () => {
    expect(reviewDispatchValidationCriteria).toContain("P1/P2/P3");
  });

  it("dispatch validationCriteria mentions structured format", () => {
    expect(reviewDispatchValidationCriteria).toContain("structured format");
  });

  it("review workflow consolidation step dispatcherHint mentions output path", () => {
    const consolidateStep = reviewWorkflow.steps[1];
    expect(consolidateStep.dispatcherHint).toContain(".flywheel/reviews/");
  });

  it("DEFAULT_REVIEWS_DIR matches the path referenced in validation criteria", () => {
    expect(reviewConsolidateValidationCriteria).toContain(
      DEFAULT_REVIEWS_DIR.replace(".flywheel/", ".flywheel/"),
    );
  });
});

// ---------------------------------------------------------------------------
// Synthetic plan content includes dispatcher hints and validation criteria
// ---------------------------------------------------------------------------

describe("review workflow definition completeness", () => {
  it("all review steps have validationCriteria", () => {
    for (const step of reviewWorkflow.steps) {
      expect(step.validationCriteria).toBeTruthy();
      expect(typeof step.validationCriteria).toBe("string");
      expect(step.validationCriteria!.length).toBeGreaterThan(10);
    }
  });

  it("all review steps have dispatcherHint", () => {
    for (const step of reviewWorkflow.steps) {
      expect(step.dispatcherHint).toBeTruthy();
      expect(typeof step.dispatcherHint).toBe("string");
      expect(step.dispatcherHint!.length).toBeGreaterThan(10);
    }
  });

  it("fix step validationCriteria still checks quality", () => {
    expect(reviewFixValidationCriteria).toContain("P1");
    expect(reviewFixValidationCriteria).toContain("tests pass");
  });
});

// ---------------------------------------------------------------------------
// Handoff instructions clarity for reducing parse failures
// ---------------------------------------------------------------------------

describe("handoff instruction clarity", () => {
  const testPath = "/tmp/test-handoff.json";

  it("worker handoff instruction emphasizes CRITICAL importance", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
    expect(output).toContain("CRITICAL");
  });

  it("worker handoff instruction includes JSON example structure", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
    expect(output).toContain("```json");
  });

  it("worker handoff instruction mentions file-writing tool requirement", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
    expect(output).toContain("file-writing tool");
  });

  it("worker handoff instruction warns against stdout", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
    expect(output).toContain("stdout");
    expect(output).toContain("Do NOT");
  });

  it("worker handoff instruction warns about trailing commas", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
    expect(output).toContain("trailing commas");
  });

  it("worker handoff instruction mentions retry consequence", () => {
    const output = renderHandoffInstruction(WORK_PHASE_FIELDS, testPath);
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
