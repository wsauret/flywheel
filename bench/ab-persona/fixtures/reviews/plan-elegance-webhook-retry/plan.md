{
  "schema_version": 1,
  "summary": "Retry webhook deliveries: a network failure, a 429, or a 5xx answer is retried up to 5 tries in total with doubling backoff from 500 ms; any other 4xx answer fails at once. Retries for one endpoint do not delay the other endpoints of the same event.",
  "context": {
    "key_files": [
      "src/webhooks/dispatcher.ts - deliverWebhook (one signed POST; WebhookStatusError for non-2xx).",
      "src/webhooks/fanout.ts - fanOut delivers one event to every endpoint in parallel and reports one outcome per endpoint.",
      "src/lib/retry.ts - withRetry and RetryOptions.",
      "src/email/sender.ts - sendMail.",
      "tests/fanout.test.ts, tests/retry.test.ts - Existing coverage."
    ],
    "patterns": [
      "HTTP callers take an injectable fetcher for tests.",
      "Errors carry the HTTP status as a typed field."
    ],
    "constraints": [
      "The x-relay-event-id header is sent unchanged on every retry, so receivers can de-duplicate.",
      "Each endpoint retries independently; fanOut still runs the endpoints in parallel."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Retry failed deliveries for each endpoint.",
      "files": [
        "src/webhooks/retrying-delivery.ts",
        "src/webhooks/fanout.ts",
        "tests/retrying-delivery.test.ts",
        "tests/fanout.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add src/webhooks/retrying-delivery.ts. `isRetryableWebhookError(error: unknown): boolean` returns false for a WebhookStatusError whose status is a 4xx other than 429, and true otherwise. `deliverWithRetry(endpoint, event, fetcher, sleep = Bun.sleep)` loops `for (let attempt = 0; attempt < 5; attempt++)`: it calls deliverWebhook and returns on success; on an error it rethrows when isRetryableWebhookError is false or on the last try, and otherwise awaits `sleep(500 * 2 ** attempt)` before the next try.",
          "files": [
            "src/webhooks/retrying-delivery.ts",
            "tests/retrying-delivery.test.ts"
          ],
          "test_scenarios": [
            "Two 503 answers then a 200 give three calls and success, with sleeps of 500 and 1000 ms.",
            "A 400 answer fails after one call.",
            "A 429 answer is retried.",
            "Five 500 answers give five calls and throw the last WebhookStatusError.",
            "Every try sends the same x-relay-event-id."
          ]
        },
        {
          "id": "t2",
          "description": "In fanOut, call deliverWithRetry in place of deliverWebhook. The outcome of an endpoint is ok only when one of its tries succeeded.",
          "files": [
            "src/webhooks/fanout.ts",
            "tests/fanout.test.ts"
          ],
          "test_scenarios": [
            "An endpoint that answers 500 once and then 200 reports ok.",
            "A slow retrying endpoint does not delay the outcome of a healthy endpoint's delivery."
          ]
        }
      ],
      "verification": "bun test tests/retrying-delivery.test.ts tests/fanout.test.ts",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Transient webhook failures are retried up to 5 tries with doubling backoff.",
    "Permanent 4xx failures fail at once.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Network failures, 429, and 5xx are retried up to 5 tries; other 4xx are not.",
        "completion_check": "tests/retrying-delivery.test.ts covers each class."
      }
    ]
  }
}
