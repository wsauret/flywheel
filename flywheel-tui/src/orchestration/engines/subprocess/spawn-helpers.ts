/**
 * Subprocess pipeline helpers: result building, stdout processing,
 * handoff resolution, and stdin handle creation.
 */

import * as path from "node:path";
import type { FileSink } from "bun";
import type { SpawnOptions, StdinHandle } from "./spawner.js";
import type { SubprocessResult } from "../../../infra/subprocess-types.js";
import type { OutputBuffer } from "../../../infra/output-buffer.js";
import type { CompletionDetector } from "./completion.js";
import type { NDJSONParser } from "../../../infra/ndjson-parser.js";
import { categorizeFailure } from "./errors.js";
import { createSubprocessTimeout } from "./timeout.js";
import { resolveSessionHandoffsDir } from "../../../infra/paths.js";
import { errorMessage } from "../../../infra/error-message.js";

function isSignalExit(exitCode: number): boolean {
  return exitCode === 130 || exitCode === 143 || exitCode === 137;
}

// Result builders

interface ResultContext {
  ndjsonParser: NDJSONParser;
  buffer: OutputBuffer;
  completionDetector: CompletionDetector;
  rawStdoutChunks: string[];
  rawStderrChunks: string[];
  subprocessTimeout: ReturnType<typeof createSubprocessTimeout>;
  timeoutMs: number;
  startTime: number;
  handoffPath: string;
}

export function buildSubprocessResult(ctx: ResultContext, exitCode: number): SubprocessResult {
  ctx.ndjsonParser.flush();

  const interrupted = ctx.subprocessTimeout.interrupted || isSignalExit(exitCode);

  const tier1 = ctx.buffer.getState();
  ctx.completionDetector.checkFallback(tier1.content);

  const durationMs = Date.now() - ctx.startTime;
  const stderrContent = ctx.rawStderrChunks.join("");

  const failure = categorizeFailure({
    exitCode,
    stdout: tier1.content,
    stderr: stderrContent,
    timedOut: ctx.subprocessTimeout.timedOut,
    timeoutMs: ctx.timeoutMs,
    completionDetected: ctx.completionDetector.hasSeenCompletion,
    interrupted,
  });

  return {
    output: tier1.content,
    exitCode,
    truncated: ctx.buffer.getState().truncated,
    durationMs,
    failure,
    sessionId: ctx.ndjsonParser.sessionId ?? undefined,
    handoffPath: ctx.handoffPath,
  };
}

export function buildErrorResult(ctx: ResultContext, error: unknown): SubprocessResult {
  const durationMs = Date.now() - ctx.startTime;
  return {
    output: ctx.buffer.getState().content,
    exitCode: -1,
    truncated: ctx.buffer.getState().truncated,
    durationMs,
    failure: {
      kind: "transient",
      message: errorMessage(error),
    },
    handoffPath: ctx.handoffPath,
  };
}

// Stdout processing

/** Stdout processing state for the readStdout pipeline. */
export interface StdoutProcessorState {
  sessionIdReported: boolean;
  onCompletionDetected: (() => void) | null;
}

export function createStdoutProcessor(
  options: SpawnOptions | undefined,
  ndjsonParser: NDJSONParser,
  completionDetector: CompletionDetector,
  state: StdoutProcessorState,
): (text: string) => void {
  const transform = options?.stdoutTransform;

  return (rawText: string) => {
    const text = transform ? transform(rawText) : rawText;
    if (!text) return;

    options?.onStdout?.(text);
    ndjsonParser.write(text);

    if (!state.sessionIdReported && ndjsonParser.sessionId && options?.onSessionId) {
      options.onSessionId(ndjsonParser.sessionId);
      state.sessionIdReported = true;
    }

    const wasDetected = completionDetector.hasSeenCompletion;
    completionDetector.check(text);
    if (!wasDetected && completionDetector.hasSeenCompletion && state.onCompletionDetected) {
      state.onCompletionDetected();
      if (!options?.onTurnComplete) state.onCompletionDetected = null;
    }
  };
}

// Handoff path resolution

export function resolveHandoffPath(options: SpawnOptions | undefined): string {
  if (options?.sessionId && options?.handoffFileName) {
    return path.resolve(
      resolveSessionHandoffsDir(options.sessionId, options.cwd ?? process.cwd()),
      options.handoffFileName,
    );
  }
  if (options?.invocationId && options?.sessionId) {
    return path.resolve(
      resolveSessionHandoffsDir(options.sessionId, options.cwd ?? process.cwd()),
      `${options.invocationId}.json`,
    );
  }
  return "";
}

// Stdin handle (pipe mode)

export function createStdinHandle(
  stdinSink: FileSink,
  proc: { exited: Promise<number> },
): StdinHandle {
  const encoder = new TextEncoder();
  let pipeOpen = true;

  const onExit = () => { pipeOpen = false; };
  proc.exited.then(onExit, onExit);

  return {
    write(message: string): boolean {
      if (!pipeOpen) return false;
      try {
        stdinSink.write(encoder.encode(message));
        stdinSink.flush();
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
}
