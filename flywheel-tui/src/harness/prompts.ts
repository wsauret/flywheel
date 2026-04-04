/**
 * Workspace-aware system prompt for the agent harness.
 *
 * Gathers runtime environment context and builds the system prompt
 * that instructs the model on available tools, error handling,
 * and completion protocol.
 */

import * as os from "node:os";
import * as path from "node:path";

export interface WorkspaceContext {
  os: string;
  cwd: string;
  shell: string;
  homeDir: string;
  gitBranch?: string;
  gitStatus?: string;
  directoryListing?: string;
  customInstructions?: string;
}

/** Gather workspace context from the current environment. */
export async function gatherWorkspaceContext(): Promise<WorkspaceContext> {
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const shell = process.env.SHELL ?? "unknown";
  const osName = `${os.platform()} ${os.arch()} ${os.release()}`;

  let gitBranch: string | undefined;
  let gitStatus: string | undefined;
  let directoryListing: string | undefined;

  try {
    const branchResult = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (branchResult.exitCode === 0) {
      gitBranch = branchResult.stdout.toString().trim();
    }
  } catch {
    // Not a git repo or git not available
  }

  try {
    const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (statusResult.exitCode === 0) {
      const output = statusResult.stdout.toString().trim();
      if (!output) {
        gitStatus = "clean";
      } else {
        const lines = output.split("\n");
        const MAX_STATUS_LINES = 20;
        if (lines.length > MAX_STATUS_LINES) {
          gitStatus = lines.slice(0, MAX_STATUS_LINES).join("\n") + `\n... (${lines.length - MAX_STATUS_LINES} more files)`;
        } else {
          gitStatus = output;
        }
      }
    }
  } catch {
    // Not a git repo
  }

  try {
    const lsResult = Bun.spawnSync(["ls", "-la"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (lsResult.exitCode === 0) {
      directoryListing = lsResult.stdout.toString().trim();
    }
  } catch {
    // ls not available
  }

  return { os: osName, cwd, shell, homeDir, gitBranch, gitStatus, directoryListing };
}

/** Build the system prompt from workspace context. */
export function buildSystemPrompt(context: WorkspaceContext): string {
  const sections: string[] = [];

  sections.push(`You are an autonomous coding agent. Complete the assigned task fully and verify your work.`);

  sections.push(`
# Environment
- OS: ${context.os}
- Shell: ${context.shell}
- Working directory: ${context.cwd}
- Home: ${context.homeDir}${context.gitBranch ? `\n- Git branch: ${context.gitBranch}` : ""}${context.gitStatus ? `\n- Git status: ${context.gitStatus}` : ""}`);

  if (context.directoryListing) {
    sections.push(`
# Directory Listing
${context.directoryListing}`);
  }

  sections.push(`
# Rules
- Always READ the README before acting in the codebase.

# Tools
You have access to tools for file I/O, shell execution, and code search.
- Use file tools to read, write, and edit files
- Use shell execution for running commands (tests, builds, git)
- Use search tools (grep, glob) to find code and files
- Tools may run concurrently when possible

# Error Handling
- If a tool call fails, read the error message carefully and try a different approach
- Do not repeat the same failing command without changing something
- If stuck, step back and reconsider the approach

# Task Completion
When your task is complete, call the task_complete tool with a handoff JSON object containing:
- summary: A concise paragraph describing what was accomplished (required)
- artifacts: Files created/modified and commands run (optional)
- verification: Whether tests pass and a summary of test output (optional)

The task_complete tool uses a double-confirm protocol:
1. First call: your handoff is validated and you receive a verification checklist
2. Second call: confirms completion after you review the checklist

Do NOT call task_complete until you have verified your changes work correctly.

# Security
- Never output API keys, secrets, or credentials in tool calls or responses
- Never commit sensitive data to version control
- Sanitize file paths to prevent directory traversal`);

  if (context.customInstructions) {
    sections.push(`
# Custom Instructions
${context.customInstructions}`);
  }

  return sections.join("\n");
}
