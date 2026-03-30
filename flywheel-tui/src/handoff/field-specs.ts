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
    description: "Files created, modified, and commands run. IMPORTANT: commands_run entries will be RE-EXECUTED by a verification agent — only list commands you actually ran, with accurate exit codes. Fabricated or inaccurate entries cause the step to fail verification and retry",
    example: '{"files_created": ["src/auth.ts"], "files_modified": ["src/app.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "12/12 tests pass"}]}',
  },
  {
    key: "verification",
    description: "Whether tests passed and a brief summary of test output. Must reflect actual results — a verification agent will re-run reported commands to confirm",
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
    example: '"plan.json"',
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
    example: '"plan.json"',
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
    example: '"plan.json"',
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
    example: '"review.md"',
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
// Debug sub-step fields
// ---------------------------------------------------------------------------

export const DEBUG_INVESTIGATE_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of investigation findings, root cause hypothesis, and evidence gathered", example: '"Investigated the failing test and identified a race condition in the event handler..."', required: true },
  { key: "hypothesis", description: "Root cause hypothesis based on investigation", example: '"The race condition occurs because the event listener is registered after the initial emit"' },
  { key: "artifacts", description: "Files examined and commands run during investigation", example: '{"files_modified": [], "commands_run": [{"command": "bun test tests/event.test.ts", "exitCode": 1, "observation": "Timeout on line 42"}]}' },
  { key: "decisions", description: "Key decisions about the investigation approach", example: '["Focused on event handler timing based on stack trace"]' },
];

export const DEBUG_FIX_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of the fix applied and rationale", example: '"Applied minimum-change fix to register the event listener before the initial emit..."', required: true },
  { key: "artifacts", description: "Files modified and commands run to apply the fix. IMPORTANT: commands_run entries will be RE-EXECUTED by verification", example: '{"files_modified": ["src/events/handler.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "All tests pass"}]}' },
  { key: "verification", description: "Whether tests passed after the fix", example: '{"tests_passed": true, "test_output_summary": "42/42 tests pass"}' },
  { key: "files_to_review", description: "Files changed by the fix", example: '["src/events/handler.ts"]' },
];

export const DEBUG_VERIFY_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of verification results", example: '"Verification confirmed the fix resolves the original issue. All tests pass..."', required: true },
  { key: "verification", description: "Verification command output and result", example: '{"tests_passed": true, "test_output_summary": "42/42 tests pass, no regressions"}' },
  { key: "artifacts", description: "Commands run during verification", example: '{"commands_run": [{"command": "bun test", "exitCode": 0, "observation": "42/42 pass"}]}' },
];

// ---------------------------------------------------------------------------
// Research fields (single rich step)
// ---------------------------------------------------------------------------

export const RESEARCH_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of research findings covering locate, analyze, and persist phases", example: '"Researched authentication patterns in the codebase. Located 12 relevant files across 3 modules..."', required: true },
  { key: "document_path", description: "Path to the persisted research document", example: '"docs/research/2026-03-29-auth-patterns.md"' },
  { key: "artifacts", description: "Files created during research (research doc, context files)", example: '{"files_created": ["docs/research/2026-03-29-auth-patterns.md"]}' },
  { key: "decisions", description: "Key decisions about research scope and findings", example: '["Focused on middleware-based auth patterns as dominant pattern"]' },
  { key: "files_to_review", description: "Key files discovered during research", example: '["src/middleware/auth.ts", "src/services/jwt.ts"]' },
];

// ---------------------------------------------------------------------------
// Ship sub-step fields (split ship and learnings)
// ---------------------------------------------------------------------------

export const SHIP_COMMIT_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of staged changes, commit, and PR", example: '"Staged 12 files, committed with message feat: add auth middleware, opened PR #42..."', required: true },
  { key: "artifacts", description: "Files staged, branch name, commit hash, PR URL", example: '{"files_modified": ["src/auth.ts"], "commands_run": [{"command": "git push -u origin feat/auth", "exitCode": 0, "observation": "PR opened"}]}' },
  { key: "decisions", description: "Decisions about commit scope and PR description", example: '["Split into single commit for clean history"]' },
];

export const SHIP_LEARNINGS_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of learnings extracted", example: '"Extracted 2 compound solution documents covering the auth middleware pattern..."', required: true },
  { key: "compound_docs", description: "Learnings extracted and saved as compound solution documents", example: '[{"title": "Auth middleware pattern", "type": "pattern", "tags": ["auth"], "problem": "Need reusable auth", "solution": "Middleware chain"}]' },
  { key: "artifacts", description: "Compound doc files created", example: '{"files_created": ["docs/solutions/auth-middleware-pattern.md"]}' },
];

// ---------------------------------------------------------------------------
// Review sub-step fields (split dispatch and consolidate)
// ---------------------------------------------------------------------------

export const REVIEW_DISPATCH_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of review dispatch and per-reviewer findings", example: '"Dispatched 5 review agents. Found 1 P1, 3 P2, 7 P3 findings across 12 files..."', required: true },
  { key: "finding_counts", description: "Count of findings by severity", example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 7}' },
  { key: "p3_findings", description: "Low-priority suggestions for optional triage", example: '[{"description": "Consider caching", "location": "src/api.ts:10", "suggestion": "Add LRU cache"}]' },
  { key: "files_to_review", description: "Files that were reviewed", example: '["src/auth.ts", "src/middleware.ts"]' },
];

export const REVIEW_CONSOLIDATE_FIELDS: HandoffFieldSpec[] = [
  { key: "summary", description: "100-5000 char summary of consolidated review with incorporated findings", example: '"Consolidated review: 1 P1 fixed, 3 P2 addressed. Review doc written to docs/reviews/..."', required: true },
  { key: "review_file_path", description: "Path to the full review document", example: '"docs/reviews/2026-03-29-auth-review.md"' },
  { key: "finding_counts", description: "Final finding counts after triage", example: '{"p1_critical": 1, "p2_important": 3, "p3_suggestion": 5}' },
  { key: "files_to_review", description: "Files that need attention based on review", example: '["src/auth.ts"]' },
];

// ---------------------------------------------------------------------------
// Sprint fields
// ---------------------------------------------------------------------------

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
    description: "Files created, modified, and commands run during this sprint iteration. IMPORTANT: commands_run entries will be RE-EXECUTED by a verification agent — only list commands you actually ran, with accurate exit codes",
    example: '{"files_created": ["src/hello.ts", ".flywheel/verify/sprint-hello-world.ts"], "files_modified": ["src/app.ts"], "commands_run": [{"command": "bun test", "exitCode": 0, "observation": "5/5 tests pass"}]}',
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
5. The file must be valid JSON — no trailing commas, no comments, no markdown wrapping.
6. **Accuracy is critical.** A verification agent will re-execute commands from \`artifacts.commands_run\` and check that files in \`artifacts.files_created\`/\`files_modified\` exist on disk. If any reported command returns a different exit code than you claimed, or a reported file does not exist, the step fails verification and you will be asked to retry. Only report commands you actually ran and files that actually exist.`;
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
