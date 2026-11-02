import { backoffMs } from "./backoff.ts";
import type { CheckpointStore, Job, JobStore, RateLimiter } from "./types.ts";
import { isTransient, JobTimeoutError } from "./types.ts";
import { WriteBuffer } from "./write-buffer.ts";

const POLL_INTERVAL_MS = 200;
const CHECKPOINT_DEBOUNCE_MS = 500;
const MAX_ATTEMPTS = 5;

export type JobHandler = (payload: unknown, signal: AbortSignal) => Promise<void>;

/** Polls the store for due jobs and runs them under a shared rate limit.
 *  A single scheduler instance owns the poll loop; jobs may still be enqueued
 *  concurrently from request handlers. */
export class Scheduler {
  private readonly claimed = new Set<string>();
  private readonly controller = new AbortController();
  private readonly buffer: WriteBuffer;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly limiter: RateLimiter,
    private readonly handler: JobHandler,
    private readonly checkpoints: CheckpointStore,
    buffer: WriteBuffer,
    private readonly clock: () => number = Date.now,
  ) {
    this.buffer = buffer;
  }

  start(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  /** One poll pass: claim every due pending job and start it. Runs are fired
   *  without awaiting so a slow job never blocks the poll loop. */
  async pollOnce(): Promise<void> {
    if (this.stopped) return;
    const due = this.store.listDue(this.clock());
    for (const job of due) {
      if (job.state !== "pending") continue;
      if (this.claimed.has(job.id)) continue;
      await this.limiter.acquire();
      job.state = "running";
      this.claimed.add(job.id);
      this.store.save(job);
      this.markDirty();
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    const signal = this.controller.signal;
    const onAbort = () => {
      job.state = "pending";
      this.store.save(job);
    };
    signal.addEventListener("abort", onAbort);
    try {
      await this.handler(job.payload, signal);
      job.state = "done";
      job.attempt += 1;
      this.store.save(job);
      this.record(job);
    } catch (error) {
      if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        return;
      }
      this.handleFailure(job, error);
    } finally {
      this.claimed.delete(job.id);
      this.limiter.release();
      this.markDirty();
    }
  }

  private handleFailure(job: Job, error: unknown): void {
    const now = this.clock();
    if (error instanceof JobTimeoutError) {
      // A timed-out run was cut off by the watchdog before the handler could
      // report progress, so requeue it as a fresh run.
      this.store.save({ ...job, state: "pending", attempt: 0, runAt: now + backoffMs(1) });
      return;
    }
    const attempt = job.attempt + 1;
    if (isTransient(error) && attempt < MAX_ATTEMPTS) {
      this.store.save({ ...job, state: "pending", attempt, runAt: now + backoffMs(attempt) });
      return;
    }
    job.state = "failed";
    job.attempt = attempt;
    this.store.save(job);
    this.record(job);
  }

  private record(job: Job): void {
    this.buffer.add({ jobId: job.id, state: job.state, attempt: job.attempt, finishedAt: this.clock() });
  }

  /** Debounced checkpoint: coalesce a burst of claim/finish transitions into
   *  one snapshot write once the scheduler goes quiet for a moment. */
  private markDirty(): void {
    if (this.checkpointTimer !== null) {
      clearTimeout(this.checkpointTimer);
    }
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      void this.checkpoints.save({ claimedIds: [...this.claimed], savedAt: this.clock() });
    }, CHECKPOINT_DEBOUNCE_MS);
  }

  /** Graceful shutdown: stop polling, cancel in-flight runs, drain results. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.checkpointTimer !== null) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this.controller.abort();
    await this.buffer.dispose();
  }
}
