import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Log } from "../../../../../infra/log.js";
import { killProcessGroup } from "../../../../../infra/process-lifecycle.js";
import { compressBashOutput } from "./bash-compressor.js";
import { interceptBashCommand } from "./bash-interceptor.js";
import type { ToolDefinition, ToolResult, ToolContext, BashOperations } from "./types.js";

const log = Log.create({ service: "harness-bash" });

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 3600;
const KILL_GRACE_MS = 5_000;

// Editor/pager patterns anchor to command position (start of line or after a shell separator)
// so identifiers like `vi.fn` or `vitest` inside inline scripts don't false-trigger.
const CMD_POS = String.raw`(?:^|[;&|(\n])\s*`;
const CMD_END = String.raw`(?:\s|$|[;&|)])`;

const INTERACTIVE_COMMAND_PATTERNS: ReadonlyArray<{ match: RegExp; guidance: string }> = [
  { match: new RegExp(`${CMD_POS}(vim|nvim|nano|emacs|pico)${CMD_END}`), guidance: "editors can't run interactively -- use the `edit` tool for existing files, `write` for new files" },
  { match: new RegExp(`${CMD_POS}(less|more|most)${CMD_END}`), guidance: "use the `read` tool instead of a pager" },
  { match: new RegExp(`${CMD_POS}(top|htop|btop|atop)${CMD_END}`), guidance: "use `ps aux` or `ps -eo ...` for a one-shot process snapshot" },
  { match: /\bman\s+\S+/, guidance: "use `--help` on the command or read the manpage source if needed" },
  { match: /^\s*(python3?|ipython|node|ruby|irb|php|lua)(\s+-i)?\s*$/, guidance: "pass `-c 'code'` (or `-e`) to run inline, or write a script file and execute it" },
  { match: new RegExp(`${CMD_POS}(telnet|ftp)${CMD_END}`), guidance: "use non-interactive alternatives: `curl`, `wget`, `ncat --exec`" },
  { match: /\bnc\s+-l\b/, guidance: "use non-interactive alternatives: `curl`, `wget`, `ncat --exec`" },
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
  const lines = [
    "set -m",
    "exec 2>&1",
  ];
  lines.push(
    `{ ${command}; } &`,
    "CHILD=$!",
    "trap 'kill -- -$CHILD 2>/dev/null' TERM INT",
    "wait $CHILD 2>/dev/null",
    "exit $?",
  );
  return lines.join("\n");
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
      let aborted = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      const killTimer = setTimeout(() => {
        timedOut = true;
        log.warn("command timed out, sending SIGTERM", { timeoutSec });
        killProcessGroup(proc, "SIGTERM");
        escalationTimer = setTimeout(() => {
          killProcessGroup(proc, "SIGKILL");
        }, KILL_GRACE_MS);
      }, timeoutSec * 1000);

      let abortEscalationTimer: ReturnType<typeof setTimeout> | undefined;
      const abortHandler = () => {
        aborted = true;
        log.info("bash aborted by signal, sending SIGTERM");
        killProcessGroup(proc, "SIGTERM");
        abortEscalationTimer = setTimeout(() => {
          killProcessGroup(proc, "SIGKILL");
        }, KILL_GRACE_MS);
      };
      if (context.signal) {
        if (context.signal.aborted) abortHandler();
        else context.signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        await proc.exited;
        if (aborted) return { content: "Aborted by user.", isError: true };
        const rawOutput = await new Response(proc.stdout).text();
        const compressed = compressBashOutput(command, rawOutput.trim());
        const output = compressed.output;
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
        if (escalationTimer) clearTimeout(escalationTimer);
        if (abortEscalationTimer) clearTimeout(abortEscalationTimer);
        context.signal?.removeEventListener("abort", abortHandler);
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

    context.bgLogPaths.add(logPath);

    return {
      content: `Started in background. PID: ${pid}. Log: ${logPath}.\nCheck progress: cat ${logPath}\nStop: kill ${pid}`,
      isError: false,
    };
  }

  async function runCommandInner(command: string, context: ToolContext, timeoutSec?: number): Promise<ToolResult> {
    if (context.availableTools) {
      const intercepted = interceptBashCommand(command, context.availableTools);
      if (intercepted) return { content: intercepted, isError: true };
    }

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
    description: `Execute a shell command in an isolated bash session. Each call spawns a fresh process — environment variables, working directory changes, and shell state do not persist between calls. Use the cwd parameter to set the working directory instead of cd. Always quote paths containing spaces or special characters (parentheses, brackets). Chain dependent commands with && or ; within one call. End a command with & to run it in the background (returns PID and log path). You may specify an optional timeout in seconds (up to ${MAX_TIMEOUT_SEC}s). By default, commands timeout after ${DEFAULT_TIMEOUT_SEC}s.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        cwd: { type: "string", description: "Working directory for the command (default: project root)" },
        timeout: { type: "number", description: `Optional timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC})` },
      },
      required: ["command"],
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      if (typeof input.command !== "string") {
        return { content: "bash requires a string 'command' parameter", isError: true };
      }
      const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
      const effectiveContext = typeof input.cwd === "string"
        ? { ...context, cwd: input.cwd.startsWith("/") ? input.cwd : resolve(context.cwd, input.cwd) }
        : context;
      return runCommandInner(input.command, effectiveContext, timeout);
    },
  };
}

export const bashDefinition = createBashDefinition();

export function cleanupBackgroundLogs(paths: Set<string>): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // best-effort — log may already be gone
    }
  }
  paths.clear();
}

