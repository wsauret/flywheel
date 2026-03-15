import type { WorkerResult } from "../schemas/worker";

/**
 * DI seam for worker process spawning.
 * Allows tests to substitute a mock spawner.
 */
export interface ProcessSpawner {
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<WorkerResult>;
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
}
