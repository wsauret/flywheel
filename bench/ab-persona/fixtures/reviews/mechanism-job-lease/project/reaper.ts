import type { JobStore } from "./store.ts";

/** Return jobs whose worker stopped renewing to the queue, so a crashed
 *  worker does not strand its job. Runs every few seconds in the service. */
export async function reapExpired(store: JobStore, now: number): Promise<number> {
  let requeued = 0;
  for (const jobId of await store.expiredLeases(now)) {
    if (await store.requeueIfExpired(jobId, now)) requeued++;
  }
  return requeued;
}
