# sync-scheduler: seeded defect rationale

## double-claim-race (scheduler.ts)

start() schedules `void this.pollOnce()` every 200ms without awaiting the previous pass, so poll passes overlap whenever the limiter is saturated. Inside pollOnce, the `job.state !== "pending"` and `this.claimed.has(job.id)` checks happen before `await this.limiter.acquire()`, and the claim (`job.state = "running"; this.claimed.add(...)`) happens after it. While one pass is parked on acquire(), a second pass reads the same job, passes both checks, and parks behind it; both then claim and execute the job.

## dispose-drops-inflight-flush (write-buffer.ts)

When the flush timer fires it moves the batch out of `pending` and starts an async sink write tracked by `this.inflight`. If dispose() runs at that moment, `pending` is empty, so dispose takes the `if (this.pending.length === 0) return;` branch and resolves without awaiting `this.inflight`. The caller believes shutdown drained the buffer, exits, and the unacknowledged batch is lost.

## timeout-resets-backoff (scheduler.ts)

The JobTimeoutError branch requeues with `attempt: 0` and a fixed `backoffMs(1)` delay, justified by a plausible-sounding comment. Because the attempt counter resets on every timeout, `attempt < MAX_ATTEMPTS` can never fail on this path and backoffMs never sees a growing exponent: a permanently slow job retries forever at ~500ms-1s spacing, hammering the downstream that is timing out. Other transient failures correctly carry `job.attempt + 1` forward.

## abort-listener-leak (scheduler.ts)

execute() calls `signal.addEventListener("abort", onAbort)` on the scheduler-lifetime controller signal for every job, but `removeEventListener` only runs in the `signal.aborted` catch branch. Every successfully completed or normally failed job leaks one listener, growing without bound over the scheduler's life. Worse, when stop() finally aborts the controller, all the stale onAbort closures fire and set their long-finished jobs back to `"pending"`, so completed work reruns after restart.

## checkpoint-lost-on-stop (scheduler.ts)

markDirty() coalesces checkpoint writes behind a trailing 500ms debounce. stop() clears `checkpointTimer` as part of cleanup but never performs the final `checkpoints.save`, so every claim/finish transition inside the last debounce window is silently discarded; a graceful shutdown persists a snapshot older than the state the scheduler actually reached.
