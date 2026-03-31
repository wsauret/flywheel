// ---------------------------------------------------------------------------
// Review dispatch — reusable constants for prompt scaffolding
// ---------------------------------------------------------------------------

export const reviewDispatchEvaluationCriteria =
  "Each reviewer returns findings categorized by severity (P1/P2/P3) with file:line references, or confirms no issues if changes are clean. Findings must be in structured format with Summary, Findings table, Minor Findings, and Implementation Order sections.";

// ---------------------------------------------------------------------------
// Reusable prompt constants
// ---------------------------------------------------------------------------

/** Reviewer agent list and dispatch instructions for multi-agent review. */
export const REVIEWER_DISPATCH_INSTRUCTIONS = `Dispatch ALL of the following review agents **in parallel** using the Task tool. Launch ALL of them in a SINGLE message with multiple Task calls. Each reviewer returns findings in their response only — no file writes.

### Review Agents

These agents are pre-installed and available via the Task tool. Use the agent names discovered in Phase 0 (the prefix varies by engine). Match by the base name (e.g., \`reviewer-architecture\`):

1. **reviewer-architecture** — Layering violations, god objects, circular dependencies, SOLID compliance, pattern breaks.
2. **reviewer-code-quality** — Type safety, naming, duplication, testability. Logic errors, off-by-one, null handling, race conditions, incorrect API usage.
3. **reviewer-patterns** — Design patterns, anti-patterns, naming conventions, code duplication across the diff.
4. **reviewer-performance** — O(n^2) in hot paths, unnecessary allocations, missing pagination, unbounded queries, caching opportunities.
5. **reviewer-data-integrity** — If changes involve data models, migrations, or persistent data: migration safety, constraints, transactions, referential integrity. Skip if not applicable.
6. **Validation Contract Compliance** — You handle this dimension directly (do NOT dispatch a Task). If a validation contract exists (a \`*.validation-contract.md\` file alongside the plan), check: (a) every \`<!-- fulfills: VAL-... -->\` annotation references an assertion that exists in the contract, (b) every contract assertion is claimed by exactly one step, (c) no orphaned or duplicate assertion IDs. If no contract exists, skip this dimension.`;

/** Finding synthesis instructions for after review agents complete. */
export const FINDING_SYNTHESIS_INSTRUCTIONS = `## Finding Synthesis

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
- Respect dependencies (if fix A must happen before fix B, note it)`;

/** Review document output format template. */
export const REVIEW_OUTPUT_FORMAT = `## Output Format

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

The review document must be consumable as an implementation plan. A developer should be able to go through it top-to-bottom and address every finding.`;
