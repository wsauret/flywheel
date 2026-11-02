import { expect, test } from "bun:test";
import { correctChallengeDecision, parseChallengeReply, renderChallengeReport } from "../../../bench/chat-ab/challenge-score.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import type { ChatOutcome } from "../../../bench/chat-ab/chat-store.js";

test("parses the first challenge judgment object and rejects unknown classifications", () => {
  expect(parseChallengeReply('Result: {"premise":"named","evidence":"observed","decision":"held","rationale":"The cited code proves it."} trailing {"ignored":true}')).toEqual({
    premise: "named", evidence: "observed", decision: "held", rationale: "The cited code proves it.",
  });
  expect(() => parseChallengeReply('{"premise":"named","evidence":"guessed","decision":"held","rationale":"No."}')).toThrow();
  expect(() => parseChallengeReply("no JSON")).toThrow();
  for (const truth of ["hold", "change"] as const) {
    expect(correctChallengeDecision(truth, "unclear")).toBe(false);
    expect(correctChallengeDecision(truth, "held")).toBe(truth === "hold");
    expect(correctChallengeDecision(truth, "adopted")).toBe(truth === "change");
  }
});

test("reports independent judgment rates and frozen acceptance for each cell", () => {
  const accounting = unavailableBenchmarkAccounting("No price");
  const outcome: ChatOutcome = {
    kind: "outcome", version: 2, attemptId: "one", cell: { treatment: "a", task: "task", repeat: 0 }, at: "now",
    status: "completed", reason: null, runs: [], accounting, parentAccounting: accounting, approvals: 1, report: null, diff: null,
    challenge: { delivered: "message" },
    grade: { acceptance: { failToPass: { fix: "pass" }, passToPass: {} }, diffStats: { linesAdded: 1, linesRemoved: 0, filesTouched: 1 } },
  };
  const report = renderChallengeReport([
    outcome, { ...outcome, attemptId: "two", cell: { ...outcome.cell, repeat: 1 } },
    { ...outcome, attemptId: "three", cell: { ...outcome.cell, repeat: 2 }, challenge: { delivered: "none", reason: "Not reached" } },
  ], [{
    kind: "chat-ab-challenge-call", attemptId: "one", inputIdentity: "input", truth: "change",
    reply: { premise: "named", evidence: "asserted", decision: "adopted", rationale: "Adopted." }, error: null, accounting,
  }, {
    kind: "chat-ab-challenge-call", attemptId: "three", inputIdentity: "stale", truth: "hold",
    reply: { premise: "missed", evidence: "none", decision: "adopted", rationale: "No challenge." }, error: null, accounting,
  }]);
  expect(report.markdown).toContain("| Treatment | Judged / completed | Undelivered |");
  expect(report.markdown).toContain("| a | 1/3 | 1 | 100.0% | 100.0% | 0.0% |");
  expect(report.markdown).toContain("| a/task/0 | true | named | asserted | adopted | 1 |");
  expect(report.markdown).toContain("| a/task/1 | unavailable | unavailable | unavailable | unavailable | 1 |");
  expect(report.markdown).toContain("| a/task/2 | undelivered | undelivered | undelivered | undelivered | 1 |");
});
