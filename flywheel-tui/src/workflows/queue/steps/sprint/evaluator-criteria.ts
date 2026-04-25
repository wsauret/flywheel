// Sprint Evaluator Criteria — self-review-aligned evaluation for sprint mode.
//
// Evaluates work against the self-review checklist (defined in
// evaluator-criteria-prefix.md). The evaluator should PASS work that meets
// these criteria and only FAIL for hard evidence of broken functionality —
// not for style, minor omissions, or gold-plating.
//
// Sprint mode uses Opus for the evaluator to provide thorough assessment.

import { fileURLToPath } from "node:url";

import { loadStepMarkdown } from "../../shared/load-step-markdown.js";
import type { SprintIterationRecord } from "./types.js";

// Loaded once at module load for prompt caching.
const STATIC_CRITERIA_PREFIX = loadStepMarkdown(
  fileURLToPath(new URL("./evaluator-criteria-prefix.md", import.meta.url)),
  "workflows/queue/steps/sprint/evaluator-criteria-prefix.md",
  "sprint evaluator criteria",
);

/**
 * Build self-review-aligned evaluation criteria for a sprint iteration.
 *
 * The returned string is passed as `evaluation_criteria` to the evaluator
 * transport, which wraps it in the full evaluator prompt. This function
 * only produces the sprint-specific criteria section.
 *
 * The static prefix (pass-biased checklist, verdict fields, FAIL/PASS
 * guidelines) is precomputed at module load. Only the dynamic history
 * section is appended at runtime.
 *
 * @param history - Typed iteration records from prior sprint rounds.
 *   When provided (and non-empty), enables test-weakening detection
 *   criteria with serialized iteration context.
 */
export function buildSprintEvaluationCriteria(
  history?: SprintIterationRecord[],
): string {
  const hasHistory = history != null && history.length > 0;

  if (!hasHistory) {
    return STATIC_CRITERIA_PREFIX;
  }

  const dynamicSections: string[] = [
    "### Test Weakening Detection",
    "",
    "**CRITICAL:** Compare the current tests against what was described in prior iterations.",
    "If the worker has weakened tests to make them pass, you MUST FAIL the evaluation.",
    "",
    "Weakening includes:",
    "- Assertions removed or commented out",
    "- Assertions trivialized (e.g., checking for any response instead of specific values)",
    "- Error case tests removed",
    "- Try/catch blocks that swallow failures silently",
    "- Test logic changed to always pass regardless of implementation correctness",
    "",
    "The correct approach is to fix the implementation to satisfy the assertions,",
    "NOT to weaken the assertions to match a broken implementation.",
    "",

    "### Prior Iteration History",
    "",
    "Use this history to detect test weakening and understand progression:",
    "",
  ];

  for (const record of history) {
    dynamicSections.push(`**Iteration ${record.iteration}**`);
    dynamicSections.push(`- Worker summary: ${record.workerSummary}`);
    if (record.evalFeedback) {
      dynamicSections.push(`- Evaluator feedback: ${record.evalFeedback}`);
    }
    if (record.nativeCheckPassed != null) {
      dynamicSections.push(`- Native checks passed: ${record.nativeCheckPassed}`);
    }
    if (record.workerCrashed) {
      dynamicSections.push(`- Worker crashed during this iteration`);
    }
    dynamicSections.push("");
  }

  return STATIC_CRITERIA_PREFIX + dynamicSections.join("\n");
}
