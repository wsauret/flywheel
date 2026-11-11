# mechanism-chunked-upload: claim ground truth

Five claims: 1 and 3 are false, 2, 4, and 5 are true. Claims 2, 4, and 5 look doubtful on a skim.

## Claim 1: FALSE (label nested-retry-multiplies-attempts)

uploadFile wraps each part in `withRetry(() => api.putPart(...))` (uploader.ts:39). withRetry loops up to MAX_ATTEMPTS = 3 (retry.ts:3, retry.ts:25-30). Each attempt calls `StorageApi.putPart`, which calls `send` (api.ts:25-26). send, which existed before this change, has its own loop: it retries 502, 503, and 504 until `attempt >= GATEWAY_ATTEMPTS` (http.ts:24-25, http.ts:30-35), and only then throws `HttpError(503)`. isRetryable treats any status of 500 or above as retryable (retry.ts:10), so withRetry tries again, and each of its attempts runs the full transport loop. A part that keeps returning 503 is sent 3 x 3 = 9 times. The probe counted 9 PUTs for the failing part.

## Claim 2: TRUE (looks doubtful)

withRetry catches every error (retry.ts:28), which makes a reader suspect a 404 is retried. send throws at once for a status outside GATEWAY_STATUSES (http.ts:33-34), so the transport sends it once, and withRetry rethrows at once because `isRetryable` returns false for an HttpError whose status is not 408, 429, or 500 and above (retry.ts:10, retry.ts:29). The probe counted 1 PUT for a part that returned 404.

## Claim 3: FALSE (label limiter-returns-before-tail-settles)

runLimited starts each task, adds it to `running`, and awaits `Promise.race(running)` only when the set is full (limiter.ts:5-8). After the loop it returns (limiter.ts:9-10) without awaiting the tasks still in `running`. With N parts and concurrency C, the promise resolves after the last task has started, while up to C - 1 tasks are still uploading. uploadFile awaits runLimited (uploader.ts:42), then sorts and sends `parts` to completeUpload (uploader.ts:43-44). The parts still in flight have not reached `parts.push` (uploader.ts:40), so the assemble request lists only some parts. The probe with 3 parts, concurrency 2, and a slow third part passed 2 parts to completeUpload.

## Claim 4: TRUE (looks doubtful)

The `>=` check and the `finally` that removes a task suggest an off-by-one. Each task's `run` promise is `task().finally(() => running.delete(run))` (limiter.ts:6), so `run` settles only after its delete has run. `Promise.race(running)` (limiter.ts:8) therefore resolves after one entry has left the set, and the loop then adds one, so the set never holds more than `limit` entries. One task makes one PUT at a time, also while it sleeps in withRetry (retry.ts:30), because a sleeping task stays in the set and sends nothing. The probe with 10 parts and concurrency 3 saw at most 3 PUTs in flight.

## Claim 5: TRUE (looks doubtful)

chunkRanges loops `for (let start = 0; start < size; start += chunkSize)` and ends each range at `Math.min(start + chunkSize, size)` (uploader.ts:25-26). For size 30 and chunk 10 the starts are 0, 10, 20; the loop stops at 30 because `30 < 30` is false, so no empty range is made, and the last range ends at 30. FileSource.slice is end-exclusive (uploader.ts:8), so adjacent ranges do not overlap. The probe printed `[0,10) [10,20) [20,30)`.
