/**
 * Bash tool — shell command execution for the Agent Harness.
 *
 * Writes stdout/stderr to a temp file instead of piping to avoid the
 * blocked-pipe problem: when a command spawns children (servers, sleep),
 * pipe reads block forever even after killing the parent. File-based
 * output + process group kill guarantees clean timeout behavior.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { createEnvFilter } from "../../worker/env-filter.js";
import type { HarnessTool, ToolContext, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 3600;
const HEAD_LINES = 200;
const TAIL_LINES = 100;
const MAX_LINE_LENGTH = 500;

// Pre-compiled env filter — excludes API keys / secrets
const envFilter = createEnvFilter({ envPassthrough: [] });

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bashInputSchema = z.object({
  command: z.string().describe("The shell command to execute."),
  timeout: z
    .number()
    .optional()
    .default(DEFAULT_TIMEOUT_SEC)
    .describe(`Timeout in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC}).`),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the command. Defaults to the session cwd."),
});

type BashInput = z.infer<typeof bashInputSchema>;

// ---------------------------------------------------------------------------
// Head+tail truncation
// ---------------------------------------------------------------------------

/**
 * Truncate output to first HEAD_LINES + last TAIL_LINES lines with a
 * marker in between. Also clamps individual line length.
 */
export function applyHeadTail(
  text: string,
  headLines: number = HEAD_LINES,
  tailLines: number = TAIL_LINES,
  maxLineLen: number = MAX_LINE_LENGTH,
): string {
  let lines = text.split("\n");

  // Clamp individual line lengths
  lines = lines.map((line) =>
    line.length > maxLineLen ? `${line.slice(0, maxLineLen)}... (truncated)` : line,
  );

  const total = lines.length;
  if (total <= headLines + tailLines) {
    return lines.join("\n");
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const skipped = total - headLines - tailLines;
  return [...head, `\n[...truncated ${skipped} lines...]\n`, ...tail].join("\n");
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

function readOutputFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.trim() ? content : "(no output)";
  } catch {
    return "(no output)";
  }
}

const BASH_DESCRIPTION = `Execute a shell command with optional timeout (in seconds).

CRITICAL: Each command runs in a NEW, ISOLATED shell process. Nothing persists between calls:
- Environment variables are reset
- Working directory changes are lost

Before executing commands:

1. Directory Verification:
   - If creating new directories or files, first verify the parent directory exists.

2. Path Quoting:
   Always quote file paths that contain spaces or special characters with double quotes.

3. Working Directory Management:
   Prefer using absolute paths over changing directories.

Tool Usage Guidelines:
- Prefer the Read tool over cat, head, tail, sed, or awk for viewing files
- Prefer the Grep tool over grep or find for searching
- Prefer the Create/Edit tools for file modifications
- Avoid wrapping commands with 'bash -lc', 'zsh -lc', or 'sh -c'

Forbidden operations (use dedicated tools instead):
- grep, cat, head, tail, sed, awk, echo, find, env, printenv, set

Output Limits:
- Output is truncated: first ${HEAD_LINES} lines + last ${TAIL_LINES} lines are kept.
- Individual lines are clamped to ${MAX_LINE_LENGTH} characters.

Security:
- NEVER run destructive commands like 'rm -rf /' or 'rm -rf ~'
- Be cautious with commands that modify system files

Timeout:
- Default: ${DEFAULT_TIMEOUT_SEC} seconds (max: ${MAX_TIMEOUT_SEC})
- Commands exceeding timeout will be terminated`;

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function createBashTool(): HarnessTool {
  return {
    name: "bash",
    description: BASH_DESCRIPTION,
    inputSchema: bashInputSchema,
    concurrency: "exclusive",

    async execute(rawInput: unknown, context: ToolContext): Promise<ToolResult> {
      const parsed = bashInputSchema.parse(rawInput);
      const { command } = parsed;
      const timeoutSec = Math.max(1, Math.min(parsed.timeout ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC));
      const timeoutMs = timeoutSec * 1000;
      const cwd = parsed.cwd ?? context.cwd;
      const filteredEnv = envFilter.filter(context.env);

      // Write stdout+stderr to a temp file instead of piping.
      // This avoids the blocked-pipe problem: when bash spawns children
      // that inherit the pipe, reads block forever even after killing bash.
      // With file output, we can kill the process group and read whatever
      // was written up to that point.
      const tmpFile = path.join(os.tmpdir(), `harness-bash-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
      const fd = fs.openSync(tmpFile, "w");

      try {
        // detached: true makes bash a process group leader so we can
        // kill the entire tree with process.kill(-pid, SIGKILL)
        const child = spawn("bash", ["-c", command], {
          cwd,
          env: filteredEnv,
          stdio: ["pipe", fd, fd],
          detached: true,
        });

        const pid = child.pid;

        const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
          child.on("exit", (code, signal) => resolve({ code, signal }));
          child.on("error", reject);
        });

        const timeoutPromise = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const raceResult = await Promise.race([
          exitPromise.then((r) => ({ kind: "done" as const, ...r })),
          timeoutPromise.then(() => ({ kind: "timeout" as const })),
        ]);

        if (raceResult.kind === "timeout") {
          // SIGKILL the entire process group (bash + all children)
          if (pid !== undefined) {
            try { process.kill(-pid, "SIGKILL"); } catch {
              try { child.kill("SIGKILL"); } catch {}
            }
          }

          // Read whatever output was written before we killed it
          fs.closeSync(fd);
          let output = readOutputFile(tmpFile);
          output = applyHeadTail(output);
          return {
            content: `${output}\n\nCommand timed out after ${timeoutSec} seconds`,
            isError: true,
          };
        }

        // Normal completion — close fd so all writes flush, then read
        fs.closeSync(fd);
        const exitCode = raceResult.code ?? (raceResult.signal ? 128 : 0);
        let output = readOutputFile(tmpFile);
        output = applyHeadTail(output);

        if (exitCode !== 0) {
          return {
            content: `${output}\n\nExit code: ${exitCode}`,
            isError: true,
          };
        }

        return { content: output };
      } catch (err) {
        try { fs.closeSync(fd); } catch {}
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to execute command: ${msg}`, isError: true };
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    },
  };
}
