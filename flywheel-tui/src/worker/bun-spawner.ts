/**
 * BunProcessSpawner — implements ProcessSpawner using Bun.spawn().
 *
 * Stdin modes:
 * - Pre-encoded delivery (Uint8Array): default when `stdin` is provided without `stdinPipe`
 * - Streaming pipe: when `stdinPipe: true` — returns StdinHandle for mid-execution writes
 * - Ignore: when no `stdin` is provided
 *
 * Features:
 * - Piped stdio: stdout/stderr piped, stdin from buffer, pipe, or 'ignore'
 * - ReadableStream readers with TextDecoder({ stream: true })
 * - Global process registry with clean entry removal on exit
 * - Shell metacharacter validation on all spawn args
 * - Bun.which() command resolution with graceful fallbacks
 * - Raw stdout/stderr collection alongside tiered buffers
 * - Stream reader cancellation on abort
 * - Integrates: buffer, completion, env-filter, NDJSON parser, error categorization
 */

import * as path from "node:path";
import type { ProcessSpawner, SpawnOptions, SpawnResult, StdinHandle } from "./spawner";
import type { WorkerResult } from "./schemas";
import { TieredBuffer } from "./buffer";
import { CompletionDetector } from "./completion";
import { createEnvFilter, type EnvFilterOptions } from "./env-filter";
import { NDJSONParser } from "./ndjson-parser";
import { categorizeFailure } from "./errors";
import { registerProcess, gracefulKill, type ChildHandle } from "./process-lifecycle";
import { createWorkerTimeout, minutesToMs, clampTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES } from "./timeout";
import { resolveSessionHandoffsDir } from "../config/paths";

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
 * Check if an exit code indicates the process was killed by a signal.
 *
 * On Unix, signal kills produce exit code 128 + signal number:
 * - SIGINT (2)  → 130
 * - SIGTERM (15) → 143
 * - SIGKILL (9)  → 137
 *
 * Following ralph-tui's pattern of detecting interruptions from exit codes.
 */
