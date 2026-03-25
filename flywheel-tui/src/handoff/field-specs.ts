import type { WorkerHandoff } from "../schemas/handoff";

// ---------------------------------------------------------------------------
// HandoffFieldSpec — typed key ensures compile-time safety
// ---------------------------------------------------------------------------

export interface HandoffFieldSpec {
  key: keyof WorkerHandoff;
  description: string;
  example: string;
  required?: boolean; // default false; summary is always required
}

// ---------------------------------------------------------------------------
// Per-workflow field registries
// ---------------------------------------------------------------------------

export const WORK_PHASE_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was done, decisions made, and current state",
    example: '"Implemented the authentication middleware with JWT validation..."',
    required: true,
  },
  {
    key: "artifacts",
    description: "Files created, modified, and commands run during this phase",
    example: '{"files_created": ["src/auth.ts"], "files_modified": ["src/app.ts"], "commands_run": ["bun test"]}',
  },
  {
    key: "verification",
    description: "Whether tests passed and a brief summary of test output",
    example: '{"tests_passed": true, "test_output_summary": "12/12 tests pass"}',
  },
  {
    key: "decisions",
    description: "Key architectural or implementation decisions made",
    example: '["Used JWT over session tokens for statelessness"]',
  },
  {
    key: "warnings",
    description: "Issues or risks discovered during execution",
    example: '["Rate limiter not yet configured for production"]',
  },
  {
    key: "files_to_review",
    description: "Files that should be reviewed by the evaluator or user",
    example: '["src/auth.ts", "tests/auth.test.ts"]',
  },
];

export const PLAN_DRAFT_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the plan created, its scope, and approach",
    example: '"Created a 4-phase plan for implementing the auth system..."',
    required: true,
  },
  {
    key: "decisions",
    description: "Key decisions made while drafting the plan",
    example: '["Split into 4 phases for incremental delivery"]',
  },
  {
    key: "warnings",
    description: "Risks or concerns identified during planning",
    example: '["Migration may require downtime"]',
  },
];

export const PLAN_REVIEW_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the plan review findings",
    example: '"Reviewed the 4-phase auth plan. Found 2 open questions..."',
    required: true,
  },
  {
    key: "open_questions",
    description: "Questions that need user input before proceeding",
    example: '[{"question": "Which auth provider?", "options": ["Auth0", "Cognito"], "header": "Auth"}]',
  },
];

export const PLAN_CONSOLIDATE_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the consolidated plan",
    example: '"Consolidated plan with user decisions applied..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the final consolidated plan file",
    example: '"docs/plans/auth-plan.md"',
  },
  {
    key: "decisions",
    description: "Decisions incorporated from user answers",
    example: '["User chose Auth0 over Cognito"]',
  },
];

export const REVIEW_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the code review",
    example: '"Reviewed 12 files across 3 modules. Found 1 critical issue..."',
    required: true,
  },
  {
    key: "review_file_path",
    description: "Path to the full review document",
    example: '"docs/reviews/auth-review.md"',
  },
  {
    key: "finding_counts",
    description: "Count of findings by severity",
    example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 7}',
  },
  {
    key: "p3_findings",
    description: "Low-priority suggestions (P3) with descriptions and suggested fixes",
    example: '[{"description": "Consider caching", "location": "src/api.ts:10", "suggestion": "Add LRU cache"}]',
  },
  {
    key: "files_to_review",
    description: "Files that were reviewed",
    example: '["src/auth.ts", "src/middleware.ts"]',
  },
];

export const SHIP_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was shipped (commit, PR, learnings)",
    example: '"Committed auth feature, opened PR #42, extracted 2 learnings..."',
    required: true,
  },
  {
    key: "compound_docs",
    description: "Learnings extracted and saved as compound solution documents",
    example: '[{"title": "Fix flaky test", "type": "bug-fix", "tags": ["testing"], "problem": "Timing issue", "solution": "Added retry"}]',
  },
];

// ---------------------------------------------------------------------------
// renderHandoffInstruction — produces markdown instruction for LLM
// ---------------------------------------------------------------------------

export function renderHandoffInstruction(
  fields: HandoffFieldSpec[],
  handoffPath: string,
): string {
  // Ensure summary is always included
  const hasSum = fields.some((f) => f.key === "summary");
  const allFields = hasSum ? fields : [WORK_PHASE_FIELDS[0], ...fields];

  const fieldLines = allFields.map((f) => {
    const req = f.required || f.key === "summary" ? " (REQUIRED)" : " (optional)";
    return `- **${f.key}**${req}: ${f.description}\n  Example: ${f.example}`;
  });

  return `## Handoff Instructions

When you are finished, write a JSON file to:
\`${handoffPath}\`

The JSON must include these fields:

${fieldLines.join("\n\n")}

The \`summary\` field is required (100-5000 characters). All other fields are optional but encouraged when applicable. Do NOT include fields not listed above — unknown fields will cause a validation error and retry.`;
}

// ---------------------------------------------------------------------------
// renderEvaluatorHandoffInstruction
// ---------------------------------------------------------------------------

export function renderEvaluatorHandoffInstruction(handoffPath: string): string {
  return `## Evaluator Handoff Instructions

When you are finished evaluating, write a JSON file to:
\`${handoffPath}\`

The JSON must include ALL of these fields:

- **passed** (REQUIRED): Whether the phase output meets acceptance criteria. Boolean.
  Example: true
- **reasoning** (REQUIRED): Explanation of the evaluation decision.
  Example: "All acceptance criteria met, tests pass, code is clean."
- **suggestions** (REQUIRED): List of improvement suggestions. Empty array if none.
  Example: ["Add edge case tests for null input"]
- **confidence** (REQUIRED): Confidence in the verdict, 0.0 to 1.0.
  Example: 0.92
- **feedback** (REQUIRED): Actionable feedback for the worker if retrying.
  Example: "Consider adding error handling for the API timeout case."
- **files_to_review** (REQUIRED): Files that should be reviewed. Empty array if none.
  Example: ["src/feature.ts", "tests/feature.test.ts"]

Do NOT include fields not listed above — unknown fields will cause a validation error.`;
}

// ---------------------------------------------------------------------------
// renderDispatcherHandoffInstruction
// ---------------------------------------------------------------------------

export function renderDispatcherHandoffInstruction(handoffPath: string): string {
  return `## Dispatcher Handoff Instructions

When you are finished, write a JSON file to:
\`${handoffPath}\`

The JSON must include these fields:

- **schema_version** (REQUIRED): Must be 1. Literal number.
  Example: 1
- **phase_index** (REQUIRED): Zero-based index of the phase being dispatched.
  Example: 0
- **task_content** (REQUIRED): The task prompt to send to the worker.
  Example: "Implement feature X according to the plan."
- **context_files** (REQUIRED): File paths the worker should reference. Array of strings.
  Example: ["src/foo.ts", "tests/foo.test.ts"]
- **validation_criteria** (optional): Criteria for evaluating the worker's output.
  Example: "Tests pass, no lint errors"
- **session_name** (optional): Name for the worker session.
  Example: "work-session-phase-1"
- **reasoning** (optional): Why this dispatch decision was made.
  Example: "Standard implementation phase, no special handling needed."
- **worker_config** (optional): Override worker configuration.
  Example: {"model_override": null, "timeout_minutes": 30}

Do NOT include fields not listed above — unknown fields will cause a validation error.`;
}
