import type { WorkflowStepContext } from "../index.js";
import { SEVERITY_DEFINITIONS, SCOPE_DISCIPLINE } from "../conventions.js";
import type { ResolvedQuestion } from "../../workflows/question-parser.js";

/**
 * Format a single resolved question as a readable line.
 */
function formatResolvedQuestion(q: ResolvedQuestion, index: number): string {
  const answers = q.answers.length > 0 ? q.answers.join(", ") : "_no answer_";
  return `${index + 1}. ${q.question} → ${answers} (source: ${q.source})`;
}

/**
 * Builds a prompt for consolidating a reviewed plan into a final actionable plan.
 */
export function buildPlanConsolidatePrompt(ctx: WorkflowStepContext): string {
  const resolvedQuestions = ctx.extra?.resolvedQuestions;
  const questionsSection =
    resolvedQuestions && Array.isArray(resolvedQuestions) && resolvedQuestions.length > 0
      ? (resolvedQuestions as ResolvedQuestion[])
          .map((q, i) => formatResolvedQuestion(q, i))
          .join("\n")
      : "_No resolved questions._";

  return `# Plan Consolidation

## Plan with Review Findings

${ctx.planContent}

## Resolved Open Questions

${questionsSection}

---

${SEVERITY_DEFINITIONS}

${SCOPE_DISCIPLINE}

## Consolidated Plan Template

Structure the final plan as:

\`\`\`markdown
---
status: READY
created: <ISO date>
reviewed: <ISO date>
feature: <short name>
---

# <Feature Name>

## Executive Summary

<1-3 sentences>

## Decisions Made

<Numbered list of all architectural decisions, including resolutions to open questions>

## Critical Items

<Any P1 findings that became BLOCKING requirements — these must be addressed before implementation begins>

## Implementation Checklist

### Phase 1: <Name>
- [ ] **1.1 Test**: ...
- [ ] **1.2 Implement**: ...
...

### Phase N: <Name>
...

## Technical Reference

<File paths, APIs, dependencies>

## Review Findings Summary

<Brief summary of review findings and how they were addressed>

## Appendix

<Supporting research, alternatives considered, risk analysis>
\`\`\`

## Synthesis Principles

1. **Deduplicate:** Merge identical or near-identical items from the original plan and review findings. Do not repeat the same concern in multiple places.

2. **Prioritize:** P1 findings become either:
   - Checklist action items (if they require implementation work), or
   - BLOCKING prerequisites (if they must be resolved before any phase starts)

3. **Preserve test-first ordering:** Every implementation step must still be preceded by its test step.

4. **Integrate insights:** Review findings belong IN the relevant checklist items, not floating as separate sections. Example:
   - Bad: "Phase 2, Step 2.3: Implement auth" + separate note "reviewer found JWT expiry issue"
   - Good: "Phase 2, Step 2.3: Implement auth with 15-min JWT expiry (per security review)"

5. **Make executable:** Vague items must become specific.
   - Bad: "Implement auth"
   - Good: "Step 2.1: Create JWT token helpers in \`src/auth/tokens.ts\` with sign/verify/refresh functions"

## Quality Checks

Before finalizing, verify:
- [ ] Every P1 finding is addressed (as a checklist item or BLOCKING note)
- [ ] Every P2 finding is addressed or explicitly deferred with rationale
- [ ] No phase depends on a later phase
- [ ] Test steps precede implementation steps
- [ ] All file references use file:line format where possible
- [ ] Open questions are all resolved (none remaining)
- [ ] The plan can be executed phase-by-phase without ambiguity

## IMPORTANT: Write the plan file to disk

After consolidating, you MUST write the final plan to a file at:
\`docs/plans/<type>-<description>.md\`

Where \`<type>\` is one of: feat, fix, refactor, chore, docs
And \`<description>\` is a short kebab-case name for the feature.

Example: \`docs/plans/feat-auth-jwt.md\`

Create the \`docs/plans/\` directory if it does not exist.
The filename MUST appear in your output so downstream tools can locate it.
`;
}