function isSignalExit(exitCode: number): boolean {
  // Standard Unix signal exit codes
  return exitCode === 130   // SIGINT (Ctrl+C)
      || exitCode === 143   // SIGTERM
      || exitCode === 137;  // SIGKILL
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

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    // Validate args for shell metacharacters
    validateSpawnArgs(command, args);

    // Resolve command to full executable path
    const executable = resolveCommandExecutable(command);

    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    // Filter environment variables
    const baseEnv = options?.env ?? (process.env as Record<string, string>);
    const filteredEnv = this.envFilter.filter(baseEnv);

    // Determine stdin mode:
    // - stdinPipe + stdin → streaming pipe (write initial content, keep open)
    // - no stdinPipe + stdin → pre-encoded Uint8Array (one-shot, closed after write)
    // - no stdin → 'ignore'
    const usePipe = options?.stdinPipe === true && options?.stdin !== undefined;
    const stdinEncoded = !usePipe && options?.stdin !== undefined
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

    // Wire external abort signal (from controller shutdown) to interrupt
    if (options?.signal && !options.signal.aborted) {
      options.signal.addEventListener("abort", () => workerTimeout.interrupt(), { once: true });
    } else if (options?.signal?.aborted) {
      workerTimeout.interrupt();
    }

    // Resolve handoff path from sessionId + handoffFileName, or invocationId fallback
    let handoffPath = "";
    if (options?.sessionId && options?.handoffFileName) {
      handoffPath = path.resolve(
        resolveSessionHandoffsDir(options.sessionId, options.cwd ?? process.cwd()),
        options.handoffFileName,
      );
    } else if (options?.invocationId && options?.sessionId) {
      handoffPath = path.resolve(
        resolveSessionHandoffsDir(options.sessionId, options.cwd ?? process.cwd()),
        `${options.invocationId}.json`,
      );
    }

    // Build the WorkerResult from completion state (shared between pipe and non-pipe paths)
    const buildWorkerResult = (exitCode: number): WorkerResult => {
      // Flush NDJSON parser
      ndjsonParser.flush();

      // Detect if process was interrupted by signal (Ctrl+C → SIGINT → exit 130)
      // or by user-initiated interrupt via workerTimeout.interrupt()
      const interrupted = workerTimeout.interrupted || isSignalExit(exitCode);

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
        interrupted,
      });

      return {
        output: tier1.content,
        rawOutput: rawStdoutChunks.join(""),
        rawStderr: stderrContent,
        exitCode,
        truncated: buffer.truncated,
        durationMs,
        failure,
        sessionId: ndjsonParser.sessionId ?? undefined,
        handoffPath,
      };
    };

    const buildErrorResult = (error: unknown): WorkerResult => {
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
        handoffPath,
      };
    };

    try {
      // Spawn the process
      const proc = Bun.spawn([executable, ...args], {
        cwd: options?.cwd,
        env: filteredEnv,
        stdin: usePipe ? "pipe" : (stdinEncoded ?? "ignore"),
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

      /** Optional callback invoked once when completion is first detected during streaming. */
      let _onCompletionDetected: (() => void) | null = null;

      /** Track whether onSessionId has been fired (fire-once semantics). */
      let sessionIdReported = false;

      const readStdout = async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader!.read();
            if (done) break;
            const text = stdoutDecoder.decode(value, { stream: true });
            rawStdoutChunks.push(text);
            options?.onStdout?.(text);
            ndjsonParser.write(text);
            // Fire once when session_id is first captured from NDJSON init event
            if (!sessionIdReported && ndjsonParser.sessionId && options?.onSessionId) {
              options.onSessionId(ndjsonParser.sessionId);
              sessionIdReported = true;
            }
            const wasDetected = completionDetector.hasSeenCompletion;
            completionDetector.check(text);
            // Fire once on transition from undetected → detected
            if (!wasDetected && completionDetector.hasSeenCompletion && _onCompletionDetected) {
              _onCompletionDetected();
              _onCompletionDetected = null;
            }
          }
          // Flush decoder
          const remaining = stdoutDecoder.decode(undefined, { stream: false });
          if (remaining) {
            rawStdoutChunks.push(remaining);
            options?.onStdout?.(remaining);
            ndjsonParser.write(remaining);
            // Check session_id after flush too
            if (!sessionIdReported && ndjsonParser.sessionId && options?.onSessionId) {
              options.onSessionId(ndjsonParser.sessionId);
              sessionIdReported = true;
            }
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
            options?.onStderr?.(text);
          }
          const remaining = stderrDecoder.decode(undefined, { stream: false });
          if (remaining) {
            rawStderrChunks.push(remaining);
            options?.onStderr?.(remaining);
          }
        } catch {
          // Stream may be closed due to process kill or reader cancellation
        }
      };

      // --- Pipe mode: return early with StdinHandle, result resolves later ---
      if (usePipe) {
        const encoder = new TextEncoder();
        let pipeOpen = true;

        // proc.stdin is a FileSink when spawned with stdin: "pipe"
        const stdinSink = proc.stdin as import("bun").FileSink;

        // Close pipe when process exits
        const onExit = () => { pipeOpen = false; };
        proc.exited.then(onExit, onExit);

        const stdinHandle: StdinHandle = {
          write(message: string): boolean {
            if (!pipeOpen) return false;
            try {
              stdinSink.write(encoder.encode(message));
              return true;
            } catch {
              pipeOpen = false;
              return false;
            }
          },
          close(): void {
            if (!pipeOpen) return;
            pipeOpen = false;
            try {
              stdinSink.end();
            } catch {
              // Already closed
            }
          },
          get isOpen(): boolean {
            return pipeOpen;
          },
        };

        // Write initial stdin content CONCURRENTLY with stdout/stderr reads
        // (avoids >64KB deadlock — the process can start consuming stdin
        // while we're already reading its output)
        const writeInitialStdin = async () => {
          try {
            stdinSink.write(encoder.encode(options!.stdin!));
            stdinSink.flush();
            // DO NOT call stdinSink.end() — pipe stays open for mid-execution injection
          } catch {
            pipeOpen = false;
          }
        };

        const watchHandoff = async () => {
          if (!handoffPath) return;

          while (pipeOpen && !workerTimeout.signal.aborted) {
            if (completionDetector.hasSeenCompletion) {
              return;
            }

            if (completionDetector.checkHandoffFile(handoffPath)) {
              if (_onCompletionDetected) {
                _onCompletionDetected();
                _onCompletionDetected = null;
              }
              return;
            }

            await Bun.sleep(100);
          }
        };

        // In pipe mode, handle completion detection based on whether the caller
        // wants turn-boundary callbacks (2-tier interrupt system) or the default
        // close-on-completion behavior.
        if (options?.onTurnComplete) {
          // Turn-complete mode: notify the caller at turn boundaries so they
          // can inject messages via the still-open stdin pipe. The pipe stays
          // open until the caller explicitly closes it or the process exits.
          const turnCallback = options.onTurnComplete;
          _onCompletionDetected = () => {
            if (!pipeOpen) return;
            turnCallback(ndjsonParser.sessionId ?? undefined);
          };
        } else {
          // Default: close stdin when the worker signals completion.
          // Without this, Claude's stream-json mode keeps waiting for more input
          // on stdin, preventing the process from exiting and the step from advancing.
          _onCompletionDetected = () => {
            if (!pipeOpen) return;
            pipeOpen = false;
            try {
              stdinSink.end();
            } catch {
              // Already closed
            }
          };
        }

        // The result promise: read streams + wait for exit + build result
        const resultPromise = (async (): Promise<WorkerResult> => {
          try {
            await Promise.all([readStdout(), readStderr(), writeInitialStdin(), watchHandoff()]);
            const exitCode = await proc.exited;
            workerTimeout.cancel();
            unregister();
            return buildWorkerResult(exitCode);
          } catch (error) {
            workerTimeout.cancel();
            return buildErrorResult(error);
          }
        })();

        return { result: resultPromise, stdinHandle, pid: proc.pid };
      }

      // --- Non-pipe mode: wait for completion, wrap in SpawnResult ---
      await Promise.all([readStdout(), readStderr()]);
      const exitCode = await proc.exited;
      workerTimeout.cancel();
      unregister();

      const workerResult = buildWorkerResult(exitCode);
      return { result: Promise.resolve(workerResult), pid: proc.pid };

    } catch (error) {
      workerTimeout.cancel();
      return { result: Promise.resolve(buildErrorResult(error)) };
    }
  }
}
