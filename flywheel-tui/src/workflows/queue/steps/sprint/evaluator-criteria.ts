// Sprint Evaluator Criteria — self-review-aligned evaluation for sprint mode.
//
// Evaluates work against the same 7-point checklist used by the self-review
// injection (shared/self-review-checklist.ts). The evaluator
// should PASS work that meets these criteria and only FAIL for hard evidence
// of broken functionality — not for style, minor omissions, or gold-plating.
//
// Sprint mode uses Opus for the evaluator to provide thorough assessment.

import type { SprintIterationRecord } from "./types.js";

// Static criteria prefix — self-review aligned assessment and FAIL/PASS rules.
// Computed once at module load.

const STATIC_CRITERIA_PREFIX = [
  "## Sprint Mode: Evaluation Criteria",
  "",
  "Evaluate the worker's output against these 7 checks — the same checklist",
  "the worker used for self-review before submitting. Your job is to verify",
  "the worker did what was asked, not to find reasons to fail passing work.",
  "",

  // ── Self-review aligned checklist ───────────────────────────────
  "### Assessment Checklist",
  "",
  "1. **Diff review** — scan for obvious mistakes, unused imports, missing implementations, debug/temp code",
  "2. **Task alignment** — all requested changes present? Any files mentioned in the task not touched?",
  "3. **Completeness** — any TODOs, placeholders, half-finished pieces? If acceptance criteria exist, verify each is met.",
  "4. **Test coverage** — did the worker add/update tests for new behavior? Do tests pass?",
  "5. **Regression check** — could the changes break existing functionality?",
  "6. **Edge cases** — obvious error handling gaps? Inputs that would break?",
  "7. **Elegance** — is this the simplest, most symmetric design? No unnecessary abstractions, no callback chains, no duplicated state? Would a reader say \"of course\" rather than \"why\"?",
  "",

  // ── Verdict output fields ───────────────────────────────────────
  "### Required Feedback Fields",
  "",
  "Your verdict MUST include:",
  "- `implementation_feedback`: Specific feedback on checklist items 1-3, 5-7.",
  "- `script_feedback`: Specific feedback on checklist item 4 (tests).",
  "- `feedback`: Combined summary for the worker if a retry is needed.",
  "",

  // ── When to FAIL / PASS ─────────────────────────────────────────
  "### When to FAIL",
  "",
  "FAIL only for hard evidence of problems:",
  "- Tests actually failing or not running",
  "- Critical deliverables missing from the task requirements",
  "- Implementation fundamentally wrong or broken",
  "- Tests weakened compared to previous iterations (assertions removed/trivialized)",
  "",
  "### When to PASS",
  "",
  "PASS when the work meets the task requirements, even if imperfect:",
  "- Implementation addresses the task. Minor style issues are NOT grounds to fail.",
  "- Tests exist and validate the core behavior. Not every edge case needs coverage.",
  "- When in doubt, PASS with suggestions. Retries are expensive.",
  "",
].join("\n");

// buildSprintEvaluationCriteria

/**
 * Build self-review-aligned evaluation criteria for a sprint iteration.
 *
 * The returned string is passed as `evaluation_criteria` to the evaluator
 * transport, which wraps it in the full evaluator prompt. This function
 * only produces the sprint-specific criteria section.
 *
 * The static prefix (adversarial stance, dual-channel assessment, verdict
 * fields, FAIL/PASS guidelines) is precomputed at module load. Only the
 * dynamic history section is appended at runtime.
 *
 * @param history - Typed iteration records from prior sprint rounds.
 *   When provided (and non-empty), enables test-weakening detection
 *   criteria with serialized iteration context.
 */
export function buildSprintEvaluationCriteria(
  history?: SprintIterationRecord[],
): string {
  // ── Test weakening detection (only with history) ────────────────
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

    // ── Serialized iteration history ──────────────────────────────
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
