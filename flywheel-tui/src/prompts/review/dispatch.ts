import type { WorkflowStepContext } from "../index.js";
import {
  SEVERITY_DEFINITIONS,
  FILE_LINE_DISCIPLINE,
  TOKEN_LIMITS,
} from "../conventions.js";
import { renderHandoffInstruction, REVIEW_FIELDS } from "../../handoff/field-specs.js";

export const reviewDispatchEvaluationCriteria =
  "Each reviewer returns findings categorized by severity (P1/P2/P3) with file:line references, or confirms no issues if changes are clean. Findings must be in structured format with Summary, Findings table, Minor Findings, and Implementation Order sections.";

/**
 * Builds a prompt for multi-agent code review dispatch.
 */
export function buildReviewDispatchPrompt(ctx: WorkflowStepContext): string {
  const baselinePlan = ctx.extra?.baselinePlan;
  const planComplianceSection =
    typeof baselinePlan === "string"
      ? `## Plan Compliance Check

Compare the implementation against the baseline plan:

<baseline-plan>
${baselinePlan}
</baseline-plan>

Perform these four checks:

1. **Items implemented:** Which plan items were completed? Cite evidence (file:line).
2. **Items skipped:** Which plan items were NOT implemented? Flag with severity.
3. **Items added:** What was implemented that was NOT in the plan? Justify or flag.
4. **Items modified:** What diverged from the plan specification? Explain why.

### Compliance Report Format

\`\`\`markdown
| Plan Item | Status | Evidence / Notes |
|-----------|--------|------------------|
| 1.1 ...   | Done   | src/auth.ts:42   |
| 1.2 ...   | Skipped | No test written  |
| 2.1 ...   | Modified | Used Redis instead of in-memory (justified: scale requirement) |
\`\`\`
`
      : "";

  return `# Code Review

## Diff / Changes to Review

${ctx.planContent}

${planComplianceSection}

---

${SEVERITY_DEFINITIONS}

${FILE_LINE_DISCIPLINE}

${TOKEN_LIMITS}

## Reviewer Dispatch

Dispatch review agents in parallel. Each reviewer returns findings in their response only — no file writes.

### Review Dimensions

1. **Correctness** — Logic errors, off-by-one, null handling, race conditions, incorrect API usage.
2. **Security** — Injection, auth bypass, secret exposure, unsafe deserialization, SSRF.
3. **Testing** — Missing coverage, fragile tests, test-implementation coupling, untested error paths.
4. **Architecture** — Layering violations, god objects, circular dependencies, pattern breaks.
5. **Performance** — O(n^2) in hot paths, unnecessary allocations, missing pagination, unbounded queries.
6. **Validation Contract Compliance** — If a validation contract exists (a \`*.validation-contract.md\` file alongside the plan), check: (a) every \`<!-- fulfills: VAL-... -->\` annotation in the plan references an assertion that exists in the contract, (b) every contract assertion is claimed by exactly one step, (c) no orphaned or duplicate assertion IDs. If no contract exists, skip this dimension.

## Finding Synthesis

After collecting findings from all reviewers:

### 1. Collect & Deduplicate

- Same file + same line + same issue = merge (cite all reviewers)
- Related findings on same file = group
- Unique findings = keep as-is

### 2. Severity Assignment

Apply severity definitions strictly:
- Security vulnerabilities and data corruption → P1
- Missing error handling, untested critical paths → P2
- Style, naming, minor refactors → P3

### 3. P3 Triage

For P3 findings, decide:
- **Include** if it's a 1-line fix adjacent to other changes
- **Exclude** if it would expand scope or is purely cosmetic
- Format excluded P3s as: \`P3 (deferred): <finding> — reason: <why not now>\`

### 4. Step Grouping

Group findings for implementation:
- By file/module (changes to the same file go together)
- Ordered by severity within each group (P1 first)
- Respect dependencies (if fix A must happen before fix B, note it)

## Output Format

You MUST use the exact headings below. The headings are parsed by downstream tooling — do NOT rename, reword, or omit them.

\`\`\`yaml
---
type: code-review
date: <ISO date>
scope: <branch name or PR number>
status: complete
findings: { p1: <count>, p2: <count>, p3: <count> }
---
\`\`\`

\`\`\`markdown
## Summary

2-3 sentence overview of code quality and key concerns.

## Findings

| # | Finding | Severity | File | Reviewers | Action Required |
|---|---------|----------|------|-----------|-----------------|
| 1 | ...     | P1       | ...  | ...       | ...             |
| 2 | ...     | P2       | ...  | ...       | ...             |
| 3 | ...     | P3       | ...  | ...       | ...             |

## Minor Findings

- P3: <finding> at \`file:line\`
- P3 (deferred): <finding> at \`file:line\` — reason: <why not now>

## Implementation Order

Ordered list of fixes grouped by file, respecting dependencies.
\`\`\`

**CRITICAL:** The \`## Findings\` table MUST include a "Severity" column with values P1/P2/P3. The \`## Minor Findings\` section MUST use the exact heading. P3 bullets MUST start with \`- P3:\` or \`- P3 (deferred):\`. These formats are parsed by downstream tooling — do NOT deviate.

The review document must be consumable as an implementation plan. A developer should be able to go through it top-to-bottom and address every finding.
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(REVIEW_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
