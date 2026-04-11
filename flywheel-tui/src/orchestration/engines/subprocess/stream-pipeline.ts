/**
 * Stream pipeline wiring — consumes raw process streams and sets up the
 * full NDJSON/completion/buffer pipeline.
 *
 * Decoupled from process creation so that a process can be pre-spawned
 * (e.g., in a subprocess pool) before step-specific callbacks are known.
 */

import type { SpawnOptions, SpawnResult } from "./spawner.js";
import type { SubprocessResult } from "./schemas.js";
import { TieredBuffer } from "./buffer.js";
import { CompletionDetector } from "./completion.js";
import { NDJSONParser } from "./ndjson-parser.js";
import { createSubprocessTimeout, minutesToMs, clampTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES } from "./timeout.js";
import {
  createStreamReaderSet,
  type ResultContext,
  buildSubprocessResult,
  buildErrorResult,
  readStream,
  type StdoutProcessorState,
  createStdoutProcessor,
  resolveHandoffPath,
  createStdinHandle,
} from "./spawn-helpers.js";
import {
  writeInitialStdin,
  watchHandoff,
  wireCompletionDetection,
} from "./pipe-helpers.js";

// ---------------------------------------------------------------------------
// RawSpawnedProcess — output of process creation, input to pipeline wiring
// ---------------------------------------------------------------------------

export interface RawSpawnedProcess {
  proc: { pid: number; exited: Promise<number>; kill(signal?: number): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** The raw Bun stdin sink, present when stdinPipe was requested. */
  stdinSink?: import("bun").FileSink;
  /** Remove process from the global process registry. */
  unregister: () => void;
}

// ---------------------------------------------------------------------------
// StreamPipelineOptions
// ---------------------------------------------------------------------------

export interface StreamPipelineOptions {
  /** Timeout in milliseconds for the subprocess. */
  timeoutMs: number;
  /** Spawn options forwarded from the caller. */
  spawnOptions?: SpawnOptions;
}

// ---------------------------------------------------------------------------
// wireStreamPipeline
// ---------------------------------------------------------------------------

/**
 * Consume the raw streams of a spawned process and wire up the full
 * NDJSON parsing / completion detection / tiered buffer pipeline.
 *
 * Returns the same `SpawnResult` shape that `BunProcessSpawner.spawn()`
 * has always returned, so callers see no behaviour change.
 */
export function wireStreamPipeline(
  raw: RawSpawnedProcess,
  pipelineOpts: StreamPipelineOptions,
): SpawnResult {
  const options = pipelineOpts.spawnOptions;
  const timeoutMs = pipelineOpts.timeoutMs;
  const startTime = Date.now();

  // Shared infrastructure
  const subprocessTimeout = createSubprocessTimeout(timeoutMs);
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
    rawStdoutChunks, rawStderrChunks, subprocessTimeout,
    timeoutMs, startTime, handoffPath,
  };

  // Stream readers with abort-safe cancellation
  const readers = createStreamReaderSet(subprocessTimeout.signal);

  // Wire external abort signal
  if (options?.signal && !options.signal.aborted) {
    options.signal.addEventListener("abort", () => subprocessTimeout.interrupt(), { once: true });
  } else if (options?.signal?.aborted) {
    subprocessTimeout.interrupt();
  }

  // Stdout processing state
  const stdoutState: StdoutProcessorState = { sessionIdReported: false, onCompletionDetected: null };
  const processStdout = createStdoutProcessor(options, ndjsonParser, completionDetector, stdoutState);

  const usePipe = raw.stdinSink !== undefined;

  // Attach timeout to process
  subprocessTimeout.attachProcess(raw.proc as unknown as import("./process-lifecycle.js").ChildHandle);

  // Consume streams
  readers.stdout = raw.stdout.getReader();
  readers.stderr = raw.stderr.getReader();

  const readStdoutPromise = readStream(readers.stdout, rawStdoutChunks, processStdout);
  const readStderrPromise = readStream(readers.stderr, rawStderrChunks, (text) => options?.onStderr?.(text));

  // --- Pipe mode: return early with StdinHandle, result resolves later ---
  if (usePipe) {
    const stdinSink = raw.stdinSink!;
    const stdinHandle = createStdinHandle(stdinSink, raw.proc);

    wireCompletionDetection(options!, stdinHandle, ndjsonParser, completionDetector, stdoutState);

    const writeInitial = options?.stdin
      ? writeInitialStdin(stdinSink, options.stdin, stdinHandle)
      : async () => {};
    const watchHandoffFn = watchHandoff(handoffPath, stdinHandle, subprocessTimeout, completionDetector, stdoutState, options);

    const resultPromise = (async (): Promise<SubprocessResult> => {
      try {
        await Promise.all([readStdoutPromise, readStderrPromise, writeInitial(), watchHandoffFn()]);
        const exitCode = await raw.proc.exited;
        subprocessTimeout.cancel();
        raw.unregister();
        return buildSubprocessResult(resultCtx, exitCode);
      } catch (error) {
        subprocessTimeout.cancel();
        return buildErrorResult(resultCtx, error);
      }
    })();

    return { result: resultPromise, stdinHandle, pid: raw.proc.pid };
  }

  // --- Non-pipe mode: wait for completion, wrap in SpawnResult ---
  const resultPromise = (async (): Promise<SubprocessResult> => {
    try {
      await Promise.all([readStdoutPromise, readStderrPromise]);
      const exitCode = await raw.proc.exited;
      subprocessTimeout.cancel();
      raw.unregister();
      return buildSubprocessResult(resultCtx, exitCode);
    } catch (error) {
      subprocessTimeout.cancel();
      return buildErrorResult(resultCtx, error);
    }
  })();

  return { result: resultPromise, pid: raw.proc.pid };
}
