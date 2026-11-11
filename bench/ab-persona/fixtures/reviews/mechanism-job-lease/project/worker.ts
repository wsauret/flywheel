import type { JobStore } from "./store.ts";
import type { Clock, Handler } from "./types.ts";

export interface WorkerOptions {
  leaseMs: number;
  maxAttempts: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** attempts);
}

/** Claim and run one job. Returns false when no job was runnable.
 *
 *  The heartbeat renews the lease three times per lease period. When a renewal
 *  reports that the job is no longer ours, the handler is aborted. */
export async function runOne(
  store: JobStore,
  workerId: string,
  handlers: Record<string, Handler>,
  clock: Clock,
  options: WorkerOptions,
): Promise<boolean> {
  const job = await store.claim(workerId, clock.now(), options.leaseMs);
  if (job === undefined) return false;
  const controller = new AbortController();
  const heartbeat = setInterval(async () => {
    // A failed RPC is not proof that the lease is gone; keep working and
    // let the next beat try again.
    const renewed = await store.renew(job.id, clock.now(), options.leaseMs).catch(() => true);
    if (!renewed) controller.abort();
  }, options.leaseMs / 3);
  try {
    const handler = handlers[job.kind];
    if (handler === undefined) throw new Error(`no handler for ${job.kind}`);
    await handler(job.payload, controller.signal);
    await store.complete(job.id, workerId);
  } catch {
    await store.fail(job.id, workerId, clock.now(), backoffMs(job.attempts), options.maxAttempts);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
