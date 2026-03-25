import type { WorkflowStepContext } from "../index.js";
import {
  SEVERITY_DEFINITIONS,
  TOKEN_LIMITS,
  FILE_LINE_DISCIPLINE,
} from "../conventions.js";
import { renderHandoffInstruction, PLAN_REVIEW_FIELDS } from "../../handoff/field-specs.js";

/**
 * Builds a prompt for reviewing a plan via multi-reviewer dispatch.
 */
export function buildPlanReviewPrompt(ctx: WorkflowStepContext): string {
  return `# Plan Review

## Plan to Review

${ctx.planContent}

---

${SEVERITY_DEFINITIONS}

${TOKEN_LIMITS}

${FILE_LINE_DISCIPLINE}

## Reviewer Dispatch

Dispatch ALL of the following reviewer agents. Do NOT filter agents — run them ALL.

**Critical constraint for every reviewer:**
> Do NOT write to any files. Return findings in your response only.

### Reviewer Agents

1. **reviewer-correctness** — Will the plan produce correct behavior? Look for logic errors, missing edge cases, incorrect assumptions about APIs or data.

2. **reviewer-security** — Are there security concerns? Auth bypasses, injection risks, secret handling, permission escalation.

3. **reviewer-testing** — Is the test strategy sufficient? Missing test cases, untestable designs, test-implementation coupling.

4. **reviewer-architecture** — Does the plan fit the existing codebase? Layering violations, unnecessary coupling, pattern inconsistencies.

5. **reviewer-scope** — Is the plan appropriately scoped? Over-engineering, missing requirements, unnecessary phases.

6. **reviewer-dependencies** — Are external dependencies appropriate? Version conflicts, licensing, maintenance risk, alternatives.

### Contradiction Handling

If a finding from one reviewer contradicts another reviewer, flag it as:

\`\`\`
**OPEN QUESTION:** <description of the contradiction>
- Reviewer A says: <position>
- Reviewer B says: <position>
- Recommendation: <your assessment or "needs user input">
\`\`\`

## Deduplication Rules

After collecting all reviewer findings:

1. **Identical findings** (same file, same line, same issue): Merge into one finding, cite all reviewers who found it.
2. **Similar findings** (related but different aspect): Group together, note the nuances from each reviewer.
3. **Unique findings**: Keep as-is with the originating reviewer noted.

## Output Format

You MUST use the exact headings below. The headings are parsed by downstream tooling — do NOT rename, reword, or omit them.

\`\`\`markdown
# Plan Review Summary

## Critical (P1)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | ...     | ...  | ...       | ...             |

## Important (P2)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | ...     | ...  | ...       | ...             |

## Minor (P3)

| # | Finding | File | Reviewers |
|---|---------|------|-----------|
| 1 | ...     | ...  | ...       |

## Open Questions

1. <question with context from contradicting reviewers>
2. ...
\`\`\`

**CRITICAL:** The \`## Open Questions\` section MUST be present as an H2 heading even if there are no open questions (write "None." as the body). Questions found under any other heading will be missed by the pipeline.
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_REVIEW_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
