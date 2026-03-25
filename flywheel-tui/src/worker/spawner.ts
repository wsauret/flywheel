import type { WorkerResult } from "../schemas/worker";

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
  result: Promise<WorkerResult>;
  stdinHandle?: StdinHandle;
  /** PID of the spawned process (when available). */
  pid?: number;
}

// ---------------------------------------------------------------------------
// ProcessSpawner — DI seam
// ---------------------------------------------------------------------------

/**
 * DI seam for worker process spawning.
 * Allows tests to substitute a mock spawner.
 */
export interface ProcessSpawner {
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult>;
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
}
