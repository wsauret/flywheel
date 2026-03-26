import type { WorkflowStepContext } from "../index.js";
import {
  SEVERITY_DEFINITIONS,
  TOKEN_LIMITS,
  FILE_LINE_DISCIPLINE,
} from "../conventions.js";
import { renderHandoffInstruction, PLAN_REVIEW_FIELDS } from "../../handoff/field-specs.js";

export const planReviewValidationCriteria =
  "Annotated JSON plan with review findings on steps and openQuestions array. Draft fields unmodified.";

/**
 * Builds a prompt for reviewing a JSON plan via multi-reviewer dispatch.
 *
 * The worker receives the JSON plan, dispatches 6 reviewer agents, and produces
 * ANNOTATED JSON — adding review.findings[] to each step and openQuestions[]
 * at the top level. The worker must NEVER modify draft-authored fields.
 */
export function buildPlanReviewPrompt(ctx: WorkflowStepContext): string {
  return `# Plan Review

## JSON Plan to Review

The following JSON plan was produced by the draft step. Read it carefully.

\`\`\`json
${ctx.planContent}
\`\`\`

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
2. **reviewer-security** — Security concerns? Auth bypasses, injection risks, secret handling, permission escalation.
3. **reviewer-testing** — Is the test strategy sufficient? Missing test cases, untestable designs.
4. **reviewer-architecture** — Does the plan fit the existing codebase? Layering violations, coupling, pattern inconsistencies.
5. **reviewer-scope** — Appropriately scoped? Over-engineering, missing requirements, unnecessary steps.
6. **reviewer-dependencies** — External dependencies appropriate? Version conflicts, licensing, maintenance risk.

### Contradiction Handling

If a finding from one reviewer contradicts another reviewer, add it as an open question with both positions and a recommendation.

## Deduplication Rules

After collecting all reviewer findings:

1. **Identical findings** (same step, same issue): Merge into one finding, cite all reviewers who found it.
2. **Similar findings** (related but different aspect): Group together, note the nuances from each reviewer.
3. **Unique findings**: Keep as-is with the originating reviewer noted.

## Output Format

You MUST produce annotated JSON. Read the original JSON plan, and produce a new JSON document that:
1. Preserves ALL original fields exactly as-is (do NOT modify title, description, acceptanceCriteria, fileReferences, feature, fulfills, milestone, or estimatedComplexity)
2. Adds a \`review\` object to each step that has findings
3. Adds an \`openQuestions\` array at the top level

Write the annotated JSON to the SAME file path as the original plan (overwrite it).

### Annotated JSON Structure

\`\`\`json
${ANNOTATED_JSON_EXAMPLE}
\`\`\`

### Critical Rules

1. **NEVER modify draft-authored fields.** The \`title\`, \`description\`, \`acceptanceCriteria\`, \`fileReferences\`, \`feature\`, \`fulfills\`, \`milestone\`, \`estimatedComplexity\`, \`behavioralContract\`, \`decisions\`, and \`risks\` fields must be EXACTLY as they were in the original plan.
2. **Only add \`review\` and \`openQuestions\`.** These are the only fields the review step may add.
3. **Omit \`review\` on steps with no findings.** If a step has no findings, do not add an empty \`review\` object.
4. **openQuestions is always present.** Even if empty, include \`"openQuestions": []\`.
5. **Findings use severity P1/P2/P3.** P1 = critical (must fix), P2 = important (should fix), P3 = minor (nice to fix).
6. **Each openQuestion must have:** \`question\` (string), \`raisedBy\` (reviewer name string), \`options\` (array of string choices).
${ctx.extra?.handoffPath ? `\n${renderHandoffInstruction(PLAN_REVIEW_FIELDS, ctx.extra.handoffPath as string)}` : ""}
`;
}

// ---------------------------------------------------------------------------
// Annotated JSON example (kept as constant for clarity and testability)
// ---------------------------------------------------------------------------

const ANNOTATED_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Original title (DO NOT MODIFY)",
      "description": "Original description (DO NOT MODIFY)",
      "acceptanceCriteria": ["Original (DO NOT MODIFY)"],
      "fileReferences": ["Original (DO NOT MODIFY)"],
      "feature": "original",
      "fulfills": ["BC-AREA-001"],
      "review": {
        "findings": [
          {
            "severity": "P1",
            "description": "Must bind to 127.0.0.1, not 0.0.0.0",
            "reviewer": "security",
            "actionRequired": "Add explicit host binding"
          }
        ]
      }
    },
    {
      "title": "Step with no findings",
      "description": "No review object because there are no findings",
      "acceptanceCriteria": ["..."],
      "fileReferences": ["..."]
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-AREA-001",
      "title": "DO NOT MODIFY",
      "description": "DO NOT MODIFY",
      "evidence": "DO NOT MODIFY",
      "area": "DO NOT MODIFY"
    }
  ],
  "decisions": ["DO NOT MODIFY"],
  "risks": ["DO NOT MODIFY"],
  "openQuestions": [
    {
      "question": "Should server.enabled default to true or false?",
      "raisedBy": "scope",
      "options": ["true (simpler)", "false (safer)"]
    }
  ]
}`;
