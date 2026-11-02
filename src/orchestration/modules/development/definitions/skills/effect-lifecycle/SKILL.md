---
description: Use when designing or reviewing Effect-owned async resources, fibers, typed errors, and disposal.
---

# Effect Lifecycle

Input: the Effect-owned resource, acquisition point, consumers, cancellation sources, typed errors, and shutdown boundary.

Assign one lifecycle owner and separate resource lifetime from UI-readable state. Acquire with a scoped Effect primitive and pair release in the same owner. Keep child work in structured concurrency. Map external failures once into exhaustive domain errors. Define Promise and callback bridges with cancellation in both directions. Order shutdown as: stop admission; interrupt and await children; flush required durable work; dispose projections and roots; close logging. Test normal completion, interruption, acquisition failure, and repeated disposal.

Stop when every resource has one owner and every exit path reaches an awaited release. Return ownership map, acquisition and release path, error model, shutdown order, and verification evidence or review findings. On failure, report the unowned resource, uninterruptible bridge, or unverifiable shutdown edge. Never add parallel state ownership or fire-and-forget disposal.