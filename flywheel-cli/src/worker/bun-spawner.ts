/**
 * BunProcessSpawner — implements ProcessSpawner using Bun.spawn().
 *
 * - Pre-encoded stdin delivery (Uint8Array, not proc.stdin.write())
 * - Piped stdio: stdout/stderr piped, stdin from buffer or 'ignore'
 * - ReadableStream readers with TextDecoder({ stream: true })
 * - Global process registry with clean entry removal on exit
 * - Shell metacharacter validation on all spawn args
 * - Bun.which() command resolution with graceful fallbacks
 * - Raw stdout/stderr collection alongside tiered buffers
 * - Stream reader cancellation on abort
 * - Integrates: buffer, completion, env-filter, NDJSON parser, error categorization
 */

import type { ProcessSpawner, SpawnOptions } from "./spawner";
import type { WorkerResult } from "../schemas/worker";
import { TieredBuffer } from "./buffer";
import { CompletionDetector } from "./completion";
import { createEnvFilter, type EnvFilterOptions } from "./env-filter";
import { NDJSONParser } from "./ndjson-parser";
import { categorizeFailure } from "./errors";
import { registerProcess, gracefulKill, type ChildHandle } from "./process-lifecycle";
import { createWorkerTimeout, minutesToMs, clampTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES } from "./timeout";

/**
 * Shell metacharacter regex — reject args that could cause shell injection.
 */
