# catalog-overflow-hydration

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(runtime): recover session hydration when the event lane overflows".

## The bug

Each client connection has a sliding outbound event queue (`runtimeEventDelivery` in `src/orchestration/app-service/runtime-event-delivery.ts`). When a client falls behind, the queue drops the oldest frames instead of closing the connection. The design assumed that every receiver sees a gap in a cursor's patch sequence and resnapshots. That assumption fails for a cursor whose last patch was dropped: no later patch arrives on that cursor, so the client never sees a gap. During a large catalog hydration (one `session.updated` per session), a slow client lost the final rows of many sessions, and those rows stayed in their loading state until a reconnect or an unrelated later update.

The fix sends one explicit `runtime.invalidate` (reason `overflow`) after a drained batch that overflowed. The signal is kept outside the sliding queue, so later drops cannot discard it, and repeated drops before a drain share one signal. It is stamped with the newest patch position the queue was offered, so a receiver whose read already covers the dropped frames ignores it.

## Why it is a fair task

The symptom is in the client (rows stay loading), but the cause is in the runtime's per-connection queue policy, and the reason it matters is in the client's cursor intake (gap detection needs a successor patch). A solver must read the event delivery, the client family intake, and the cursor and invalidation protocol to see why "drop oldest, the client resnapshots on the gap" is not enough. Raising the queue bound alone does not pass: the acceptance bursts are 12,000 frames. Closing the connection on overflow does not pass either: a test requires the lane to stay open and ordered.

## Acceptance

`acceptance/event-lane-overflow.test.ts`, 3 tests through the real `runtimeHandlers` RPC layer:

1. A 12,000-session hydration burst into a client that cannot drain; the real `createFamilyIntake` must resnapshot and end with no row in a loading state, without a reconnect or a later session patch.
2. Two separate overflow bursts each get their own recovery signal; the lane stays open, bounded, and ordered.
3. A client that keeps up gets no recovery signal (guard).

The assertions require at least one `runtime.invalidate` patch per overflow. They do not fix the exact count, the batch position, the stamped position, or the queue bound. The tests attach with the runtime's protocol version and use ordinary `executor.changed` patches as position markers.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.`. It removes the overflow invalidation from `runtimeEventDelivery` and restores its earlier doc comment and overflow log text. It returns the outbound-queue sentence of ARCH-PROTOCOL-013 in `docs/architecture-intent/protocol.md` to the earlier "receivers resnapshot on the gap" contract, because the current sentence states the fix. It also removes the invalidation assertions from `tests/unit/orchestration/app-service/runtime-event-stream.test.ts` (and its overflow recovery test) and from `tests/unit/orchestration/headless-chat.test.ts`, so the unit suite passes on the bugged tree as it did before the fix. The queue bound stays at 2,048 frames.

- Base: 1 pass, 2 fail (tests 1 and 2: no invalidation arrives).
- Base plus `reference.patch`: 3 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts catalog-overflow-hydration --apply-diff bench/chat-ab/tasks/catalog-overflow-hydration/reference.patch
```
