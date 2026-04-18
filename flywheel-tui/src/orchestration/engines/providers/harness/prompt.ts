/**
 * Harness system prompt assembly.
 *
 * Prepends execution-environment instructions to the orchestration-provided
 * system prompt. The orchestration prompt has task-specific content; this
 * layer adds shell, verification, and tool-usage instructions.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./llm/types.js";

const SHELL_INSTRUCTIONS = `EXECUTION ENVIRONMENT:
- Commands run as non-persistent sessions: each bash call starts a fresh process. Environment variables, working directory, and shell state do NOT carry over between calls.
- To preserve state within a single call, chain with && or ;, e.g. \`cd /app && export FOO=bar && make\`.
- For long-running tasks (servers, watchers), end the command with & -- it keeps running after the call returns.
- Always verify changes by running tests after modifications.`;

const VERIFICATION_WARNING = `VERIFICATION:
Your solution will be evaluated against hidden tests. Verify your solution handles edge cases. Double- and triple-check beyond visible tests.`;

const TODO_LIST_USAGE = `TODO LIST:
CRITICAL: Call todo_list(write) twice per task — once to mark in_progress before starting, once to mark completed when done. Keep exactly one task in_progress at all times during multi-step work.
- Create a todo list when the task requires 3+ distinct steps, or when you receive new instructions mid-task.
- Mark tasks as abandoned when blocked or no longer relevant — do not leave stale in_progress items.
- After any context recovery, immediately call todo_list(read) to restore your task state.`;

const GENERALIZATION_RULE = `GENERALIZATION:
Your solution must remain correct for any numeric values, array dimensions, or file contents change.`;

const READ_USAGE = `READ TOOL:
- Use \`read\` instead of \`cat\`, \`head\`, or \`tail\` for file reading. Lines are displayed in hashline format (LINE#HASH:content) for line-addressable editing.
- Use offset and limit parameters for large files instead of piping through head/tail.
- The read tool also handles image files (PNG, JPG, GIF, WebP) — returns base64-encoded content.`;

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

const BASH_ANTI_PATTERNS = `BASH ANTI-PATTERNS:
- Use the \`read\` tool instead of \`cat\`, \`head\`, or \`tail\` for reading file contents. Use \`read\` for image files. Only use bash for commands that execute programs, run tests, or modify system state.
- Do not use \`2>&1\` — stderr is already captured.
- Do not use \`2>/dev/null\` — error output is useful for debugging.
- Do not pipe through \`| head\` or \`| tail\` — use the \`read\` tool with offset and limit parameters instead.`;

function detectShell(): string {
  return process.env.SHELL ?? "unknown";
}

function detectOsVersion(): string {
  try {
    return execSync("uname -sr", { encoding: "utf-8", timeout: 2000 }).trim();
  } catch {
    return `${process.platform} ${process.arch}`;
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    return existsSync(join(cwd, ".git"));
  } catch {
    return false;
  }
}

function buildEnvBlock(cwd: string): string {
  const lines = [
    `Working directory: ${cwd}`,
    `Is directory a git repo: ${isGitRepo(cwd) ? "Yes" : "No"}`,
    `Platform: ${process.platform}`,
    `Shell: ${detectShell()}`,
    `OS Version: ${detectOsVersion()}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export interface HarnessPromptOptions {
  orchestrationSystemPrompt: string;
  provider: Provider;
  projectInstructions?: string;
  /** Resolved harness tool names (e.g. "bash", "write_handoff", "todo_list"). */
  availableTools: ReadonlySet<string>;
  cwd?: string;
}

export function buildHarnessSystemPrompt(opts: HarnessPromptOptions): string {
  const { orchestrationSystemPrompt, provider, projectInstructions, availableTools, cwd } = opts;
  const has = (tool: string): boolean => availableTools.has(tool);

  const toolSections: string[] = [];

  if (cwd) {
    toolSections.push(buildEnvBlock(cwd));
  }

  if (has("bash")) {
    toolSections.push(SHELL_INSTRUCTIONS);
    toolSections.push(provider === "openai" ? OPENAI_EDITING : ANTHROPIC_EDITING);
    toolSections.push(VERIFICATION_WARNING);
    toolSections.push(GENERALIZATION_RULE);
  }

  if (has("bash") && has("read")) toolSections.push(BASH_ANTI_PATTERNS);
  if (has("read")) toolSections.push(READ_USAGE);
  if (has("todo_list")) toolSections.push(TODO_LIST_USAGE);
  if (has("write_handoff")) toolSections.push(HANDOFF_WARNING);

  // Orchestration prompt first (primacy), tool instructions second, project context last (recency).
  const parts = [orchestrationSystemPrompt];
  if (toolSections.length > 0) parts.push(toolSections.join("\n\n"));
  if (has("bash") && projectInstructions) parts.push(projectInstructions);

  return parts.join("\n\n---\n\n");
}
