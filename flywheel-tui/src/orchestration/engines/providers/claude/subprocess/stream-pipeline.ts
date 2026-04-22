import type { FileSink } from "bun";
import type { SpawnOptions, SpawnResult, StdinHandle, RawSpawnedProcess } from "./spawner.js";
import type { ProcessResult } from "../../../../../infra/ndjson-event-types.js";
import { OutputBuffer } from "../../../../../infra/output-buffer.js";
import { CompletionDetector } from "./completion.js";
import { NDJSONParser } from "../../../../../infra/ndjson-parser.js";
import { createSubprocessTimeout } from "./timeout.js";
import { createStreamReaderSet, readStream } from "./stream-readers.js";
import {
  buildProcessResult,
  buildErrorResult,
  createStdoutProcessor,
  resolveHandoffPath,
  createStdinHandle,
} from "./spawn-helpers.js";

interface StreamPipelineOptions {
  timeoutMs: number;
  spawnOptions?: SpawnOptions;
}

export function wireStreamPipeline(
  raw: RawSpawnedProcess,
  pipelineOpts: StreamPipelineOptions,
): SpawnResult {
  const options = pipelineOpts.spawnOptions;
  const timeoutMs = pipelineOpts.timeoutMs;
  const startTime = Date.now();

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

  const readers = createStreamReaderSet(subprocessTimeout.signal);

  if (options?.signal && !options.signal.aborted) {
    options.signal.addEventListener("abort", () => subprocessTimeout.interrupt(), { once: true });
  } else if (options?.signal?.aborted) {
    subprocessTimeout.interrupt();
  }

  let completionCallback: (() => void) | null = null;
  const persistent = !!options?.onTurnComplete;
  function fireCompletion(): void {
    if (!completionCallback) return;
    completionCallback();
    if (!persistent) completionCallback = null;
  }

  const processStdout = createStdoutProcessor(options, ndjsonParser, completionDetector, fireCompletion);

  const usePipe = raw.stdinSink !== undefined;

  subprocessTimeout.attachProcess(raw.proc);

  readers.stdout = raw.stdout.getReader();
  readers.stderr = raw.stderr.getReader();

  const readStdoutPromise = readStream(readers.stdout, rawStdoutChunks, processStdout);
  const readStderrPromise = readStream(readers.stderr, rawStderrChunks, (text) => options?.onStderr?.(text));

  async function awaitResult(work: Promise<void>[]): Promise<ProcessResult> {
    try {
      await Promise.all(work);
      const exitCode = await raw.proc.exited;
      subprocessTimeout.cancel();
      return buildProcessResult(resultCtx, exitCode);
    } catch (error) {
      subprocessTimeout.cancel();
      return buildErrorResult(resultCtx, error);
    }
  }

  if (usePipe) {
    const stdinSink = raw.stdinSink!;
    const stdinHandle = createStdinHandle(stdinSink, raw.proc);

    wireCompletionDetection(options!, stdinHandle, completionDetector, (cb) => { completionCallback = cb; });

    const writeInitial = options?.stdin
      ? writeInitialStdin(stdinSink, options.stdin, stdinHandle)
      : async () => {};
    const watchHandoffFn = watchHandoff(handoffPath, stdinHandle, subprocessTimeout, completionDetector, fireCompletion);

    return {
      result: awaitResult([readStdoutPromise, readStderrPromise, writeInitial(), watchHandoffFn()]),
      stdinHandle,
      pid: raw.proc.pid,
    };
  }

  return { result: awaitResult([readStdoutPromise, readStderrPromise]), pid: raw.proc.pid };
}


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
  fireCompletion: () => void,
): () => Promise<void> {
  return async () => {
    if (!handoffPath) return;

    while (stdinHandle.isOpen && !subprocessTimeout.signal.aborted) {
      if (completionDetector.hasSeenCompletion) return;

      if (completionDetector.checkHandoffFile(handoffPath)) {
        fireCompletion();
        return;
      }

      await Bun.sleep(100);
    }
  };
}

function wireCompletionDetection(
  options: SpawnOptions,
  stdinHandle: StdinHandle,
  completionDetector: CompletionDetector,
  setCallback: (cb: () => void) => void,
): void {
  if (options.onTurnComplete) {
    const turnCallback = options.onTurnComplete;
    setCallback(() => {
      if (!stdinHandle.isOpen) return;
      completionDetector.reset();
      turnCallback();
    });
  } else {
    setCallback(() => {
      if (!stdinHandle.isOpen) return;
      stdinHandle.close();
    });
  }
}
