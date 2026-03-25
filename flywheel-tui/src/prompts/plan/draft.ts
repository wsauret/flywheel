import type { WorkflowStepContext } from "../index.js";
import { SCOPE_DISCIPLINE, FILE_LINE_DISCIPLINE } from "../conventions.js";
import { renderHandoffInstruction, PLAN_DRAFT_FIELDS } from "../../handoff/field-specs.js";

export const planDraftValidationCriteria =
  "Produces a plan draft with phases, checklist items, and technical reference";

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

## Milestone Markers

Group related phases into milestones using \`## Milestone:\` markers. Place them before the first phase of each milestone:

\`\`\`markdown
## Milestone: Foundation

### Phase 1: <Name>
...

### Phase 2: <Name>
...

## Milestone: Core Features

### Phase 3: <Name>
...
\`\`\`

Milestones group phases into logical deliverables. Each milestone should be independently verifiable. Use short, descriptive names (e.g., "Foundation", "Auth System", "API Layer").

## Fulfills Annotations

Each phase MUST include a \`<!-- fulfills: ... -->\` HTML comment listing the validation contract assertion IDs that the phase satisfies. Place it immediately after the phase heading:

\`\`\`markdown
### Phase 1: JWT Token Helpers
<!-- fulfills: VAL-AUTH-001, VAL-AUTH-002 -->

- [ ] **1.1 Test**: Write failing test for token generation
...
\`\`\`

Every assertion ID in the validation contract must be claimed by exactly one phase. No orphaned assertions, no duplicates.

## Validation Contract Output

After the plan, generate a \`validation-contract.md\` file that defines the acceptance criteria as testable assertions. This contract is the formal specification of what "done" means.

### Assertion ID Format

Use stable IDs with an area prefix: \`VAL-<AREA>-<NNN>\`

- \`<AREA>\` is a short uppercase tag for the functional area (e.g., AUTH, API, UI, DB)
- \`<NNN>\` is a zero-padded three-digit number starting at 001
- Examples: \`VAL-AUTH-001\`, \`VAL-API-003\`, \`VAL-UI-012\`

### Assertion Structure

Each assertion has:
- **ID and title** on the heading line (e.g., \`### VAL-AUTH-001: User can log in with valid credentials\`)
- **Behavioral description** — a plain-English statement of the expected user-visible behavior. Describe what the system does, not how it's implemented.
- **Evidence** — how to verify the assertion (e.g., "unit test output", "API response inspection", "browser screenshot")

### Contract Template

\`\`\`markdown
# Validation Contract — <Feature Name>

## Area: <Area Name>

### VAL-AREA-001: <Title>
<Behavioral description of what the system does when this assertion is true.>
Evidence: <how to verify>

### VAL-AREA-002: <Title>
<Behavioral description.>
Evidence: <how to verify>

## Area: <Another Area>

### VAL-OTHER-001: <Title>
<Behavioral description.>
Evidence: <how to verify>

## Cross-Area Flows

### VAL-CROSS-001: <End-to-end flow title>
<Behavioral description of a flow that spans multiple areas.>
Evidence: <how to verify>
\`\`\`

### Contract Rules

1. **Per-area grouping:** Group assertions under \`## Area: <Name>\` headings matching the functional areas of the plan.
2. **Cross-Area Flows:** Add a \`## Cross-Area Flows\` section for assertions that span multiple areas (e.g., "user registers then receives welcome email"). Use \`VAL-CROSS-NNN\` IDs.
3. **Behavioral, not structural:** Describe what the user or system sees, not internal implementation details.
4. **Complete coverage:** Every phase in the plan must fulfill at least one assertion. Every assertion must be fulfilled by exactly one phase.
5. **Testable:** Each assertion must be independently verifiable with the stated evidence method.

## Context File Output

After the plan and validation contract, generate a context file with:

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
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_DRAFT_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
