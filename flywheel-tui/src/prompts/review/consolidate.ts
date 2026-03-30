// ---------------------------------------------------------------------------
// Review consolidation — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

export const reviewConsolidateEvaluationCriteria =
  "Review document written to session directory with P1/P2/P3 findings and implementation order. The file path must appear in worker output. If no significant issues, a clean summary is acceptable.";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Consolidation dedup/severity/ordering instructions. */
export const CONSOLIDATION_INSTRUCTIONS = `## Consolidation Instructions

### 1. Deduplicate

- Same file + same line + same issue = merge (cite all reviewers)
- Related findings on the same file = group
- Unique findings = keep as-is

### 2. Severity Assignment

Apply severity definitions strictly:
- Security vulnerabilities and data corruption → P1
- Missing error handling, untested critical paths → P2
- Style, naming, minor refactors → P3

### 3. Implementation Order

Group findings for implementation:
- By file/module (changes to the same file go together)
- Ordered by severity within each group (P1 first)
- Respect dependencies (if fix A must happen before fix B, note it)`;

/** Review document template with all required sections. */
export const REVIEW_DOC_TEMPLATE = `## Review Document Template

\`\`\`yaml
---
type: code-review
date: <ISO date>
scope: <branch name or PR number>
status: complete
findings: { p1: <count>, p2: <count>, p3: <count> }
---
\`\`\`

### Sections

1. **Summary** — 2-3 sentence overview of code quality and key concerns
2. **Critical Findings (P1)** — Table: finding, file:line, reviewer, required action
3. **Important Findings (P2)** — Table: finding, file:line, reviewer, recommended action
4. **Minor Findings (P3)** — Bulleted list with deferred items noted
5. **Validation Contract Compliance** — If a validation contract exists alongside the plan, include: coverage completeness (all assertions claimed?), orphaned assertion IDs, duplicate claims, and any \`<!-- fulfills: ... -->\` annotations referencing non-existent assertions. Omit this section if no contract is present.
6. **Implementation Order** — Ordered list of fixes grouped by file, respecting dependencies

The review document must be consumable as an implementation plan. A developer should be able to go through it top-to-bottom and address every finding.`;
