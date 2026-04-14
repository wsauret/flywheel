import type { FileSink } from "bun";
import type { SpawnOptions, SpawnResult, StdinHandle } from "./spawner.js";
import type { SubprocessResult } from "../../../infra/subprocess-types.js";
import type { ChildHandle } from "./process-lifecycle.js";
import { OutputBuffer } from "../../../infra/output-buffer.js";
import { CompletionDetector } from "./completion.js";
import { NDJSONParser } from "../../../infra/ndjson-parser.js";
import { createSubprocessTimeout } from "./timeout.js";
import { createStreamReaderSet, readStream } from "./stream-readers.js";
import {
  buildSubprocessResult,
  buildErrorResult,
  type StdoutProcessorState,
  createStdoutProcessor,
  resolveHandoffPath,
  createStdinHandle,
} from "./spawn-helpers.js";

export interface RawSpawnedProcess {
  proc: { pid: number; exited: Promise<number>; kill(signal?: number): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** The raw Bun stdin sink, present when stdinPipe was requested. */
  stdinSink?: FileSink;
}

interface StreamPipelineOptions {
  /** Timeout in milliseconds for the subprocess. */
  timeoutMs: number;
  /** Spawn options forwarded from the caller. */
  spawnOptions?: SpawnOptions;
}

export function wireStreamPipeline(
  raw: RawSpawnedProcess,
  pipelineOpts: StreamPipelineOptions,
): SpawnResult {
  const options = pipelineOpts.spawnOptions;
  const timeoutMs = pipelineOpts.timeoutMs;
  const startTime = Date.now();

  // Shared infrastructure
  const subprocessTimeout = createSubprocessTimeout(timeoutMs);
  const buffer = new OutputBuffer();
  const completionDetector = new CompletionDetector();
  const ndjsonParser = new NDJSONParser(buffer);

  if (options?.onNDJSONEvent) {
    ndjsonParser.onEvent = options.onNDJSONEvent;
  }

  const rawStdoutChunks: string[] = [];
  const rawStderrChunks: string[] = [];
  const handoffPath = resolveHandoffPath(options);

  const resultCtx = {
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
  subprocessTimeout.attachProcess(raw.proc as unknown as ChildHandle);

  // Consume streams
  readers.stdout = raw.stdout.getReader();
  readers.stderr = raw.stderr.getReader();

  const readStdoutPromise = readStream(readers.stdout, rawStdoutChunks, processStdout);
  const readStderrPromise = readStream(readers.stderr, rawStderrChunks, (text) => options?.onStderr?.(text));

  // Shared result builder — awaits provided work promises, then collects exit code.
  async function awaitResult(work: Promise<void>[]): Promise<SubprocessResult> {
    try {
      await Promise.all(work);
      const exitCode = await raw.proc.exited;
      subprocessTimeout.cancel();
      return buildSubprocessResult(resultCtx, exitCode);
    } catch (error) {
      subprocessTimeout.cancel();
      return buildErrorResult(resultCtx, error);
    }
  }

  // --- Pipe mode: return early with StdinHandle, result resolves later ---
  if (usePipe) {
    const stdinSink = raw.stdinSink!;
    const stdinHandle = createStdinHandle(stdinSink, raw.proc);

    wireCompletionDetection(options!, stdinHandle, ndjsonParser, completionDetector, stdoutState);

    const writeInitial = options?.stdin
      ? writeInitialStdin(stdinSink, options.stdin, stdinHandle)
      : async () => {};
    const watchHandoffFn = watchHandoff(handoffPath, stdinHandle, subprocessTimeout, completionDetector, stdoutState, options);

    return {
      result: awaitResult([readStdoutPromise, readStderrPromise, writeInitial(), watchHandoffFn()]),
      stdinHandle,
      pid: raw.proc.pid,
    };
  }

  // --- Non-pipe mode: wait for completion, wrap in SpawnResult ---
  return { result: awaitResult([readStdoutPromise, readStderrPromise]), pid: raw.proc.pid };
}

// --- Pipe-mode helpers (inlined — single consumer, same concern as the pipeline) ---

function writeInitialStdin(
  stdinSink: FileSink,
  content: string,
  stdinHandle: StdinHandle,
): () => Promise<void> {
  const encoder = new TextEncoder();
  return async () => {
    try {
      stdinSink.write(encoder.encode(content));
      stdinSink.flush();
    } catch {
      stdinHandle.close();
    }
  };
}

function watchHandoff(
  handoffPath: string,
  stdinHandle: StdinHandle,
  subprocessTimeout: ReturnType<typeof createSubprocessTimeout>,
  completionDetector: CompletionDetector,
  state: StdoutProcessorState,
  options: SpawnOptions | undefined,
): () => Promise<void> {
  return async () => {
    if (!handoffPath) return;

    while (stdinHandle.isOpen && !subprocessTimeout.signal.aborted) {
      if (completionDetector.hasSeenCompletion) return;

      if (completionDetector.checkHandoffFile(handoffPath)) {
        if (state.onCompletionDetected) {
          state.onCompletionDetected();
          if (!options?.onTurnComplete) state.onCompletionDetected = null;
        }
        return;
      }

      await Bun.sleep(100);
    }
  };
}

function wireCompletionDetection(
  options: SpawnOptions,
  stdinHandle: StdinHandle,
  ndjsonParser: NDJSONParser,
  completionDetector: CompletionDetector,
  state: StdoutProcessorState,
): void {
  if (options.onTurnComplete) {
    const turnCallback = options.onTurnComplete;
    state.onCompletionDetected = () => {
      if (!stdinHandle.isOpen) return;
      completionDetector.reset();
      turnCallback(ndjsonParser.sessionId ?? undefined);
    };
  } else {
    state.onCompletionDetected = () => {
      if (!stdinHandle.isOpen) return;
      stdinHandle.close();
    };
  }
}
