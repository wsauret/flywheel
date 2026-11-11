import type { Job } from "./types.ts";

/** Job state, owned by the queue service process. Workers run in other
 *  processes and call these methods over RPC; the service runs each call to
 *  completion on its single event loop before it starts the next one. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private nextId = 1;

  async enqueue(kind: string, payload: string, now: number): Promise<string> {
    const id = `job-${this.nextId++}`;
    this.jobs.set(id, { id, kind, payload, status: "queued", attempts: 0, runAfter: now });
    return id;
  }

  /** Lease the oldest runnable job to `workerId`, or return undefined. */
  async claim(workerId: string, now: number, leaseMs: number): Promise<Job | undefined> {
    let oldest: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.status === "queued" && job.runAfter <= now && (oldest === undefined || job.runAfter < oldest.runAfter)) oldest = job;
    }
    if (oldest === undefined) return undefined;
    oldest.status = "running";
    oldest.owner = workerId;
    oldest.leaseUntil = now + leaseMs;
    return { ...oldest };
  }

  /** Extend a running job's lease. Returns false when the job is no longer
   *  running, so the caller knows it has lost the job. */
  async renew(jobId: string, now: number, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.status !== "running") return false;
    job.leaseUntil = now + leaseMs;
    return true;
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.owner !== workerId) return;
    job.status = "done";
    job.owner = undefined;
  }

  /** Record a failed run by the job's owner. The job runs again after
   *  `delayMs`, or is marked dead once it has failed `maxAttempts` times. */
  async fail(jobId: string, workerId: string, now: number, delayMs: number, maxAttempts: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.owner !== workerId) return;
    job.attempts++;
    job.status = job.attempts >= maxAttempts ? "dead" : "queued";
    job.runAfter = now + delayMs;
    job.owner = undefined;
    job.leaseUntil = undefined;
  }

  async expiredLeases(now: number): Promise<string[]> {
    const ids: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.leaseUntil !== undefined && job.leaseUntil < now) ids.push(job.id);
    }
    return ids;
  }

  /** Return a job to the queue if its lease is still expired. */
  async requeueIfExpired(jobId: string, now: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.status !== "running" || job.leaseUntil === undefined || job.leaseUntil >= now) return false;
    job.status = "queued";
    job.owner = undefined;
    job.leaseUntil = undefined;
    return true;
  }

  async get(jobId: string): Promise<Job | undefined> {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : { ...job };
  }
}
