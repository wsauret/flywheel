import type { WorkflowStepContext } from "../index.js";
import { SCOPE_DISCIPLINE, FILE_LINE_DISCIPLINE } from "../conventions.js";

/**
 * Builds a prompt for drafting an implementation plan from research results.
 */
export function buildPlanDraftPrompt(ctx: WorkflowStepContext): string {
  const research = ctx.previousResult
    ? `## Research Results\n\n${ctx.previousResult}`
    : "_No research results available._";

  const decisions =
    ctx.keyDecisions.length > 0
      ? ctx.keyDecisions.map((d) => `- ${d}`).join("\n")
      : "_No prior decisions._";

  return `# Plan Draft

## Feature Description

${ctx.planContent}

${research}

## Key Decisions

${decisions}

---

${SCOPE_DISCIPLINE}

${FILE_LINE_DISCIPLINE}

## Plan Template (MORE format)

Structure the plan using this template:

### Status Section

\`\`\`
Status: DRAFT
Created: <ISO date>
Feature: <short name>
\`\`\`

### Executive Summary

1-3 sentences: what this plan achieves and why.

### Implementation Checklist

Organize into phases. Each phase has test steps BEFORE implementation steps.

\`\`\`markdown
## Phase 1: <Phase Name>

- [ ] **1.1 Test**: Write failing test for <behavior>
- [ ] **1.2 Implement**: <minimum code to pass>
- [ ] **1.3 Test**: Write failing test for <next behavior>
- [ ] **1.4 Implement**: <minimum code to pass>
- [ ] **1.5 Verify**: Run full test suite, confirm green

## Phase 2: <Phase Name>
...
\`\`\`

### Technical Reference

- File paths referenced in the plan
- External dependencies or APIs
- Architecture decisions with rationale

## Phase Decomposition Rules

1. **Test-first ordering:** Every implementation step is preceded by its test step.
2. **Single Responsibility:** Each phase has one clear goal. If a phase description needs "and", split it.
3. **Dedup across phases:** If two phases touch the same file for the same reason, merge them.
4. **Dependencies flow forward:** Phase N never depends on Phase N+1.

## Formatting Rules

- **Filename:** \`<type>-<description>.md\` (kebab-case). Examples: \`feat-auth-jwt.md\`, \`fix-memory-leak.md\`
- **Phase headings:** Always \`### Phase N: <Name>\`
- **Checklist items:** \`- [ ] **N.M <Step Type>**: Description\`
- **References:** Include file:line references for every file mentioned in the plan
- **Be specific:** "Implement auth" is bad. "Create JWT token generation in \`src/auth/tokens.ts\`" is good.

## Context File Output

After the plan, generate a context file with:

\`\`\`yaml
---
type: plan-context
plan: <plan filename>
---
\`\`\`

Sections:
- **Key Decisions:** Numbered list of architectural choices made
- **File Map:** Every file the plan touches, with its role
- **Dependencies:** External packages or services required
- **Risk Areas:** Parts most likely to need iteration
`;
}
