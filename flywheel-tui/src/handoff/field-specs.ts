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

export const WORK_STEP_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was done, decisions made, and current state",
    example: '"Implemented the authentication middleware with JWT validation..."',
    required: true,
  },
  {
    key: "artifacts",
    description: "Files created, modified, and commands run during this step",
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

export const PLAN_RESEARCH_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the research findings, files discovered, and patterns identified",
    example: '"Researched the codebase and identified 3 key files: hello.py (main module), test_hello.py (tests), and flywheel.toml (config). Project uses Python with simple function-based architecture."',
    required: true,
  },
  {
    key: "decisions",
    description: "Key decisions made during research",
    example: '["Focused research on Python source files"]',
  },
  {
    key: "artifacts",
    description: "Files created during research (e.g., context files)",
    example: '{"files_created": ["hello-world.context.md"]}',
  },
];

export const PLAN_DRAFT_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of the plan created, its scope, and approach",
    example: '"Created a 4-step plan for implementing the auth system..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the JSON plan file produced by the draft step",
    example: '".flywheel/plans/feat-auth.plan.json"',
  },
  {
    key: "decisions",
    description: "Key decisions made while drafting the plan",
    example: '["Split into 4 steps for incremental delivery"]',
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
    example: '"Reviewed the 4-step auth plan. Found 2 open questions..."',
    required: true,
  },
  {
    key: "plan_file_path",
    description: "Path to the annotated JSON plan file",
    example: '".flywheel/plans/feat-auth.plan.json"',
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
    description: "Path to the final consolidated JSON plan file",
    example: '".flywheel/plans/feat-auth.plan.json"',
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
    example: '".flywheel/reviews/auth-review.md"',
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

export const SPRINT_FIELDS: HandoffFieldSpec[] = [
  {
    key: "summary",
    description: "100-5000 char summary of what was implemented and verified during this sprint iteration",
    example: '"Implemented hello-world endpoint with Express, wrote verification script that curls the endpoint and asserts 200 response."',
    required: true,
  },
  {
    key: "verification_script_path",
    description: "Path to the verification script written during this sprint iteration (must be in .flywheel/verify/)",
    example: '".flywheel/verify/sprint-hello-world.ts"',
  },
  {
    key: "artifacts",
    description: "Files created, modified, and commands run during this sprint iteration",
    example: '{"files_created": ["src/hello.ts", ".flywheel/verify/sprint-hello-world.ts"], "files_modified": ["src/app.ts"], "commands_run": ["bun test"]}',
  },
  {
    key: "verification",
    description: "Whether tests passed and a brief summary of test output",
    example: '{"tests_passed": true, "test_output_summary": "5/5 tests pass, verification script exits 0"}',
  },
  {
    key: "decisions",
    description: "Key implementation decisions made during this iteration",
    example: '["Used Express over Hono for consistency with existing codebase"]',
  },
  {
    key: "warnings",
    description: "Issues or risks discovered during execution",
    example: '["Verification script only covers happy path"]',
  },
  {
    key: "files_to_review",
    description: "Files that should be reviewed by the evaluator",
    example: '["src/hello.ts", ".flywheel/verify/sprint-hello-world.ts"]',
  },
  {
    key: "needs_plan",
    description: "Set to true if the task is too complex for sprint and requires full planning (only when worker_can_escalate is enabled)",
    example: "false",
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
  const allFields = hasSum ? fields : [WORK_STEP_FIELDS[0], ...fields];

  const fieldLines = allFields.map((f) => {
    const req = f.required || f.key === "summary" ? " (REQUIRED)" : " (optional)";
    return `- **${f.key}**${req}: ${f.description}\n  Example: ${f.example}`;
  });

  const exampleKeys = allFields.map((f) => `  "${f.key}": ${f.example}`).join(",\n");

  return `## Handoff Instructions

**CRITICAL:** Before you finish, you MUST write a valid JSON handoff file. This is how the queue tracks your work. If you skip this step or produce invalid JSON, the queue will retry the entire step.

Write a JSON file to:
\`${handoffPath}\`

### Required format

The file must contain a single JSON object (not wrapped in markdown code fences). Use this exact structure:

\`\`\`json
{
${exampleKeys}
}
\`\`\`

### Field reference

${fieldLines.join("\n\n")}

### Rules

1. The \`summary\` field is REQUIRED (100-5000 characters, single paragraph, no newlines).
2. All other fields are optional but strongly encouraged — they improve downstream quality assessment.
3. Do NOT include fields not listed above — unknown fields cause a validation error and the step will be retried.
4. Write the file using your file-writing tool (e.g., \`write_file\`, \`create\`, or equivalent). Do NOT just print the JSON to stdout.
5. The file must be valid JSON — no trailing commas, no comments, no markdown wrapping.`;
}

// ---------------------------------------------------------------------------
// renderEvaluatorHandoffInstruction
// ---------------------------------------------------------------------------

export function renderEvaluatorHandoffInstruction(handoffPath: string): string {
  return `## Evaluator Handoff Instructions

**CRITICAL:** You MUST write a valid JSON file before finishing. This is how the queue reads your verdict. If missing or invalid, the evaluation will be retried.

Write a JSON file to:
\`${handoffPath}\`

### Required format

\`\`\`json
{
  "passed": true,
  "reasoning": "All acceptance criteria met, tests pass, code is clean.",
  "suggestions": [],
  "confidence": 0.92,
  "feedback": "",
  "files_to_review": [],
  "issues": []
}
\`\`\`

### Field reference

- **passed** (REQUIRED): Whether the step output meets acceptance criteria. Boolean.
- **reasoning** (REQUIRED): Explanation of the evaluation decision. String.
- **suggestions** (REQUIRED): List of improvement suggestions. Empty array \`[]\` if none.
- **confidence** (REQUIRED): Confidence in the verdict, 0.0 to 1.0. Number.
- **feedback** (REQUIRED): Actionable feedback for the worker if retrying. String (empty string if passed).
- **files_to_review** (REQUIRED): Files that should be reviewed. Empty array \`[]\` if none.
- **issues** (REQUIRED): Structured issues found. Empty array \`[]\` if none. Each issue:
  \`{"description": "...", "severity": "blocking"|"non_blocking", "category": "test_failure"|"type_error"|"security"|"regression"|"incomplete"|"other"}\`

### Rules

1. ALL fields are required — do not omit any field.
2. Use empty arrays \`[]\` and empty strings \`""\` for fields with no data — do not use \`null\`.
3. Do NOT include fields not listed above — unknown fields cause a validation error.
4. Write valid JSON — no trailing commas, no comments, no markdown wrapping.
5. Write the file using your file-writing tool, not stdout.`;
}

// ---------------------------------------------------------------------------
// renderDispatcherHandoffInstruction
// ---------------------------------------------------------------------------

export function renderDispatcherHandoffInstruction(handoffPath: string): string {
  return `## Dispatcher Handoff Instructions

**CRITICAL:** You MUST write a valid JSON file before finishing. This is how the queue reads your dispatch decision. If missing or invalid, the dispatch will be retried.

Write a JSON file to:
\`${handoffPath}\`

### Required format

\`\`\`json
{
  "schema_version": 1,
  "step_index": 0,
  "task_content": "Implement feature X according to the plan.",
  "context_files": ["src/foo.ts", "tests/foo.test.ts"],
  "evaluation_criteria": {
    "acceptance_criteria": ["Tests pass", "No lint errors"],
    "required_tests": true,
    "custom_checks": [],
    "required_outputs": []
  }
}
\`\`\`

### Field reference

- **schema_version** (REQUIRED): Must be \`1\`. Literal number.
- **step_index** (REQUIRED): Zero-based index of the step being dispatched.
- **task_content** (REQUIRED): The task prompt to send to the worker.
- **context_files** (REQUIRED): File paths the worker should reference. Array of strings.
- **context_to_inline** (optional): Paths from available_context to inject into the worker prompt. Order by importance; 8 KB cap.
- **evaluation_criteria** (optional): Structured criteria for evaluating the worker's output. Object with: \`acceptance_criteria\` (string[]), \`required_tests\` (boolean), \`custom_checks\` (string[]), \`required_outputs\` (string[]).
- **session_name** (optional): Name for the worker session (2-5 words).
- **reasoning** (optional): Why this dispatch decision was made.
- **worker_config** (optional): Override worker configuration.

### Rules

1. ALL required fields must be present.
2. Do NOT include fields not listed above — unknown fields cause a validation error.
3. Write valid JSON — no trailing commas, no comments, no markdown wrapping.
4. Write the file using your file-writing tool, not stdout.`;
}
