import type { WorkflowStepContext } from "../index.js";
import { SEVERITY_DEFINITIONS, SCOPE_DISCIPLINE } from "../conventions.js";
import type { P3Finding } from "../../workflows/review-output-extractor.js";
import { renderHandoffInstruction, REVIEW_FIELDS } from "../../handoff/field-specs.js";
import { DEFAULT_REVIEWS_DIR } from "../../config/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface P3TriageExplicit {
  included: P3Finding[];
  excluded: P3Finding[];
  source: string;
}

interface P3TriageDirective {
  directive: string;
}

type P3Triage = P3TriageExplicit | P3TriageDirective;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExplicitTriage(t: P3Triage): t is P3TriageExplicit {
  return "included" in t && "excluded" in t;
}

function formatFindingList(findings: P3Finding[]): string {
  if (findings.length === 0) return "_None._";
  return findings
    .map((f, i) => `${i + 1}. **${f.title}** — ${f.summary} (\`${f.location}\`)`)
    .join("\n");
}

/**
 * Build the P3 triage section based on the three modes:
 *
 * 1. Explicit included/excluded lists (user triaged interactively)
 * 2. Directive (non-interactive or user dismissed the triage prompt)
 * 3. Absent (no P3 findings were found)
 */
function buildP3TriageSection(extra: Record<string, unknown> | undefined): string {
  const triage = extra?.p3Triage as P3Triage | undefined;

  // Mode 3: No p3Triage key — no P3 findings or key omitted
  if (!triage) {
    return `## P3 (Minor) Finding Guidance

Include findings worth fixing (1-line fixes, adjacent to other changes). Exclude purely cosmetic items.`;
  }

  // Mode 1: User triaged interactively — explicit include/exclude lists
  if (isExplicitTriage(triage)) {
    return `## P3 (Minor) Findings — User-Triaged

The user has already triaged P3 findings. Respect their decisions exactly.

### P3 Findings to Include

${formatFindingList(triage.included)}

### P3 Findings to Exclude

${formatFindingList(triage.excluded)}`;
  }

  // Mode 2: Directive — worker must triage P3s itself
  return `## P3 (Minor) Finding Guidance

Triage P3 findings yourself. Include non-cosmetic P3 findings that are worth fixing (1-line fixes, adjacent to other changes). Exclude purely cosmetic items (whitespace, style-only, import ordering).`;
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

export const reviewConsolidateValidationCriteria =
  "Review document written to disk with P1/P2/P3 findings and implementation order (file path appears in output), or clean summary if no significant issues found";

/**
 * Builds a prompt for the review consolidation step.
 *
 * Receives the multi-agent review findings (from previousResult) and
 * optional P3 triage data (from ctx.extra.p3Triage), then instructs the
 * worker to produce the final review document.
 */
export function buildReviewConsolidatePrompt(ctx: WorkflowStepContext): string {
  const p3Section = buildP3TriageSection(ctx.extra);
  const previousFindings = ctx.previousResult
    ? `## Review Findings from Multi-Agent Review

${ctx.previousResult}`
    : "";

  return `# Review Consolidation

You are running in an automated pipeline. Do not ask questions. Produce the review document directly.

## Scope

${ctx.planContent}

${previousFindings}

---

${SEVERITY_DEFINITIONS}

${SCOPE_DISCIPLINE}

${p3Section}

## Consolidation Instructions

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
- Respect dependencies (if fix A must happen before fix B, note it)

## Review Document Template

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
5. **Implementation Order** — Ordered list of fixes grouped by file, respecting dependencies

The review document must be consumable as an implementation plan. A developer should be able to go through it top-to-bottom and address every finding.

## IMPORTANT: Write the review document to disk

After consolidating, you MUST write the final review document to a file at:
\`${DEFAULT_REVIEWS_DIR}/YYYY-MM-DD-<slug>.md\`

Where \`<slug>\` is a short kebab-case name describing the review scope.

Example: \`${DEFAULT_REVIEWS_DIR}/2024-01-15-auth-jwt.md\`

Create the \`${DEFAULT_REVIEWS_DIR}/\` directory if it does not exist.
The filename MUST appear in your output so downstream tools can locate it.
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(REVIEW_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}
