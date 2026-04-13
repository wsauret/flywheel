import type { SubprocessHandoff } from "../../../infra/handoff-schemas.js";

export interface HandoffFieldSpec {
  key: keyof SubprocessHandoff;
  description: string;
  example: string;
  required?: boolean;
}

// Shared preamble + rules used by all handoff instruction renderers

function renderHandoffPreamble(role: string, handoffPath: string): string {
  return `## ${role} Handoff Instructions

**CRITICAL:** You MUST write a valid JSON file before finishing. This is how the queue reads your ${role.toLowerCase() === "handoff" ? "work" : role.toLowerCase() + " decision"}. If missing or invalid, the ${role.toLowerCase()} will be retried.

Write a JSON file to:
\`${handoffPath}\``;
}

const SHARED_JSON_RULES = [
  "Write valid JSON — no trailing commas, no comments, no markdown wrapping.",
  "Write the file using your file-writing tool, not stdout.",
];

export function renderHandoffInstruction(
  fields: HandoffFieldSpec[],
  handoffPath: string,
): string {
  const SUMMARY_FIELD: HandoffFieldSpec = {
    key: "summary",
    description: "100-5000 char summary of what was done, decisions made, and current state",
    example: '"Completed the task..."',
    required: true,
  };

  const hasSum = fields.some((f) => f.key === "summary");
  const allFields = hasSum ? fields : [SUMMARY_FIELD, ...fields];

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
4. If this step also requires writing other artifacts (for example \`context.md\`, \`plan.json\`, or edits to \`plan.json\`), complete those artifact writes first and write the handoff file last.
5. If you want to present the user with a summary or final message, print it BEFORE writing the handoff file. Any output after the handoff write may not be seen.
6. Treat the handoff file as your final completion signal: once the handoff is written, the queue may auto-complete the step immediately.
7. Write the file using your file-writing tool (e.g., \`write_file\`, \`create\`, or equivalent). Do NOT just print the JSON to stdout.
8. The file must be valid JSON — no trailing commas, no comments, no markdown wrapping.
9. **Accuracy is critical.** A verification agent will re-execute commands from \`artifacts.commands_run\` and check that files in \`artifacts.files_created\`/\`files_modified\` exist on disk. If any reported command returns a different exit code than you claimed, or a reported file does not exist, the step fails verification and you will be asked to retry. Only report commands you actually ran and files that actually exist.`;
}

export function renderEvaluatorHandoffInstruction(handoffPath: string): string {
  return `${renderHandoffPreamble("Evaluator", handoffPath)}

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
4. ${SHARED_JSON_RULES[0]}
5. ${SHARED_JSON_RULES[1]}`;
}

export function renderDispatcherHandoffInstruction(handoffPath: string): string {
  return `${renderHandoffPreamble("Dispatcher", handoffPath)}

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
- **reasoning** (optional): Why this dispatch decision was made.
- **worker_config** (optional): Tool restrictions. Object with: \`tool_scoping\` (\`{ read, bash, write, edit }\`).

### Rules

1. ALL required fields must be present.
2. Do NOT include fields not listed above — unknown fields cause a validation error.
3. ${SHARED_JSON_RULES[0]}
4. ${SHARED_JSON_RULES[1]}`;
}
