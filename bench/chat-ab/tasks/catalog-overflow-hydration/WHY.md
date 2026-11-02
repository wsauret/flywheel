# catalog-overflow-hydration

## Source

- Fix commit: `e8399294f462b87344189ff21f9a3c3a98fac55c` "fix(runtime): recover session hydration when the event lane overflows" (2026-09-24).
- Base commit: `5a665aec2a5e8acbe41b835ef0c137a63a6a7230` (the parent of the fix).
- Source files in the fix: 1 (`src/orchestration/app-service/runtime-protocol-handlers.ts`), 40 changed lines. The fix also edits ADR-010 prose.

## The bug

Each client connection has a sliding outbound event queue. When a client falls behind, the queue drops the oldest frames instead of closing the connection. The design assumed that every receiver sees a gap in a cursor's patch sequence and resnapshots. That assumption fails for a cursor whose last patch was dropped: no later patch arrives on that cursor, so the client never sees a gap. During a large catalog hydration (one `session.updated` per session), a slow client lost the final rows of many sessions, and those rows stayed in their loading state until a reconnect or an unrelated later update.

The fix sends one explicit `runtime.invalidate` (reason `overflow`) after a drained batch that overflowed. The signal is kept outside the sliding queue, so later drops cannot discard it, and repeated drops before a drain share one signal. The fix also raises the queue bound.

## Why it is a fair task

The symptom is in the client (rows stay loading), but the cause is in the runtime's per-connection queue policy, and the reason it matters is in the client's cursor intake (gap detection needs a successor patch). A solver must read the protocol handlers, the client family intake, and the cursor and invalidation protocol to see why "drop oldest, the client resnapshots on the gap" is not enough. Raising the queue bound alone does not pass: the acceptance bursts are 12,000 frames. Closing the connection on overflow does not pass either: a test requires the lane to stay open and ordered.

## Acceptance

`acceptance/event-lane-overflow.test.ts`, 3 tests:

1. A 12,000-session hydration burst into a client that cannot drain; the real `createFamilyIntake` must resnapshot and end with no row in a loading state, without a reconnect or a later session patch.
2. Two separate overflow bursts each get their own recovery signal; the lane stays open, bounded, and ordered.
3. A client that keeps up gets no recovery signal (guard).

The assertions require at least one `runtime.invalidate` patch per overflow. They do not fix the exact count, the batch position, or the queue bound. The sandbox applies `sandbox.patch` (bunfig test root set to `.`).

## Validation

Run from the sandbox root with `bun test acceptance`, sandbox built exactly from `task.json`:

- Base: 1 pass, 2 fail (tests 1 and 2: no invalidation arrives).
- Base plus the fix commit's `src` changes: 3 pass, 0 fail (repeated 4 times, stable, about 2 s).
