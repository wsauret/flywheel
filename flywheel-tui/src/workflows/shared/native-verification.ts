// Phase 3: Trust-But-Verify — Native Verification
//
// Re-runs commands the worker reported running, with deny-list filtering,
// concurrent execution, discrepancy detection, and git diff --stat support.

import { errorMessage } from "../../infra/error-message.js";

// Types

export interface DeclaredCommand {
  command: string;
  reportedExitCode?: number;
  observation?: string;
}

export type NativeCheckResult =
  | { kind: "ran"; command: string; passed: boolean; stdout: string; stderr: string; exitCode: number; durationMs: number }
  | { kind: "skipped"; command: string; skipReason: string }
  | { kind: "discrepancy"; command: string; passed: false; stdout: string; stderr: string; exitCode: number; durationMs: number; reportedExitCode: number }

export interface NativeVerificationResult {
  allPassed: boolean;
  hasChanges: boolean;
  checks: NativeCheckResult[];
  discrepancies: NativeCheckResult[];
}

// Deny-list

/** Single-word commands that are always denied. */
const DENIED_FIRST_TOKEN = new Set([
  // Filesystem destructive
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "shred",
  // Network
  "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat",
  // Process
  "kill", "pkill", "killall",
  // Shell builtins
  "cd", "echo", "cat", "export", "source", "eval", "exec",
  // Cloud CLIs
  "aws", "gcloud", "az", "kubectl",
  // Publishing (single-word)
  "twine",
]);

/** Two-token commands that are denied (e.g. "npm publish"). */
const DENIED_TWO_TOKEN = new Set([
  "npm publish",
  "cargo publish",
  "gem push",
  "docker rm",
  "docker stop",
  "docker push",
  "docker rmi",
]);

/** Git subcommands that are denied. */
const DENIED_GIT_SUBCOMMANDS = new Set([
  "push", "commit", "add", "reset", "checkout", "rebase", "branch", "merge", "stash",
]);

/**
 * Check whether a command is on the deny-list.
 * Returns `true` if the command should be skipped.
 */
export function isDeniedCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === "") return true;

  const first = tokens[0];

  // Single-word deny list
  if (DENIED_FIRST_TOKEN.has(first)) return true;

  // Two-token deny list
  if (tokens.length >= 2) {
    const twoToken = `${first} ${tokens[1]}`;
    if (DENIED_TWO_TOKEN.has(twoToken)) return true;
  }

  // Git subcommand deny list
  if (first === "git" && tokens.length >= 2) {
    if (DENIED_GIT_SUBCOMMANDS.has(tokens[1])) return true;
  }

  return false;
}

// Command extraction — DRY adapter over parseRawHandoff

// extractDeclaredCommands lives in workflows/queue/shared/command-extraction.ts
// to avoid a layer violation (orchestration importing from workflows).

// Constants

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_DEADLINE_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000; // 1MB

// Shared subprocess helper

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // Truncate to maxBytes and append indicator
  const buf = Buffer.from(text);
  return buf.subarray(0, maxBytes).toString("utf-8") + "\n[truncated]";
}

/**
 * Spawn a subprocess with per-command timeout and shared deadline abort.
 * Shared by runSingleCommand and runGitDiffCheck to eliminate boilerplate.
 */
async function spawnWithTimeout(
  tokens: string[],
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const start = Date.now();

  const proc = Bun.spawn(tokens, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  // Per-command timeout
  const timeoutId = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, timeoutMs);

  // Shared deadline abort
  const onAbort = () => {
    try { proc.kill(); } catch { /* already exited */ }
  };
  if (abortSignal.aborted) {
    try { proc.kill(); } catch { /* already exited */ }
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // Read output
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);
  abortSignal.removeEventListener("abort", onAbort);

  const durationMs = Date.now() - start;
  return { stdout, stderr, exitCode, durationMs };
}

// Single command runner

