export type JobState = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  payload: unknown;
  state: JobState;
  /** Number of completed execution attempts. */
  attempt: number;
  /** Epoch ms before which the job must not run. */
  runAt: number;
}

export interface JobStore {
  /** Jobs whose runAt is at or before `now`, oldest first. */
  listDue(now: number): readonly Job[];
  save(job: Job): void;
}

export interface JobResultSink {
  writeAll(records: readonly JobRecord[]): Promise<void>;
}

export interface JobRecord {
  jobId: string;
  state: JobState;
  attempt: number;
  finishedAt: number;
}

export interface CheckpointStore {
  save(snapshot: SchedulerSnapshot): Promise<void>;
}

export interface SchedulerSnapshot {
  claimedIds: readonly string[];
  savedAt: number;
}

export interface RateLimiter {
  /** Resolves when a run slot is available. */
  acquire(): Promise<void>;
  release(): void;
}

export class TransientJobError extends Error {
  readonly transient = true;
}

export class JobTimeoutError extends Error {
  readonly transient = true;
}

export function isTransient(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "transient") === true;
}
