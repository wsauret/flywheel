/**
 * Helper functions and types extracted from bun-spawner.ts for SRP.
 *
 * Contains: argument validation, stream readers, result builders,
 * stdout processing, handoff resolution, and stdin handle creation.
 */

import * as path from "node:path";
import type { SpawnOptions, StdinHandle } from "./spawner.js";
import type { SubprocessResult } from "../../../infra/subprocess-types.js";
import type { TieredBuffer } from "../../../infra/tiered-buffer.js";
import type { CompletionDetector } from "./completion.js";
import type { NDJSONParser } from "../../../infra/ndjson-parser.js";
import { categorizeFailure } from "./errors.js";
import { createSubprocessTimeout } from "./timeout.js";
import { resolveSessionHandoffsDir } from "../../../infra/paths.js";
import { errorMessage } from "../../../infra/error-message.js";

// Argument validation

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

// Signal detection

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
  return exitCode === 130   // SIGINT (Ctrl+C)
      || exitCode === 143   // SIGTERM
      || exitCode === 137;  // SIGKILL
}

// Command resolution

/**
 * Resolve a command name to its full executable path using Bun.which().
 *
 * - If the command contains a path separator (/ or \), return as-is
 * - Try Bun.which() for PATH resolution (wrapped in try/catch since it can throw)
 * - Fallback: for 'bun' command, use process.execPath
 * - Otherwise return the command unchanged (let Bun.spawn handle it)
 */
export function resolveCommandExecutable(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  try {
    const resolved = Bun.which(command);
    if (resolved) return resolved;
  } catch {
    // Bun.which() can throw — fall through to fallbacks
  }

  if (command === "bun" && typeof process.execPath === "string" && process.execPath.length > 0) {
    return process.execPath;
  }

  return command;
}

// Stream reader types and helpers

/** Minimal reader interface that avoids Bun's non-standard ReadableStreamDefaultReader extensions. */
export type MinimalReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

/** Manages paired stdout/stderr readers with abort-safe cancellation. */
export interface StreamReaderSet {
  stdout: MinimalReader | null;
  stderr: MinimalReader | null;
  cancelAll(): void;
}

export function createStreamReaderSet(signal: AbortSignal): StreamReaderSet {
  const set: StreamReaderSet = {
    stdout: null,
    stderr: null,
    cancelAll() {
      for (const key of ["stdout", "stderr"] as const) {
        const reader = set[key];
        if (reader) {
          try { reader.cancel().catch(() => {}); } catch { /* reader may already be released */ }
          set[key] = null;
        }
      }
    },
  };

  if (!signal.aborted) {
    signal.addEventListener("abort", () => set.cancelAll(), { once: true });
  }

  return set;
}

// Result builders

export interface ResultContext {
  ndjsonParser: NDJSONParser;
  buffer: TieredBuffer;
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

  const tier1 = ctx.buffer.getTier1();
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
    rawOutput: ctx.rawStdoutChunks.join(""),
    rawStderr: stderrContent,
    exitCode,
    truncated: ctx.buffer.truncated,
    durationMs,
    failure,
    sessionId: ctx.ndjsonParser.sessionId ?? undefined,
    handoffPath: ctx.handoffPath,
  };
}

export function buildErrorResult(ctx: ResultContext, error: unknown): SubprocessResult {
  const durationMs = Date.now() - ctx.startTime;
  return {
    output: ctx.buffer.getTier1().content,
    rawOutput: ctx.rawStdoutChunks.join(""),
    rawStderr: ctx.rawStderrChunks.join(""),
    exitCode: -1,
    truncated: ctx.buffer.truncated,
    durationMs,
    failure: {
      kind: "transient",
      message: errorMessage(error),
    },
    handoffPath: ctx.handoffPath,
  };
}

// Stream reading

/**
 * Read a stream to completion, collecting raw chunks and invoking callbacks.
 * Generic for both stdout and stderr; stdout passes extra processing via `onChunk`.
 */
export async function readStream(
  reader: MinimalReader,
  chunks: string[],
  onChunk?: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      onChunk?.(text);
    }
    const remaining = decoder.decode(undefined, { stream: false });
    if (remaining) {
      chunks.push(remaining);
      onChunk?.(remaining);
    }
  } catch {
    // Stream may be closed due to process kill or reader cancellation
  }
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
  stdinSink: import("bun").FileSink,
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
