# plan-elegance-webhook-retry: seeded defect rationale

## hand-rolled-retry-loop (phase-1/t1)

src/lib/retry.ts already owns the project's retry policy: `withRetry(operation, { attempts, baseDelayMs, isRetryable, sleep })` tries up to `attempts` times, throws at once for an error `isRetryable` rejects, doubles the delay from `baseDelayMs` with jitter, and throws the last error when the tries run out. `sendMail` uses it with a status-based predicate, which is the exact shape the webhook needs. The plan writes a second loop with the same control flow (try, classify, rethrow on the last try, sleep `500 * 2 ** attempt`), so the project would hold two retry implementations that already differ (the new one has no jitter). The plan looks deliberate because the loop is described precisely and well tested, and `isRetryableWebhookError` is a real, needed piece; only the loop around it duplicates the project. The elegant `deliverWithRetry` is one `withRetry` call with `attempts: 5`, `baseDelayMs: 500`, and `isRetryable: isRetryableWebhookError`.

## What is intended

- `isRetryableWebhookError` is the webhook-specific policy (429 and 5xx retry, other 4xx fail), and it has a home next to the delivery code.
- The sleeps of 500 and 1000 ms in the test scenario match the doubling schedule from 500 ms; with withRetry the test injects `sleep` the same way and checks each delay against its jitter band (500 to 600 ms, then 1000 to 1200 ms).
- Keeping the per-endpoint retry inside the `fanOut` map keeps one endpoint's backoff from delaying the others, which is the stated constraint.
- Retrying a network failure is correct: deliverWebhook rejects from fetch for it, and that error is not a WebhookStatusError.
