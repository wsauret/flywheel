import type { FileSink } from "bun";
import type { ProcessResult, NDJSONEvent } from "../../../../../infra/ndjson-event-types.js";

export interface RawSpawnedProcess {
  proc: { pid: number; exited: Promise<number>; kill(signal?: number): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** The raw Bun stdin sink, present when stdinPipe was requested. */
  stdinSink?: FileSink;
}

export interface StdinHandle {
  write(message: string): boolean;
  close(): void;
  readonly isOpen: boolean;
}

export interface SpawnResult {
  result: Promise<ProcessResult>;
  stdinHandle?: StdinHandle;
  pid?: number;
}

export interface ProcessSpawner {
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
  /** Spawn a raw process without consuming streams (for subprocess pooling).
   *  Optional — only implemented by spawners that support pre-warming. */
  spawnRaw?(command: string, args: string[], options?: SpawnOptions): RawSpawnedProcess;
}

export interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** If provided, write this string to the process's stdin */
  stdin?: string;
  /** Called with each decoded stdout chunk as it arrives */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives */
  onStderr?: (chunk: string) => void;
  /** External abort signal — when aborted, the process is killed as an interrupt (not a timeout) */
  signal?: AbortSignal;
  /**
   * When true AND `stdin` is provided, use a streaming stdin pipe instead
   * of pre-encoded one-shot delivery. The initial content is written
   * concurrently with stdout/stderr reads, and the pipe stays open for
   * subsequent `StdinHandle.write()` calls.
   *
   * When false or absent, preserves the current pre-encoded Uint8Array behavior.
   */
  stdinPipe?: boolean;
  /** Unique invocation ID for handoff file path construction */
  invocationId?: string;
  /** Flywheel session ID for session-scoped handoff paths */
  sessionId?: string;
  /** Explicit handoff file name (e.g., "work_step-1.json"). Overrides invocationId-based naming. */
  handoffFileName?: string;
  /**
   * Callback invoked when a turn completes (result event detected) while
   * the stdin pipe is still open. Enables the 2-tier interrupt system:
   * the shell can inject queued messages at turn boundaries instead of
   * closing the pipe.
   *
   * Only called when `stdinPipe` is true and the engine supports
   * streaming input. When not provided, the default behavior is to
   * close the stdin pipe on completion detection.
   */
  onTurnComplete?: () => void;
  /**
   * Called when session_id is first captured from the NDJSON stream.
   * Fires as soon as the init event arrives (the very first NDJSON line),
   * well before turn completion or process exit.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Called for each parsed NDJSON event (step_finish, tool_use, text, etc.).
   * Wire to BudgetTracker.handleEvent to capture cost/token data from process output.
   */
  onNDJSONEvent?: (event: NDJSONEvent) => void;
}
