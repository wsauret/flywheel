# mechanism-job-lease: claim ground truth

Five claims: 1 and 2 are false, 3, 4, and 5 are true. Claims 3 and 4 look doubtful on a skim.

## Claim 1: FALSE (label renew-ignores-owner)

The worker aborts its handler only when `store.renew` resolves to false (worker.ts:30-31); a rejected renewal counts as renewed (worker.ts:28-30), so a partition lets the lease lapse while the handler keeps running. The reaper then requeues the job (reaper.ts:7-8, store.ts:66-72) and worker B claims it, which sets status running, owner B, and a new lease (store.ts:23-25). When A's next heartbeat reaches the store, `renew` checks only `job.status !== "running"` (store.ts:33). It takes no worker id and never compares `job.owner`, so it extends B's lease and returns true (store.ts:34-35). A does not abort. A learns nothing until B's run ends and the status leaves running, so both handlers run for B's whole run, not for one heartbeat interval after the partition heals. complete and fail do compare `job.owner` with the caller (store.ts:40, store.ts:49), so when A finally aborts, its `fail` changes nothing and B's completed job stays done; the missing check is only in renew. The claim measures from the first heartbeat that reaches the store, so the rule that a rejected renewal RPC counts as renewed (worker.ts:28-30) is not by itself a reason to refute it. The probe partitioned A, reaped, let B run for 120 ms with heartbeats every 10 ms, and recorded `A start | B start | B end | A aborted`.

## Claim 2: FALSE (label reaper-requeue-skips-attempts)

`attempts` is incremented only in `fail` (store.ts:47-51), and the only caller of fail is the worker's catch block (worker.ts:38-39), which passes its own worker id. A crashed worker process runs no catch block. Its job's lease expires and the reaper calls `requeueIfExpired`, which sets status queued and clears owner and lease (store.ts:66-72) but leaves `attempts` unchanged and never compares it with any maximum. claim selects any queued job whose runAfter has passed (store.ts:20). A job that crashes its worker every time is claimed forever and never becomes dead. The probe ran 10 crash cycles with maxAttempts 3: 10 claims, attempts 0, status queued.

## Claim 3: TRUE (looks doubtful)

claim is async and reads all jobs before it updates one (store.ts:17-27), which looks like a check-then-act race. The method body contains no await, and the class comment (store.ts:3-5) states that the queue service runs each RPC call to completion on one event loop. The selection and the update `status = "running"` (store.ts:23) therefore run in one synchronous turn, and a second claim sees the job as running. The probe made two concurrent claims for one job; one got `job-1`, the other got undefined.

## Claim 4: TRUE (looks doubtful)

reapExpired lists candidates first and requeues them later, after an await (reaper.ts:7-8), so a completion can land in between. requeueIfExpired checks the state again when it runs: it returns false unless the job is still running with a lease that has passed (store.ts:68). complete sets status done (store.ts:41), so a completed job fails that check. expiredLeases also lists only running jobs (store.ts:60). The probe listed the job, completed it, then called requeueIfExpired: false, and the job stayed done.

## Claim 5: TRUE

When the handler throws, the worker calls `fail(job.id, now, backoffMs(job.attempts), ...)` (worker.ts:38-39). fail sets `runAfter = now + delayMs` (store.ts:52) and status queued or dead (store.ts:51). claim requires `job.runAfter <= now` (store.ts:20). With attempts 0 the backoff is 1000 ms (worker.ts:9-10). The probe could not claim the job at +999 ms and claimed it at +1000 ms.
