# elegance-retry-transport: control

This fixture seeds no defect. It is a clean change that contains things a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "RetryingTransport is a wrapper around Transport." It is a decorator that adds a real capability (retry, backoff with jitter, Retry-After, and the idempotency rule) behind the existing `Transport` interface, so `IngestClient` gains retries without changing, and `FetchTransport` stays a plain adapter. Removing it removes behavior.
- "RetryClock is an abstraction or injection that exists only for tests." It has two real consumers: production uses `systemClock`, and the test file passes a recording clock so eleven tests run without real waits or randomness. A seam for test injection of time is a justified wrapper.
- "RetryPolicy is config soup / speculative configuration." It has three required fields with one meaning each; the default is used in production and the tests use other values to reach the cap and the attempt limit.
- "The catch in send swallows errors." The `Transport` contract (transport.ts) says `send` rejects only when no response arrives, so the catch handles exactly the network-failure case; after the last attempt the original error is rethrown unchanged.
- "retryAfterMs parses defensively / ignores bad values." Retry-After comes from a server, an external boundary, and RFC 9110 allows two forms; a value in neither form is reachable and falls back to backoff, as the comment says and a test proves.
- "IDEMPOTENT_METHODS hard-codes PUT as safe." The ingest API defines every PUT as a replace by id (`putBatch` documents it), so sending it twice is safe; POST creates alerts and is never retried.
- "The tests duplicate the implementation." They assert observable waits and attempt counts through the public `send`, not the private helpers.
