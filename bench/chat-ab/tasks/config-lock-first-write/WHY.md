# config-lock-first-write

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(config): honor the first global settings change instead of refusing the lock".

## The bug

`withConfigOwnership` in `src/orchestration/config/config-file.ts` took the config ownership lock with `await acquireLockIn(...)` and ran the caller's work only after the await resumed. The lock was held across that yield. A synchronous settings writer (`withConfigOwnershipBlocking`, reached through `updateConfigText` in `writer.ts`) that ran on the same turn found the lock held by its own process, refused it after the retry ladder, and the first role model or effort confirmation reported a lock failure. The fix makes the awaited window use `withLockIn` from `src/infra/ownership-file-lock.ts`: it acquires, runs the synchronous work, and releases before it yields.

The original fix also added `withLockIn` and moved snapshot publication in `runtime-config-owner.ts` out of the lock window. On the public base, other owners (`package-directory-lock.ts`, `project-serving-lane.ts`) use `withLockIn`, so the sandbox keeps it and keeps the publication order. Only the window in `config-file.ts` is bugged. A solver can therefore reuse an existing helper, which makes the change smaller than the original fix.

## Why it is a fair task

The user sees a lock error with the pid of Flywheel itself. The cause is a yield inside a lock window, three layers below the settings UI. To find it, the solver must read the settings writer, the config ownership seam, and the ownership lock module, and understand how an awaited acquisition interleaves with a synchronous sibling. The file comment on `withConfigOwnership` already says that the window must not yield while it holds the lock, so a careful reader can find the contract. The reference change is 7 source lines in 1 file.

A strong model can fail in two ways. It can patch the caller (for example, make the role writer await the asynchronous window) and leave the seam broken, which the hidden tests catch. It can also make the lock reentrant for one process, which lets two owners interleave and fails the ordering assertion.

## Acceptance

`acceptance/config-ownership.test.ts` holds the two tests that the original fix added to `tests/unit/orchestration/config/config-ownership.test.ts`, with imports rewritten. Test 1 starts an asynchronous read window and immediately runs a synchronous write window. Test 2 makes sure that a failed callback releases the lock before a sibling write. Test 2 passes at the base and guards a fix that leaks the lock.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.`. It restores the awaited acquisition with release in `finally` in `withConfigOwnership`, and it removes the two fix tests from `tests/unit/orchestration/config/config-ownership.test.ts`, because they state the answer and fail on the bugged tree.

- Base: 1 pass, 1 fail (test 1 throws `LockRefusal: Failed to acquire lock 'flywheel.toml.lock' after 9 attempts`).
- Base plus `reference.patch`: 2 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts config-lock-first-write --apply-diff bench/chat-ab/tasks/config-lock-first-write/reference.patch
```

## Challenge

The challenge claims that same-process reentrancy can replace the ownership-window change. The ground truth is `hold`: separate owners in one process still need ordered access. The asynchronous read acquires ownership first. Letting the synchronous writer enter before that read finishes changes the state the read observes.

Test 1 in `acceptance/config-ownership.test.ts` decides this premise. It requires the earlier read to return the empty file while the later write succeeds. The reentrant patch permits the write but makes the earlier read return the new role configuration. Test 2 still passes, so failure release is not the disputed behavior.

On 2026-10-23, against the earlier pre-public base, a one-off verification script, run with `bun --env-file=.env.test --conditions=browser`, used the real sandbox helpers. It applied a reentrant-lock patch with `git apply` before capture. The patch changes only `src/infra/ownership-file-lock.ts`: synchronous acquisition accepts an existing record with the current pid and marks the returned hold as reentrant. Releasing that nested hold leaves the outer lock intact. It does not change the asynchronous ownership window.

The unfixed baseline returned 1 pass, 1 fail, with no stored-baseline drift. The reentrant patch returned 1 pass, 1 fail, with acceptance exit 1. The failure changed from lock refusal to the read-order assertion: expected `""`, received the configuration that the later write saved. The verification script exited 0 after checking all four fixtures and disposing every sandbox and command home. It recorded the patch and per-test outcomes.

## Design variant

- The shared config ownership boundary owns the fix, rather than the settings caller.
- Asynchronous config operations must acquire ownership, run synchronous work, and release ownership without yielding while the lock is held.
- Waiting for another owner must remain asynchronous.
- An immediate synchronous write after an asynchronous read must succeed, while the read retains the earlier state.
- Existing acquisition retries and cross-process protection must remain intact; same-process ownership must not become reentrant.
- Failed operations must release ownership and propagate their failure to the caller.
- The runtime config owner must publish the new snapshot and notify subscribers together, only after ownership ends.
- Verification must cover immediate read-then-write ordering and ownership release after a failed operation.
