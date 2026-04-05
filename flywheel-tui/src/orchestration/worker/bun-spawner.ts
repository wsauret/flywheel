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

import type { ProcessSpawner, SpawnOptions, SpawnResult } from "./spawner.js";
import type { WorkerResult } from "./schemas.js";
import { TieredBuffer } from "./buffer.js";
import { CompletionDetector } from "./completion.js";
import { createEnvFilter, type EnvFilterOptions } from "./env-filter.js";
import { NDJSONParser } from "./ndjson-parser.js";
import { registerProcess, type ChildHandle } from "./process-lifecycle.js";
import { createWorkerTimeout, minutesToMs, clampTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES } from "./timeout.js";
import {
  validateSpawnArgs,
  resolveCommandExecutable,
  createStreamReaderSet,
  type ResultContext,
  buildWorkerResult,
  buildErrorResult,
  readStream,
  type StdoutProcessorState,
  createStdoutProcessor,
  resolveHandoffPath,
  createStdinHandle,
  writeInitialStdin,
  watchHandoff,
  wireCompletionDetection,
} from "./spawn-helpers.js";

// ---------------------------------------------------------------------------
// BunSpawnerOptions
// ---------------------------------------------------------------------------

export interface BunSpawnerOptions {
  /** Environment filter configuration. */
  envFilter?: EnvFilterOptions;
  /** Timeout in minutes (1-120, default 60). */
  timeoutMinutes?: number;
}

// ---------------------------------------------------------------------------
// BunProcessSpawner
// ---------------------------------------------------------------------------

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
    validateSpawnArgs(command, args);
    const executable = resolveCommandExecutable(command);

    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    // Filter environment variables
    const baseEnv = options?.env ?? (process.env as Record<string, string>);
    const filteredEnv = this.envFilter.filter(baseEnv);

    // Determine stdin mode
    const usePipe = options?.stdinPipe === true && options?.stdin !== undefined;
    const stdinEncoded = !usePipe && options?.stdin !== undefined
      ? new TextEncoder().encode(options.stdin)
      : undefined;

    // Set up shared infrastructure
    const workerTimeout = createWorkerTimeout(timeoutMs);
    const buffer = new TieredBuffer();
    const completionDetector = new CompletionDetector();
    const ndjsonParser = new NDJSONParser(buffer);

    if (options?.onNDJSONEvent) {
      ndjsonParser.onEvent = options.onNDJSONEvent;
    }

    const rawStdoutChunks: string[] = [];
    const rawStderrChunks: string[] = [];
    const handoffPath = resolveHandoffPath(options);

    const resultCtx: ResultContext = {
      ndjsonParser, buffer, completionDetector,
      rawStdoutChunks, rawStderrChunks, workerTimeout,
      timeoutMs, startTime, handoffPath,
    };

    // Set up stream readers with abort-safe cancellation
    const readers = createStreamReaderSet(workerTimeout.signal);

    // Wire external abort signal
    if (options?.signal && !options.signal.aborted) {
      options.signal.addEventListener("abort", () => workerTimeout.interrupt(), { once: true });
    } else if (options?.signal?.aborted) {
      workerTimeout.interrupt();
    }

    // Stdout processing state (mutable, shared between processor and pipe-mode helpers)
    const stdoutState: StdoutProcessorState = { sessionIdReported: false, onCompletionDetected: null };
    const processStdout = createStdoutProcessor(options, ndjsonParser, completionDetector, stdoutState);

    try {
      const proc = Bun.spawn([executable, ...args], {
        cwd: options?.cwd,
        env: filteredEnv,
        stdin: usePipe ? "pipe" : (stdinEncoded ?? "ignore"),
        stdout: "pipe",
        stderr: "pipe",
      });

      const unregister = registerProcess(proc as unknown as ChildHandle);
      workerTimeout.attachProcess(proc as unknown as ChildHandle);

      // Wire stream readers
      readers.stdout = proc.stdout.getReader();
      readers.stderr = proc.stderr.getReader();

      const readStdoutPromise = readStream(readers.stdout, rawStdoutChunks, processStdout);
      const readStderrPromise = readStream(readers.stderr, rawStderrChunks, (text) => options?.onStderr?.(text));

      // --- Pipe mode: return early with StdinHandle, result resolves later ---
      if (usePipe) {
        const stdinSink = proc.stdin as import("bun").FileSink;
        const stdinHandle = createStdinHandle(stdinSink, proc);

        wireCompletionDetection(options!, stdinHandle, ndjsonParser, completionDetector, stdoutState);

        const writeInitial = writeInitialStdin(stdinSink, options!.stdin!, stdinHandle);
        const watchHandoffFn = watchHandoff(handoffPath, stdinHandle, workerTimeout, completionDetector, stdoutState, options);

        const resultPromise = (async (): Promise<WorkerResult> => {
          try {
            await Promise.all([readStdoutPromise, readStderrPromise, writeInitial(), watchHandoffFn()]);
            const exitCode = await proc.exited;
            workerTimeout.cancel();
            unregister();
            return buildWorkerResult(resultCtx, exitCode);
          } catch (error) {
            workerTimeout.cancel();
            return buildErrorResult(resultCtx, error);
          }
        })();

        return { result: resultPromise, stdinHandle, pid: proc.pid };
      }

      // --- Non-pipe mode: wait for completion, wrap in SpawnResult ---
      await Promise.all([readStdoutPromise, readStderrPromise]);
      const exitCode = await proc.exited;
      workerTimeout.cancel();
      unregister();

      return { result: Promise.resolve(buildWorkerResult(resultCtx, exitCode)), pid: proc.pid };
    } catch (error) {
      workerTimeout.cancel();
      return { result: Promise.resolve(buildErrorResult(resultCtx, error)) };
    }
  }
}
