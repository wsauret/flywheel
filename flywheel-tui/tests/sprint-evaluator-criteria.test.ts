import { describe, it, expect } from "bun:test";
import { buildSprintEvaluationCriteria } from "../src/workflows/queue/steps/sprint/evaluator-criteria";
import type { SprintIterationRecord } from "../src/workflows/queue/steps/sprint/types";

// ---------------------------------------------------------------------------
// buildSprintEvaluationCriteria — tests
//
// Validates that sprint evaluation criteria:
//   1. Contains self-review aligned checklist (6 items)
//   2. Contains "when in doubt, PASS" guidance (not adversarial)
//   3. Accepts typed SprintIterationRecord[] for test weakening detection
//   4. Requests feedback field in verdict
// ---------------------------------------------------------------------------

describe("buildSprintEvaluationCriteria", () => {
  // ── Baseline: no history ────────────────────────────────────────

  describe("without history", () => {
    const criteria = buildSprintEvaluationCriteria();

    it("returns a non-empty string", () => {
      expect(typeof criteria).toBe("string");
      expect(criteria.length).toBeGreaterThan(0);
    });

    it("contains self-review checklist items", () => {
      expect(criteria).toContain("Task alignment");
      expect(criteria).toContain("Elegance");
      expect(criteria).toContain("Diff review");
      expect(criteria).toContain("Tests");
      expect(criteria).toContain("Build");
      expect(criteria).toContain("Regression");
    });

    it("contains pass-biased guidance, not adversarial", () => {
      expect(criteria).toContain("When in doubt, PASS");
      expect(criteria).not.toContain("When in doubt, FAIL");
      expect(criteria).not.toContain("adversarial");
    });

    it("requests feedback field in verdict", () => {
      expect(criteria).toContain("feedback");
    });

    it("specifies FAIL only for hard evidence", () => {
      expect(criteria).toContain("FAIL only for hard evidence");
      expect(criteria).toContain("Tests actually failing");
    });

    it("does NOT contain weakening section when no history", () => {
      expect(criteria).not.toContain("Weakening Detection");
    });
  });

  // ── With history: test weakening detection ──────────────────────

  describe("with history", () => {
    const history: SprintIterationRecord[] = [
      {
        iteration: 1,
        workerSummary: "Added endpoint and wrote initial tests",
        evalFeedback: "Tests are too shallow — only check status 200, not response body",
        nativeCheckPassed: false,
      },
      {
        iteration: 2,
        workerSummary: "Fixed response body checks, added error path tests",
        evalFeedback: "Error path test catches wrong exception type",
        nativeCheckPassed: false,
      },
    ];

    const criteria = buildSprintEvaluationCriteria(history);

    it("includes test weakening detection section", () => {
      expect(criteria).toContain("Weakening Detection");
    });

    it("contains specific weakening indicators", () => {
      expect(criteria).toContain("Assertions removed");
      expect(criteria).toContain("trivialized");
      expect(criteria).toContain("swallow failures");
    });

    it("serializes iteration history into criteria text", () => {
      expect(criteria).toContain("Iteration 1");
      expect(criteria).toContain("Iteration 2");
      expect(criteria).toContain("Added endpoint and wrote initial tests");
      expect(criteria).toContain("Tests are too shallow");
    });

    it("includes eval feedback from prior iterations", () => {
      expect(criteria).toContain("Error path test catches wrong exception type");
    });

    it("still contains the self-review checklist", () => {
      expect(criteria).toContain("Diff review");
      expect(criteria).toContain("Elegance");
      expect(criteria).toContain("When in doubt, PASS");
    });
  });

  // ── With empty history array ────────────────────────────────────

  describe("with empty history array", () => {
    const criteria = buildSprintEvaluationCriteria([]);

    it("behaves like no-history (no weakening section)", () => {
      expect(criteria).not.toContain("Weakening Detection");
    });

    it("still has self-review checklist", () => {
      expect(criteria).toContain("Diff review");
      expect(criteria).toContain("Elegance");
      expect(criteria).toContain("When in doubt, PASS");
    });
  });

  // ── Typed input enforcement ─────────────────────────────────────

  describe("type safety", () => {
    it("accepts typed SprintIterationRecord[], not plain string", () => {
      const history: SprintIterationRecord[] = [
        { iteration: 1, workerSummary: "did stuff" },
      ];
      const criteria = buildSprintEvaluationCriteria(history);
      expect(criteria).toContain("Iteration 1");
      expect(criteria).toContain("did stuff");
    });

    it("handles record with all optional fields populated", () => {
      const history: SprintIterationRecord[] = [
        {
          iteration: 1,
          workerSummary: "full record",
          evalFeedback: "feedback here",
          nativeCheckPassed: true,
          workerCrashed: false,
        },
      ];
      const criteria = buildSprintEvaluationCriteria(history);
      expect(criteria).toContain("full record");
      expect(criteria).toContain("feedback here");
    });

    it("handles record where worker crashed", () => {
      const history: SprintIterationRecord[] = [
        {
          iteration: 1,
          workerSummary: "attempted work",
          workerCrashed: true,
        },
      ];
      const criteria = buildSprintEvaluationCriteria(history);
      expect(criteria).toContain("crashed");
    });
  });
});
