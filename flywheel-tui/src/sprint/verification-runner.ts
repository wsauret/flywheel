/**
 * Verification Script Runner — executes verification scripts written by sprint workers.
 *
 * Supports .ts (via `bun run`) and .sh (via `bash`) scripts.
 * Validates script path exists, is within project boundary, and has a supported extension.
 * Captures stdout/stderr/exit code, enforces timeout, truncates large output.
 * Creates .flywheel/verify/ directory if missing.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { isPathWithinBoundary } from "../utils/path-security";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative path from project root to the verification scripts directory. */
export const VERIFY_DIR = ".flywheel/verify";

/** Maximum bytes of stdout or stderr to keep before truncation. */
export const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

/** Truncation marker appended when output exceeds MAX_OUTPUT_BYTES. */
const TRUNCATION_MARKER = "\n[output truncated — exceeded 1 MB limit]";

/** Supported script extensions and their interpreters. */
const INTERPRETERS: Record<string, { command: string; args: (path: string) => string[] }> = {
  ".ts": { command: "bun", args: (p) => ["run", p] },
  ".sh": { command: "bash", args: (p) => [p] },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  /** Whether the verification passed (exit code 0). */
  passed: boolean;
  /** Script stdout (may be truncated). */
  stdout: string;
  /** Script stderr (may be truncated). */
  stderr: string;
  /** Process exit code. Undefined if script was not executed (e.g., validation error). */
  exitCode?: number;
  /** Whether the script was killed due to timeout. */
  timedOut?: boolean;
  /** Error message if the script could not be executed (missing file, bad extension, security). */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface VerificationRunnerOptions {
  /** Project directory (or worktree path) used as CWD for script execution and security boundary. */
  projectCwd: string;
  /** Timeout in milliseconds for script execution. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = Log.create({ service: "verification-runner" });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a verification script and return a structured result.
 *
 * Never throws — all errors are captured as error results.
 *
 * @param scriptPath - Path to the verification script (absolute or relative to CWD).
 * @param options    - Runner options (projectCwd, timeoutMs).
 * @returns Structured verification result.
 */
export async function runVerificationScript(
  scriptPath: string,
  options: VerificationRunnerOptions,
): Promise<VerificationResult> {
  const startTime = Date.now();

  try {
    // --- Ensure .flywheel/verify/ directory exists ---
    const verifyDirPath = join(options.projectCwd, VERIFY_DIR);
    await ensureVerifyDir(verifyDirPath);

    // --- Resolve and validate script path ---
    const resolvedPath = resolve(options.projectCwd, scriptPath);

    // Security: script must be within project boundary
    if (!isPathWithinBoundary(resolvedPath, options.projectCwd)) {
      return errorResult(
        `Security: script path resolves outside project boundary. Path traversal rejected.`,
        startTime,
      );
    }

    // Check supported extension
    const ext = extname(resolvedPath).toLowerCase();
    const interpreter = INTERPRETERS[ext];
    if (!interpreter) {
      return errorResult(
        `Unsupported script extension "${ext || "(none)"}". Supported: ${Object.keys(INTERPRETERS).join(", ")}`,
        startTime,
      );
    }

    // Check file exists
    if (!existsSync(resolvedPath)) {
      return errorResult(
        `Script file does not exist: ${scriptPath}`,
        startTime,
      );
    }

    // --- Spawn the script ---
    return await spawnScript(resolvedPath, interpreter, options, startTime);
  } catch (err) {
    // Catch-all: never throw from the public API
    const msg = err instanceof Error ? err.message : String(err);
    log.error("verification runner unexpected error", { error: msg });
    return errorResult(`Unexpected error: ${msg}`, startTime);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create .flywheel/verify/ if it doesn't exist.
 */
async function ensureVerifyDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Build an error result (script was not executed).
 */
function errorResult(error: string, startTime: number): VerificationResult {
  return {
    passed: false,
    stdout: "",
    stderr: "",
    error,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Truncate a string to MAX_OUTPUT_BYTES, appending a marker if truncated.
 */
function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, "utf-8") <= MAX_OUTPUT_BYTES) {
    return output;
  }

  // Truncate by bytes: encode, slice, decode
  const buf = Buffer.from(output, "utf-8");
  const truncated = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8");
  return truncated + TRUNCATION_MARKER;
}

/**
 * Spawn the verification script subprocess, capture output, enforce timeout.
 */
async function spawnScript(
  resolvedPath: string,
  interpreter: { command: string; args: (path: string) => string[] },
  options: VerificationRunnerOptions,
  startTime: number,
): Promise<VerificationResult> {
  const args = interpreter.args(resolvedPath);
  const command = interpreter.command;

  // Resolve command to executable
  const executable = resolveExecutable(command);

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const proc = Bun.spawn([executable, ...args], {
    cwd: options.projectCwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Track stream readers for cancellation on timeout
  type StreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  let stdoutReader: StreamReader | null = null;
  let stderrReader: StreamReader | null = null;

  const cancelReaders = () => {
    if (stdoutReader) {
      try { stdoutReader.cancel().catch(() => {}); } catch { /* may already be released */ }
      stdoutReader = null;
    }
    if (stderrReader) {
      try { stderrReader.cancel().catch(() => {}); } catch { /* may already be released */ }
      stderrReader = null;
    }
  };

  // Set up timeout — kills process and cancels readers
  timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Process may have already exited
    }
    cancelReaders();
  }, options.timeoutMs);

  // Collect stdout
  const stdoutChunks: string[] = [];
  let stdoutBytes = 0;
  let stdoutTruncated = false;

  const readStdout = async () => {
    stdoutReader = proc.stdout.getReader() as StreamReader;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        if (stdoutTruncated) continue; // Drain but don't accumulate
        const text = decoder.decode(value, { stream: true });
        stdoutBytes += Buffer.byteLength(text, "utf-8");
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          stdoutTruncated = true;
          stdoutChunks.push(text);
        } else {
          stdoutChunks.push(text);
        }
      }
      const remaining = decoder.decode(undefined, { stream: false });
      if (remaining && !stdoutTruncated) {
        stdoutChunks.push(remaining);
      }
    } catch {
      // Stream may close on kill or cancel
    }
  };

  // Collect stderr
  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  let stderrTruncated = false;

  const readStderr = async () => {
    stderrReader = proc.stderr.getReader() as StreamReader;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        if (stderrTruncated) continue;
        const text = decoder.decode(value, { stream: true });
        stderrBytes += Buffer.byteLength(text, "utf-8");
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          stderrTruncated = true;
          stderrChunks.push(text);
        } else {
          stderrChunks.push(text);
        }
      }
      const remaining = decoder.decode(undefined, { stream: false });
      if (remaining && !stderrTruncated) {
        stderrChunks.push(remaining);
      }
    } catch {
      // Stream may close on kill or cancel
    }
  };

  // Wait for streams to close and process to exit
  try {
    await Promise.all([readStdout(), readStderr()]);
    const exitCode = await proc.exited;

    // Clear timeout
    clearTimeout(timeoutId);

    let stdout = stdoutChunks.join("");
    let stderr = stderrChunks.join("");

    // Apply truncation with markers
    if (stdoutTruncated) {
      stdout = truncateOutput(stdout);
    }
    if (stderrTruncated) {
      stderr = truncateOutput(stderr);
    }

    if (timedOut) {
      log.info("verification script timed out", {
        script: resolvedPath,
        timeoutMs: options.timeoutMs,
      });
      return {
        passed: false,
        stdout,
        stderr,
        timedOut: true,
        durationMs: Date.now() - startTime,
      };
    }

    log.info("verification script completed", {
      script: resolvedPath,
      exitCode,
      durationMs: Date.now() - startTime,
    });

    return {
      passed: exitCode === 0,
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    const msg = err instanceof Error ? err.message : String(err);
    log.error("verification script execution error", { error: msg });
    return errorResult(`Execution error: ${msg}`, startTime);
  }
}

/**
 * Resolve a command name to its executable path.
 * For 'bun', uses process.execPath as fallback.
 */
function resolveExecutable(command: string): string {
  // Try Bun.which for PATH resolution
  try {
    const resolved = Bun.which(command);
    if (resolved) return resolved;
  } catch {
    // Fall through
  }

  // Fallback for 'bun'
  if (command === "bun" && typeof process.execPath === "string" && process.execPath.length > 0) {
    return process.execPath;
  }

  return command;
}
