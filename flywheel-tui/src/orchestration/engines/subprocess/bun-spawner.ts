/**
 * BunProcessSpawner — implements ProcessSpawner using Bun.spawn().
 *
 * Process creation is separated from stream pipeline wiring:
 * - `spawnRaw()` creates the process and returns raw handles (streams unconsumed)
 * - `wireStreamPipeline()` (in stream-pipeline.ts) consumes streams and wires callbacks
 * - `spawn()` composes both for backward-compatible behavior
 *
 * This separation enables subprocess pooling — processes can be pre-spawned before
 * step-specific callbacks are known.
 *
 * Stdin modes:
 * - Pre-encoded delivery (Uint8Array): default when `stdin` is provided without `stdinPipe`
 * - Streaming pipe: when `stdinPipe: true` — returns StdinHandle for mid-execution writes
 * - Ignore: when no `stdin` is provided
 *
 * Features:
 * - Shell metacharacter validation on all spawn args
 * - Bun.which() command resolution with graceful fallbacks
 * - Global process registry with clean entry removal on exit
 * - Integrates: env-filter, process-lifecycle
 */

import type { ProcessSpawner, SpawnOptions, SpawnResult } from "./spawner.js";
import { createEnvFilter, type EnvFilterOptions } from "./env-filter.js";
import { registerProcess, type ChildHandle } from "./process-lifecycle.js";
import { clampTimeoutMinutes, minutesToMs, DEFAULT_TIMEOUT_MINUTES } from "./timeout.js";
import { validateSpawnArgs, resolveCommandExecutable } from "./spawn-helpers.js";
import { wireStreamPipeline, type RawSpawnedProcess } from "./stream-pipeline.js";

// BunSpawnerOptions

export interface BunSpawnerOptions {
  /** Environment filter configuration. */
  envFilter?: EnvFilterOptions;
  /** Timeout in minutes (1-120, default 60). */
  timeoutMinutes?: number;
}

// BunProcessSpawner

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

  /**
   * Create a raw process without consuming its streams.
   *
   * Returns handles suitable for later pipeline wiring or subprocess pooling.
   * The stdout and stderr ReadableStreams are NOT consumed — the caller
   * (or `wireStreamPipeline`) is responsible for reading them.
   */
  spawnRaw(command: string, args: string[], options?: SpawnOptions): RawSpawnedProcess {
    validateSpawnArgs(command, args);
    const executable = resolveCommandExecutable(command);

    // Filter environment variables
    const baseEnv = options?.env ?? (process.env as Record<string, string>);
    const filteredEnv = this.envFilter.filter(baseEnv);

    // Determine stdin mode
    const usePipe = options?.stdinPipe === true;
    const stdinEncoded = !usePipe && options?.stdin !== undefined
      ? new TextEncoder().encode(options.stdin)
      : undefined;

    const proc = Bun.spawn([executable, ...args], {
      cwd: options?.cwd,
      env: filteredEnv,
      stdin: usePipe ? "pipe" : (stdinEncoded ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
    });

    const unregister = registerProcess(proc as unknown as ChildHandle);

    return {
      proc: proc as unknown as RawSpawnedProcess["proc"],
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: proc.stderr as unknown as ReadableStream<Uint8Array>,
      stdinSink: usePipe ? proc.stdin as import("bun").FileSink : undefined,
      unregister,
    };
  }

  /**
   * Spawn a process and wire the full stream pipeline.
   *
   * Equivalent to the pre-refactor `spawn()` — creates the process,
   * then immediately wires NDJSON parsing, completion detection, output
   * buffering, and all caller callbacks.
   */
  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    try {
      const raw = this.spawnRaw(command, args, options);
      return wireStreamPipeline(raw, { timeoutMs, spawnOptions: options });
    } catch (error) {
      // Match the original error-handling: validation / spawn failures
      // are wrapped in a resolved SpawnResult with an error SubprocessResult.
      const { buildErrorResult } = await import("./spawn-helpers.js");
      const { OutputBuffer } = await import("../../../infra/output-buffer.js");
      const { CompletionDetector } = await import("./completion.js");
      const { NDJSONParser } = await import("../../../infra/ndjson-parser.js");
      const { createSubprocessTimeout } = await import("./timeout.js");
      const { resolveHandoffPath } = await import("./spawn-helpers.js");

      const buffer = new OutputBuffer();
      const subprocessTimeout = createSubprocessTimeout(timeoutMs);
      const resultCtx = {
        ndjsonParser: new NDJSONParser(buffer),
        buffer,
        completionDetector: new CompletionDetector(),
        rawStdoutChunks: [] as string[],
        rawStderrChunks: [] as string[],
        subprocessTimeout,
        timeoutMs,
        startTime: Date.now(),
        handoffPath: resolveHandoffPath(options),
      };
      subprocessTimeout.cancel();
      return { result: Promise.resolve(buildErrorResult(resultCtx, error)) };
    }
  }
}
