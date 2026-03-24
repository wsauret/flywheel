/**
 * Core type definitions for the task queue system.
 */

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TaskOptions {
  /** Task name for identification */
  name: string;
  /** Priority (lower = higher priority). Default: 10 */
  priority?: number;
  /** Maximum execution time in milliseconds */
  timeoutMs?: number;
  /** Number of retry attempts on failure */
  retries?: number;
  /** Tags for filtering and grouping */
  tags?: string[];
}

export interface Task<T = unknown> {
  id: string;
  options: TaskOptions;
  handler: () => Promise<T>;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: T;
  error?: Error;
  attempts: number;
}

export interface TaskResult<T = unknown> {
  taskId: string;
  taskName: string;
  status: "completed" | "failed";
  result?: T;
  error?: Error;
  durationMs: number;
  attempts: number;
}

export interface QueueConfig {
  /** Maximum concurrent tasks. Default: 1 */
  concurrency: number;
  /** Whether to start processing immediately. Default: false */
  autoStart?: boolean;
  /** Global timeout per task in ms. Default: 30000 */
  defaultTimeoutMs?: number;
}
