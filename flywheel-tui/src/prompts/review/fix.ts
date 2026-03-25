import type { WorkflowStepContext } from "../index.js";
import {
  SEVERITY_DEFINITIONS,
  SCOPE_DISCIPLINE,
  TDD_CYCLE,
  UNDERSTAND_ACT_VERIFY,
  VERIFICATION_BANNED_PHRASES,
  THREE_STRIKE_PROTOCOL,
  buildIterationBudgetInstruction,
  buildProjectContextSection,
} from "../conventions.js";
import { renderHandoffInstruction, REVIEW_FIELDS } from "../../handoff/field-specs.js";

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

export const reviewFixValidationCriteria =
  "All P1 findings addressed, P2 findings addressed where feasible, tests pass";

/**
 * Builds a work-style implementation prompt for the review fix step.
 *
 * This prompt only runs when `hasActionableFindings` is true (the
 * `shouldSkipPhase` hook skips this step otherwise). It uses the same
 * conventions as `buildWorkPhasePrompt` — TDD cycle, verification
 * protocol, scope discipline — with the review document as the task.
 *
 * The review findings are passed via:
 * - `ctx.previousResult` — the consolidation step output (always present)
 * - `ctx.extra.reviewFilePath` — path to the persisted review document
 * - `ctx.extra.findingCounts` — `{ p1, p2, p3 }` counts
 */
export function buildReviewFixPrompt(ctx: WorkflowStepContext): string {
  const reviewFilePath = ctx.extra?.reviewFilePath as string | undefined;
  const findingCounts = ctx.extra?.findingCounts as { p1: number; p2: number; p3: number } | undefined;

  const reviewFileRef = reviewFilePath
    ? `Review document: \`${reviewFilePath}\``
    : "";

  const findingSummary = findingCounts
    ? `Findings: ${findingCounts.p1} P1 (critical), ${findingCounts.p2} P2 (important), ${findingCounts.p3} P3 (minor)`
    : "";

  const reviewContent = ctx.previousResult
    ? `## Review Document\n\n${ctx.previousResult}`
    : "";

  const iterationBudget =
    typeof ctx.extra?.iterationBudget === "number"
      ? `\n${buildIterationBudgetInstruction(ctx.extra.iterationBudget)}\n`
      : "";

  const projectContext = buildProjectContextSection(ctx.extra);

  return `# Work Phase Execution — Review Fix

You are running in an automated pipeline. Do not ask questions. Implement all required fixes directly.

## Task

Implement the fixes identified in the code review below. Address findings in strict priority order:

1. **P1 findings first** — Critical issues that block correctness, security, or data integrity.
2. **P2 findings second** — Important quality and maintainability issues.
3. **Skip P3 findings** unless they were explicitly included by the user in the review triage.

${reviewFileRef}
${findingSummary}

${SEVERITY_DEFINITIONS}

${reviewContent}

${ctx.projectCwd ? `## Working Directory\n\n\`${ctx.projectCwd}\`` : ""}

${projectContext}

---

${TDD_CYCLE}

${SCOPE_DISCIPLINE}

${UNDERSTAND_ACT_VERIFY}
${iterationBudget}
## Verification Protocol

Before making ANY claim about the state of the code, follow this protocol:

1. **IDENTIFY:** What command proves this claim?
2. **RUN:** Execute the FULL command fresh (do not rely on cached or remembered output).
3. **READ:** Read the full output. Check the exit code.
4. **VERIFY:** Does the output actually confirm the claim?
5. **ONLY THEN:** Make the claim, citing the evidence.

### Evidence Requirements

| Claim | Required Evidence |
|-------|-------------------|
| "Tests pass" | Full test runner output with exit code 0 |
| "Build succeeds" | Full build output with exit code 0 |
| "Type-checks clean" | \`tsc --noEmit\` output with exit code 0 |
| "Bug is fixed" | Before/after showing the behavior change |
| "No regressions" | Full test suite output, not a subset |
| "Feature works" | Concrete demonstration (test or command output) |

## Two-Stage Review

After completing the implementation:

1. **Spec compliance:** Does each finding's fix match the review document's recommended action?
2. **Code quality:** Are there obvious issues — dead code, missing error handling, incorrect types, untested branches?

${VERIFICATION_BANNED_PHRASES}

${THREE_STRIKE_PROTOCOL}

## Scope Rules

- Only fix findings listed in the review document above.
- Do not refactor code that is not related to a finding.
- Do not add features, documentation, or improvements beyond what the findings require.
- If a finding is ambiguous, implement the most conservative fix.

${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(REVIEW_FIELDS, ctx.extra.handoffPath as string)}` : `## Completion

When the phase is done, provide:
- Summary of what was fixed (by finding ID/severity)
- Evidence of verification (command outputs)
- Any findings that could not be addressed and why`}
`;
}
