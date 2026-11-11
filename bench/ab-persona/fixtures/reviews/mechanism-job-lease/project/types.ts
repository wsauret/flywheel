export type JobStatus = "queued" | "running" | "done" | "dead";

export interface Job {
  id: string;
  kind: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  /** Earliest time the job may be claimed. */
  runAfter: number;
  owner?: string;
  leaseUntil?: number;
}

export type Handler = (payload: string, signal: AbortSignal) => Promise<void>;

export interface Clock {
  now(): number;
}
