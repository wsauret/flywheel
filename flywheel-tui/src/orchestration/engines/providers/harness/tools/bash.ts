/**
 * Fresh-per-command bash execution.
 *
 * Every call spawns a new bash subprocess. No persistent shell state.
 * Commands are written to a temp script to eliminate quoting bugs.
 * Timeout kills the subprocess with SIGTERM, then SIGKILL after grace period.
 */

import { randomUUID } from "node:crypto";
import { Log } from "../../../../../infra/log.js";
import { killProcessGroup } from "../../../../../infra/process-lifecycle.js";
import type { ToolDefinition, ToolResult, ToolContext, BashOperations } from "./types.js";

const log = Log.create({ service: "harness-bash" });

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 300;
const KILL_GRACE_MS = 5_000;

const INTERACTIVE_COMMAND_PATTERNS: ReadonlyArray<{ match: RegExp; guidance: string }> = [
  { match: /\b(vim|vi|nvim|nano|emacs|pico|ed)\b/, guidance: "editors can't run interactively -- use `cat > file <<EOF ... EOF` or `sed` for edits" },
  { match: /\b(less|more|most)\b/, guidance: "use `cat`, `head`, or `tail` instead of a pager" },
  { match: /\b(top|htop|btop|atop)\b/, guidance: "use `ps aux` or `ps -eo ...` for a one-shot process snapshot" },
  { match: /\bman\s+\S+/, guidance: "use `--help` on the command or read the manpage source if needed" },
  { match: /^\s*(python3?|ipython|node|ruby|irb|php|lua)(\s+-i)?\s*$/, guidance: "pass `-c 'code'` (or `-e`) to run inline, or write a script file and execute it" },
  { match: /\b(telnet|ftp|nc\s+-l)\b/, guidance: "use non-interactive alternatives: `curl`, `wget`, `ncat --exec`" },
];

function checkInteractiveCommand(command: string): string | null {
  for (const { match, guidance } of INTERACTIVE_COMMAND_PATTERNS) {
    const hit = command.match(match);
    if (hit) return `Interactive command detected (\`${hit[0]}\`) which would hang waiting for a TTY. ${guidance}.`;
  }
  return null;
}

function isBackgroundCommand(command: string): boolean {
  return /&\s*$/.test(command.trim());
}

function buildScript(command: string): string {
  return [
    "set -m",
    "exec 2>&1",
    `{ ${command}; } &`,
    "CHILD=$!",
    "trap 'kill -- -$CHILD 2>/dev/null' TERM INT",
    "wait $CHILD 2>/dev/null",
    "exit $?",
  ].join("\n");
}

const defaultBashOperations: BashOperations = {
  spawn: (cmd, opts) => Bun.spawn(cmd, opts),
  writeScript: (path, content) => Bun.write(path, content),
  deleteScript: (path) => Bun.file(path).delete(),
};

export function createBashDefinition(options?: { operations?: BashOperations }): ToolDefinition {
  const ops = options?.operations ?? defaultBashOperations;

  async function runForeground(command: string, context: ToolContext, timeoutSec: number): Promise<ToolResult> {
    const scriptId = randomUUID().slice(0, 8);
    const scriptPath = `/tmp/flywheel-harness-${scriptId}.sh`;

    try {
      await ops.writeScript(scriptPath, buildScript(command));

      const proc = ops.spawn(["bash", scriptPath], {
        cwd: context.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        log.warn("command timed out, sending SIGTERM", { timeoutSec });
        killProcessGroup(proc, "SIGTERM");
        setTimeout(() => {
          killProcessGroup(proc, "SIGKILL");
        }, KILL_GRACE_MS);
      }, timeoutSec * 1000);

      try {
        await proc.exited;
        const output = await new Response(proc.stdout).text();
        const exitCode = timedOut ? 124 : (proc.exitCode ?? 1);

        const parts: string[] = [];
        if (timedOut) parts.push(`[Command timed out after ${timeoutSec}s; killed]`);
        if (output.trim()) parts.push(output.trim());
        else if (!timedOut) parts.push("(no output)");
        parts.push(`[exit code: ${exitCode}]`);

        return {
          content: parts.join("\n"),
          isError: exitCode !== 0,
        };
      } finally {
        clearTimeout(killTimer);
      }
    } finally {
      try {
        await ops.deleteScript(scriptPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  async function runBackground(command: string, context: ToolContext): Promise<ToolResult> {
    const scriptId = randomUUID().slice(0, 8);
    const logPath = `/tmp/flywheel-harness-bg-${scriptId}.log`;

    const stripped = command.trim().replace(/&\s*$/, "");
    const wrapper = `nohup bash -c ${JSON.stringify(stripped)} > ${logPath} 2>&1 & echo $!`;

    const proc = ops.spawn(["bash", "-c", wrapper], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const pid = parseInt((await new Response(proc.stdout).text()).trim(), 10) || 0;

    return {
      content: `Started in background. PID: ${pid}. Log: ${logPath}.\nCheck progress: cat ${logPath}\nStop: kill ${pid}`,
      isError: false,
    };
  }

  async function runCommandInner(command: string, context: ToolContext, timeoutSec?: number): Promise<ToolResult> {
    const interactiveError = checkInteractiveCommand(command);
    if (interactiveError) {
      return { content: interactiveError, isError: true };
    }

    if (context.signal?.aborted) {
      return { content: "Aborted", isError: true };
    }

    let timeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    if (timeout > MAX_TIMEOUT_SEC) {
      log.warn("bash timeout clamped", { requested: timeout, clamped: MAX_TIMEOUT_SEC });
      timeout = MAX_TIMEOUT_SEC;
    }

    if (isBackgroundCommand(command)) {
      return runBackground(command, context);
    }

    return runForeground(command, context, timeout);
  }

  return {
    name: "bash",
    description: "Execute a shell command in an isolated bash session. Each call spawns a fresh process — environment variables, working directory changes, and shell state do not persist between calls. Chain dependent commands with && or ; within one call. End a command with & to run it in the background (returns PID and log path). Use the timeout parameter for commands that may run longer than the default 120s.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["command"],
    },
    async execute(input: unknown, context: ToolContext) {
      const rec = input as Record<string, unknown>;
      if (typeof rec.command !== "string") {
        return { content: "bash requires a string 'command' parameter", isError: true };
      }
      const timeout = typeof rec.timeout === "number" ? rec.timeout : undefined;
      return runCommandInner(rec.command, context, timeout);
    },
  };
}

export const bashDefinition = createBashDefinition();

