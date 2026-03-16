import type { WorkflowStepContext } from "../index.js";
import { SEVERITY_DEFINITIONS, SCOPE_DISCIPLINE } from "../conventions.js";

/**
 * Builds a prompt for consolidating a reviewed plan into a final actionable plan.
 */
export function buildPlanConsolidatePrompt(ctx: WorkflowStepContext): string {
  const resolvedQuestions = ctx.extra?.resolvedQuestions;
  const questionsSection =
    resolvedQuestions && Array.isArray(resolvedQuestions)
      ? resolvedQuestions
          .map(
            (q: unknown, i: number) =>
              `${i + 1}. ${typeof q === "string" ? q : JSON.stringify(q)}`
          )
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
`;
}
