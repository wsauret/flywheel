/**
 * Harness system prompt assembly.
 *
 * Prepends execution-environment instructions to the orchestration-provided
 * system prompt. The orchestration prompt has task-specific content; this
 * layer adds shell, verification, and tool-usage instructions.
 */

import type { Provider } from "./llm/types.js";

const SHELL_INSTRUCTIONS = `EXECUTION ENVIRONMENT:
- Commands run as non-persistent sessions: each bash call starts a fresh process. Environment variables, working directory, and shell state do NOT carry over between calls.
- To preserve state within a single call, chain with && or ;, e.g. \`cd /app && export FOO=bar && make\`.
- For long-running tasks (servers, watchers), end the command with & -- it keeps running after the call returns.
- Always verify changes by running tests after modifications.`;

const VERIFICATION_WARNING = `VERIFICATION:
Your solution will be evaluated against hidden tests. Verify your solution handles edge cases. Double- and triple-check beyond visible tests.`;

const TODO_LIST_USAGE = `TODO LIST:
For tasks requiring 3+ steps, create a todo list immediately. Mark items in_progress before starting, completed when done. Call todo_list(read) after any context recovery to restore your task state.`;

const GENERALIZATION_RULE = `GENERALIZATION:
Your solution must remain correct for any numeric values, array dimensions, or file contents change.`;

const HANDOFF_WARNING = `HANDOFF:
TREAT write_handoff AS IRREVERSIBLE AND FINAL. Before calling write_handoff, verify ALL requirements are met. You have unlimited turns but only one submission.`;

const ANTHROPIC_EDITING = `FILE EDITING:
- For full-file writes use \`cat > path/to/file <<'EOF' ... EOF\`. Quote the delimiter to avoid variable interpolation.
- For small targeted substitutions use \`sed -i 's/old/new/g' path/to/file\`.
- Always verify the result with \`cat path/to/file\` or \`diff\` before moving on.`;

const OPENAI_EDITING = `FILE EDITING with apply_patch (preferred):
Use the apply_patch shell helper for precise file edits. Prefer it over heredocs or sed for multi-line changes. Invoke via a heredoc:

  apply_patch <<'PATCH'
  *** Begin Patch
  *** Update File: path/to/file.py
  @@ def existing_function():
  -    old_line
  +    new_line
  *** End Patch
  PATCH

If apply_patch fails, inspect the file first with \`cat -n\` and retry with accurate context.`;

export function buildHarnessSystemPrompt(
  orchestrationSystemPrompt: string,
  provider: Provider,
  projectInstructions?: string,
): string {
  const editing = provider === "openai" ? OPENAI_EDITING : ANTHROPIC_EDITING;

  const harnessInstructions = [
    SHELL_INSTRUCTIONS,
    editing,
    VERIFICATION_WARNING,
    TODO_LIST_USAGE,
    GENERALIZATION_RULE,
    HANDOFF_WARNING,
  ].join("\n\n");

  const parts = [harnessInstructions, orchestrationSystemPrompt];
  if (projectInstructions) parts.push(projectInstructions);

  return parts.join("\n\n---\n\n");
}
