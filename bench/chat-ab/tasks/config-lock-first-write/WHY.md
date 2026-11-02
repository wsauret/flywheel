# config-lock-first-write

Fix commit: `5e6f86b3f4c297c4f8ceb0df92b1c105df7e8dcb` fix(config): honor the first global settings change instead of refusing the lock

Base commit: `d681a265d1e11113a5ca92f1e4bcac73ab992eb7` (the parent of the fix)

## The bug

`withConfigOwnership` in `src/orchestration/config/config-file.ts` took the config ownership lock with `await acquireLockIn(...)` and ran the caller's work only after the await resumed. The lock was held across that yield. A synchronous settings writer (`withConfigOwnershipBlocking`, reached through `updateConfigText` in `writer.ts`) that ran on the same turn found the lock held by its own process, refused it after the retry ladder, and the first role model or effort confirmation reported a lock failure. The fix adds `withLockIn` to `src/infra/ownership-file-lock.ts`: it acquires, runs the synchronous work, and releases before it yields. The awaited window uses it. `runtime-config-owner.ts` moves snapshot publication and subscriber notification out of the lock window.

## Why it is a fair task

The user sees a lock error with the pid of Flywheel itself. The cause is a yield inside a lock window, three layers below the settings UI. To find it, the solver must read the settings writer, the config ownership seam, and the ownership lock module, and understand how an awaited acquisition interleaves with a synchronous sibling. The file comment on `withConfigOwnership` already says that the window must not yield while it holds the lock, so a careful reader can find the contract. The change is 43 source lines in 3 files.

A strong model can fail in two ways. It can patch the caller (for example, make the role writer await the asynchronous window) and leave the seam broken, which the hidden tests catch. It can also make the lock reentrant for one process, which lets two owners interleave and fails the ordering assertion.

## Acceptance

`acceptance/config-ownership.test.ts` is the fix commit's new `tests/unit/orchestration/config/config-ownership.test.ts` with imports rewritten. Test 1 starts an asynchronous read window and immediately runs a synchronous write window. Test 2 makes sure that a failed callback releases the lock before a sibling write. Test 2 passes at the base and guards a fix that leaks the lock.

## Validation

The sandbox was built from `task.json` (git archive of the listed paths at the base, `sandbox.patch` sets the bunfig test root to `.`, baseline commit, `bun install`).

- Base: 1 pass, 1 fail (test 1 throws `LockRefusal: Failed to acquire lock 'flywheel.toml.lock' after 9 attempts`).
- Base plus the fix commit's `src` changes: 2 pass, 0 fail. Three repeated runs gave the same result.

## Challenge

The challenge claims that same-process reentrancy can replace the ownership-window change. The ground truth is `hold`: separate owners in one process still need ordered access. The asynchronous read acquires ownership first. Letting the synchronous writer enter before that read finishes changes the state the read observes.

Test 1 in `acceptance/config-ownership.test.ts` decides this premise. It requires the earlier read to return the empty file while the later write succeeds. The reentrant patch permits the write but makes the earlier read return the new role configuration. Test 2 still passes, so failure release is not the disputed behavior.

On 2026-10-23, a one-off verification script, run with `bun --env-file=.env.test --conditions=browser`, used the real sandbox helpers. It applied a reentrant-lock patch with `git apply` before capture. The patch changes only `src/infra/ownership-file-lock.ts`: synchronous acquisition accepts an existing record with the current pid and marks the returned hold as reentrant. Releasing that nested hold leaves the outer lock intact. It does not change the asynchronous ownership window.

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