async function runSingleCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal,
  reportedExitCode?: number,
): Promise<NativeCheckResult> {
  // Deny-list check
  if (isDeniedCommand(command)) {
    return {
      kind: "skipped",
      command,
      skipReason: `denied: ${command.trim().split(/\s+/).slice(0, 2).join(" ")}`,
    };
  }

  const tokens = command.trim().split(/\s+/);

  try {
    const { stdout, stderr, exitCode, durationMs } = await spawnWithTimeout(
      tokens, cwd, timeoutMs, abortSignal,
    );

    const passed = exitCode === 0;

    // Discrepancy detection
    if (reportedExitCode !== undefined && reportedExitCode !== exitCode) {
      return {
        kind: "discrepancy",
        command,
        passed: false as const,
        stdout: truncate(stdout, MAX_OUTPUT_BYTES),
        stderr: truncate(stderr, MAX_OUTPUT_BYTES),
        exitCode,
        durationMs,
        reportedExitCode,
      };
    }

    return {
      kind: "ran",
      command,
      passed,
      stdout: truncate(stdout, MAX_OUTPUT_BYTES),
      stderr: truncate(stderr, MAX_OUTPUT_BYTES),
      exitCode,
      durationMs,
    };
  } catch (err) {
    const message = errorMessage(err);

    // Missing binary detection
    if (
      message.includes("not found") ||
      message.includes("ENOENT") ||
      message.includes("No such file") ||
      message.includes("spawn")
    ) {
      return {
        kind: "skipped",
        command,
        skipReason: `missing binary: ${tokens[0]}`,
      };
    }

    return {
      kind: "ran",
      command,
      passed: false,
      stdout: "",
      stderr: message,
      exitCode: -1,
      durationMs: 0,
    };
  }
}

// Main entry point

export async function runNativeVerification(opts: {
  projectCwd: string;
  declaredCommands: DeclaredCommand[];
  // Currently only "has-changes" gates specific logic (git diff check).
  // "build", "test", and "lint" are reserved for future use — declared
  // commands are always re-run regardless of these values.
  nativeCheckTypes: Array<"build" | "test" | "lint" | "has-changes">;
  timeoutMs?: number;
  deadlineMs?: number;
}): Promise<NativeVerificationResult> {
  const {
    projectCwd,
    declaredCommands,
    nativeCheckTypes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = opts;

  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => abortController.abort(), deadlineMs);

  try {
    // Build check functions (not promises) so we can batch execution
    const MAX_CONCURRENT = 6;
    const checkFns: Array<() => Promise<NativeCheckResult>> = [];

    // Run declared commands
    for (const decl of declaredCommands) {
      checkFns.push(() =>
        runSingleCommand(
          decl.command,
          projectCwd,
          timeoutMs,
          abortController.signal,
          decl.reportedExitCode,
        ),
      );
    }

    // git diff --stat only when has-changes is requested
    if (nativeCheckTypes.includes("has-changes")) {
      checkFns.push(() => runGitDiffCheck(projectCwd, timeoutMs, abortController.signal));
    }

    // Execute in batches with max concurrency
    const checks: NativeCheckResult[] = [];
    for (let i = 0; i < checkFns.length; i += MAX_CONCURRENT) {
      const batch = checkFns.slice(i, i + MAX_CONCURRENT).map(fn => fn());
      checks.push(...await Promise.all(batch));
    }

    const gitDiffCheck = checks.find((c) => c.command.includes("git diff"));
    const hasChanges = gitDiffCheck?.kind === "ran" ? gitDiffCheck.stdout.trim().length > 0 : false;

    const discrepancies = checks.filter((c) => c.kind === "discrepancy");

    const allPassed =
      checks.every((c) => c.kind === "skipped" || c.passed) &&
      discrepancies.length === 0;

    return { allPassed, hasChanges, checks, discrepancies };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// Git diff check

async function runGitDiffCheck(
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<NativeCheckResult> {
  // HEAD~1 checks the last commit's diff — verifying the worker made changes.
  // Single-commit repos (no HEAD~1) are handled by the skip logic below.
  const command = "git diff --stat HEAD~1";

  try {
    const { stdout, stderr, exitCode, durationMs } = await spawnWithTimeout(
      ["git", "diff", "--stat", "HEAD~1"], cwd, timeoutMs, abortSignal,
    );

    // Single-commit repo: git diff HEAD~1 fails — skip gracefully
    if (exitCode !== 0) {
      return {
        kind: "skipped",
        command,
        skipReason: "git diff HEAD~1 failed (possibly single-commit repo)",
      };
    }

    return {
      kind: "ran",
      command,
      passed: true,
      stdout: truncate(stdout, MAX_OUTPUT_BYTES),
      stderr: truncate(stderr, MAX_OUTPUT_BYTES),
      exitCode,
      durationMs,
    };
  } catch (err) {
    return {
      kind: "skipped",
      command,
      skipReason: "git diff HEAD~1 threw (possibly single-commit repo)",
    };
  }
}
