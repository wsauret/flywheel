import type { SubprocessResult } from "../../../infra/subprocess-types";

// ---------------------------------------------------------------------------
// StdinHandle — mid-execution stdin injection
// ---------------------------------------------------------------------------

/**
 * Handle to a running process's stdin pipe.
 * Allows writing additional content after the initial prompt delivery.
 */
export interface StdinHandle {
  /** Write additional content to the running process's stdin. Returns false if pipe is closed. */
  write(message: string): boolean;
  /** Close the stdin pipe (signals EOF). Idempotent. */
  close(): void;
  /** Interrupt the current turn without destroying the session. SDK-only. */
  interrupt?(): void;
  /** Whether the pipe is still open */
  readonly isOpen: boolean;
}

/**
 * Result of `ProcessSpawner.spawn()`.
 *
 * - `result` is a Promise that resolves when the process completes.
 * - `stdinHandle` is present when `stdinPipe` was requested, giving
 *   early access to write to the process before it finishes.
 */
export interface SpawnResult {
  result: Promise<SubprocessResult>;
  stdinHandle?: StdinHandle;
  /** PID of the spawned process (when available). */
  pid?: number;
}

// ---------------------------------------------------------------------------
// ProcessSpawner — DI seam
// ---------------------------------------------------------------------------

/**
 * DI seam for subprocess spawning.
 * Allows tests to substitute a mock spawner.
 */
export interface ProcessSpawner {
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
  /** Spawn a raw process without consuming streams (for subprocess pooling).
   *  Optional — only implemented by spawners that support pre-warming. */
  spawnRaw?(command: string, args: string[], options?: SpawnOptions): import("./stream-pipeline").RawSpawnedProcess;
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
   * streaming input. The sessionId is extracted from the NDJSON output.
   *
   * When not provided, the default behavior is to close the stdin pipe
   * on completion detection (current behavior).
   */
  onTurnComplete?: (sessionId: string | undefined) => void;
  /**
   * Called when session_id is first captured from the NDJSON stream.
   * Fires as soon as the init event arrives (the very first NDJSON line),
   * well before turn completion or process exit.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Optional transform applied to raw stdout text before it reaches
   * the NDJSON parser, completion detector, and onStdout callback.
   *
   * Used by the Droid engine to translate JSON-RPC envelopes into flat
   * NDJSON that the existing pipeline expects. Returns the transformed
   * text, or empty string to suppress the chunk entirely.
   */
  stdoutTransform?: (chunk: string) => string;
  /**
   * Called for each parsed NDJSON event (step_finish, tool_use, text, etc.).
   * Wire to BudgetTracker.handleEvent to capture cost/token data from subprocess output.
   */
  onNDJSONEvent?: (event: import("../../../infra/subprocess-types").NDJSONEvent) => void;
}
