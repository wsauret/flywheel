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
}