const SHELL_METACHAR_REGEX = /[;&|`$(){}!<>]/;

/**
 * Validate that the spawn command contains no shell metacharacters.
 *
 * Only the command name is validated — argument content (e.g., prompts)
 * can legitimately contain characters like `<`, `>`, `()`, etc.
 * Since `Bun.spawn()` uses `execve` directly (no shell), arguments are
 * passed safely regardless of content. The command validation prevents
 * binary name injection only.
 *
 * @throws Error if the command contains shell metacharacters.
 */
export function validateSpawnArgs(command: string, _args: readonly string[]): void {
  if (SHELL_METACHAR_REGEX.test(command)) {
    throw new Error(`Shell metacharacter detected in command: ${command}`);
  }
}

/**
 * Resolve a command name to its full executable path using Bun.which().
 *
 * - If the command contains a path separator (/ or \), return as-is
 * - Try Bun.which() for PATH resolution (wrapped in try/catch since it can throw)
 * - Fallback: for 'bun' command, use process.execPath
 * - Otherwise return the command unchanged (let Bun.spawn handle it)
 */
export function resolveCommandExecutable(command: string): string {
  // If command already specifies a path (relative or absolute), use it as-is
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  // Try Bun.which() for PATH resolution
  try {
    const resolved = Bun.which(command);
    if (resolved) return resolved;
  } catch {
    // Bun.which() can throw — fall through to fallbacks
  }

  // Fallback for 'bun' command
  if (command === "bun" && typeof process.execPath === "string" && process.execPath.length > 0) {
    return process.execPath;
  }

  return command;
}

export interface BunSpawnerOptions {
  /** Environment filter configuration. */
  envFilter?: EnvFilterOptions;
  /** Timeout in minutes (1-120, default 60). */
  timeoutMinutes?: number;
}

/**
 * BunProcessSpawner — production implementation using Bun.spawn().
 */
export class BunProcessSpawner implements ProcessSpawner {
  private readonly envFilter;
  private readonly timeoutMs: number;

  constructor(options: BunSpawnerOptions = {}) {
    this.envFilter = createEnvFilter(options.envFilter);
    const minutes = clampTimeoutMinutes(options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES);
    this.timeoutMs = minutesToMs(minutes);
  }

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<WorkerResult> {
    // Validate args for shell metacharacters
    validateSpawnArgs(command, args);

    // Resolve command to full executable path
    const executable = resolveCommandExecutable(command);

    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    // Filter environment variables
    const baseEnv = options?.env ?? (process.env as Record<string, string>);
    const filteredEnv = this.envFilter.filter(baseEnv);

    // Pre-encode stdin if provided; otherwise use 'ignore' so processes
    // that don't expect stdin don't receive an empty Blob.
    const stdinEncoded = options?.stdin !== undefined
      ? new TextEncoder().encode(options.stdin)
      : undefined;

    // Set up timeout
    const workerTimeout = createWorkerTimeout(timeoutMs);

    // Set up output tracking
    const buffer = new TieredBuffer();
    const completionDetector = new CompletionDetector();
    const ndjsonParser = new NDJSONParser(buffer);

    // Raw chunk collectors (unprocessed stdout/stderr)
    const rawStdoutChunks: string[] = [];
    const rawStderrChunks: string[] = [];

    // Track stream readers for cancellation on abort.
    // Typed as `{ cancel(): Promise<void> } | null` to avoid Bun's non-standard
    // ReadableStreamDefaultReader extension (`readMany`) that causes TS2741.
    let stdoutReader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | null = null;
    let stderrReader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | null = null;

    const cancelReaders = () => {
      if (stdoutReader) {
        try { stdoutReader.cancel().catch(() => {}); } catch { /* reader may already be released */ }
        stdoutReader = null;
      }
      if (stderrReader) {
        try { stderrReader.cancel().catch(() => {}); } catch { /* reader may already be released */ }
        stderrReader = null;
      }
    };

    // Cancel readers on abort signal to unblock stream read promises
    const signal = workerTimeout.signal;
    if (!signal.aborted) {
      signal.addEventListener("abort", cancelReaders, { once: true });
    }

    try {
      // Spawn the process
      const proc = Bun.spawn([executable, ...args], {
        cwd: options?.cwd,
        env: filteredEnv,
        stdin: stdinEncoded ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Register in global process registry (cleaned on exit)
      const unregister = registerProcess(proc as unknown as ChildHandle);

      // Wire up timeout to kill the process
      workerTimeout.attachProcess(proc as unknown as ChildHandle);

      // Read stdout stream
      stdoutReader = proc.stdout.getReader();
      const stdoutDecoder = new TextDecoder("utf-8", { fatal: false });

      const readStdout = async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader!.read();
            if (done) break;
            const text = stdoutDecoder.decode(value, { stream: true });
            rawStdoutChunks.push(text);
            ndjsonParser.write(text);
            completionDetector.check(text);
          }
          // Flush decoder
          const remaining = stdoutDecoder.decode(undefined, { stream: false });
          if (remaining) {
            rawStdoutChunks.push(remaining);
            ndjsonParser.write(remaining);
            completionDetector.check(remaining);
          }
        } catch {
          // Stream may be closed due to process kill or reader cancellation
        }
      };

      // Read stderr stream
      stderrReader = proc.stderr.getReader();
      const stderrDecoder = new TextDecoder("utf-8", { fatal: false });

      const readStderr = async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader!.read();
            if (done) break;
            const text = stderrDecoder.decode(value, { stream: true });
            rawStderrChunks.push(text);
          }
          const remaining = stderrDecoder.decode(undefined, { stream: false });
          if (remaining) rawStderrChunks.push(remaining);
        } catch {
          // Stream may be closed due to process kill or reader cancellation
        }
      };

      // Read both streams concurrently, then wait for exit
      await Promise.all([readStdout(), readStderr()]);

      // Wait for process to exit
      const exitCode = await proc.exited;

      // Flush NDJSON parser
      ndjsonParser.flush();

      // Clean up
      workerTimeout.cancel();
      unregister();

      // Fallback completion check
      const tier1 = buffer.getTier1();
      completionDetector.checkFallback(tier1.content);

      const durationMs = Date.now() - startTime;

      // Categorize failure
      const stderrContent = rawStderrChunks.join("");
      const failure = categorizeFailure({
        exitCode,
        stdout: tier1.content,
        stderr: stderrContent,
        timedOut: workerTimeout.timedOut,
        timeoutMs,
        completionDetected: completionDetector.hasSeenCompletion,
      });

      return {
        output: tier1.content,
        rawOutput: rawStdoutChunks.join(""),
        rawStderr: stderrContent,
        exitCode,
        truncated: buffer.truncated,
        durationMs,
        failure,
      };
    } catch (error) {
      workerTimeout.cancel();
      const durationMs = Date.now() - startTime;

      return {
        output: buffer.getTier1().content,
        rawOutput: rawStdoutChunks.join(""),
        rawStderr: rawStderrChunks.join(""),
        exitCode: -1,
        truncated: buffer.truncated,
        durationMs,
        failure: {
          kind: "transient",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
