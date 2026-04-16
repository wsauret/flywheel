import type { WorkerHandoff } from "../../../infra/handoff-schemas.js";

export interface HandoffFieldSpec {
  key: keyof WorkerHandoff;
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

const JSON_VALIDITY_RULE = "Write valid JSON — no trailing commas, no comments, no markdown wrapping.";
const JSON_WRITE_TOOL_RULE = "Write the file using your file-writing tool, not stdout.";

function renderHandoffInstruction(
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
  "feedback": ""
}
\`\`\`

### Field reference

- **passed** (REQUIRED): Whether the step output meets acceptance criteria. Boolean.
- **reasoning** (REQUIRED): Explanation of the evaluation decision. String.
- **suggestions** (REQUIRED): List of improvement suggestions. Empty array \`[]\` if none.
- **feedback** (REQUIRED): Actionable feedback for the worker if retrying. String (empty if passed).

### Rules

1. ALL fields are required — do not omit any field.
2. Use empty arrays \`[]\` and empty strings \`""\` for fields with no data — do not use \`null\`.
3. ${JSON_VALIDITY_RULE}
4. ${JSON_WRITE_TOOL_RULE}`;
}

/** Shared work/sprint step postamble — handoff instructions with output requirements header. */
export function renderWorkPostamble(fields: HandoffFieldSpec[], handoffPath: string): string {
  return `---
## Output Requirements

${renderHandoffInstruction(fields, handoffPath)}`
}

// Explicit schema reminder — the dispatcher system prompt covers the full schema,
// but the LLM may output JSON as text and write a summary to the handoff file.
// Repeating the required fields here prevents that failure mode.
export function renderDispatcherHandoffInstruction(handoffPath: string): string {
  return `${renderHandoffPreamble("Dispatcher", handoffPath)}

### Required fields

The handoff file must contain your **dispatcher decision** — the same JSON schema from your system prompt:

\`\`\`json
{
  "schema_version": 1,
  "step_index": <number>,
  "task_content": "<string>",
  "context_files": ["<string>"],
  "evaluation_criteria": { ... }
}
\`\`\`

Do NOT write a summary, key_changes, or confidence object — write the dispatcher decision directly. ${JSON_WRITE_TOOL_RULE}`;
}
