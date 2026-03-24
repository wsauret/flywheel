---
type: research
feature: core-utils-interaction
date: 2026-03-24
status: complete
---

## Codebase Map

```
src/
├── index.ts          — Public API re-exports from core and utils
├── core/
│   ├── types.ts      — Task, TaskResult, QueueConfig type definitions
│   ├── queue.ts      — FIFO priority queue, drives processing loop
│   ├── scheduler.ts  — Concurrency-limited task executor
│   └── events.ts     — In-process pub/sub EventBus
└── utils/
    ├── id.ts         — Unique task ID generation
    ├── logger.ts     — Namespaced structured logger
    ├── timeout.ts    — Promise timeout wrapper
    └── retry.ts      — Exponential backoff retry policy
```

## Relevant Code

### Dependency Direction

Core depends on utils (4 imports). Utils has zero dependencies on core — strictly one-directional.

### queue.ts → utils

- `queue.ts:13` — imports `generateId` from `utils/id`
- `queue.ts:14` — imports `Logger` from `utils/logger`
- `queue.ts:16` — module-scope logger: `const log = new Logger("queue")`
- `queue.ts:36` — stamps each task: `id: generateId()`

### scheduler.ts → utils

- `scheduler.ts:10` — imports `withTimeout` from `utils/timeout`
- `scheduler.ts:11` — imports `RetryPolicy` from `utils/retry`
- `scheduler.ts:65` — per-task retry: `new RetryPolicy(...)` instantiation
- `scheduler.ts:70` — deadline enforcement: `withTimeout(task.handler(), timeoutMs)`

### Execution chain (scheduler.ts:65-71)

The scheduler composes retry and timeout for every task execution:
`RetryPolicy.execute(() => withTimeout(task.handler(), timeoutMs))`

Timeout wraps the inner promise; retry wraps the timeout. A `TimeoutError` from `timeout.ts:8` triggers a retry attempt via `retry.ts:42`.

### Public API (index.ts:8-15)

Re-exports `TaskQueue`, `Scheduler`, `EventBus`, core types, `RetryPolicy`, `Logger`, `createLogger`. Internal utils `generateId` and `withTimeout` are NOT exported.

## Patterns to Follow

1. **One-directional dependency** — core → utils only; utils modules are self-contained with no inter-util imports.
2. **Module-scope logger** — `queue.ts:16` creates a single `Logger` instance at import time with a namespace string.
3. **Composition over inheritance** — `TaskQueue` owns a `Scheduler` and `EventBus` via constructor injection (`queue.ts:25`).
4. **Failures as data** — `scheduler.ts:90-108` catches all errors and pushes `TaskResult` with `status: "failed"` to `completed` array rather than re-throwing.
5. **Silent event errors** — `events.ts:57-60` swallows handler exceptions so event propagation never fails.

## Constraints

- **Mutable module state in id.ts** — `counter` at `id.ts:8` increments globally; `resetIdCounter()` exists for tests only.
- **Global log level** — `logger.ts:25` `globalLevel` is shared across all `Logger` instances; `setLogLevel()` mutates it.
- **Scheduler capacity guard** — `scheduler.ts:39-41` throws synchronously if `schedule()` called at capacity; callers must check before calling.
- **Retry wraps timeout** — timeout fires per-attempt, not across all retries. Each retry gets a fresh timeout window.

## Open Questions

1. Does any consumer call `setLogLevel()` at runtime, or is the default `"info"` always used?
2. Is `createTimeoutSignal()` (`timeout.ts:40`) used anywhere, or is it dead code?
3. The `start()` loop in `queue.ts:74` calls `processNext()` then `drain()` without awaiting in-flight tasks — are results only collected on subsequent loop iterations?
