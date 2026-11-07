# session-list-empty-after-timeout

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(app-service): keep the session list complete and its warnings". That commit also fixed two smaller catalog issues (summary warnings and mutation rows). This task covers only the empty-list symptom.

## The bug

The account's project control client builds the session catalog on one ordered lane in `src/orchestration/app-service/project-control-client.ts`. The first step, `syncCatalog`, reads the history baseline. Every later metadata refresh and every `snapshot` query runs a step that waits for that baseline. In the bugged tree the baseline read is one cached promise. When the first history read failed (for example, past its deadline on a large store), every later step awaited the same rejected promise for the life of the project. Every queued refresh was skipped, every heard change stayed unapplied, and the session list stayed empty until the account service restarted.

The fix reads the baseline again on each step until one read succeeds, keeps the changes heard during a failure queued, and applies them after the next successful baseline.

## Why it is a fair task

The symptom (an empty list forever) is far from the cause (a cached rejected promise that every later step awaits). A solver must read the control client's catalog lane, the history lane, and the state client's change subscription, and must keep the changes heard during a failure. A naive fix that only catches the error lets the lane continue, but it drops the baseline rows or the queued changes. The tests do not require a specific answer for the failed request itself: it may reject or return no rows.

## Acceptance

`acceptance/catalog-baseline-retry.test.ts`, 2 tests:

1. After a failed baseline, a change heard later causes a new baseline read, and the next snapshot lists the baseline row with the rename and both added sessions that were heard before and after the failure.
2. After a failed baseline, the next snapshot request reads the baseline again and lists its rows, and a later snapshot does not read the baseline a third time.

The history fixtures return the current snapshot shape, `generationSpeeds` included.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.`. It caches the first baseline read in `syncCatalog`, replaces the doc comment that states the retry contract with one that describes a single baseline read, and removes the unit test in `tests/unit/orchestration/app-service/project-control-client-catalog.test.ts` that the fix added, so the unit suite passes on the bugged tree as it did before the fix.

- Base: 0 pass, 2 fail. Every step after the failure awaits the same rejected read, so test 1 never sees the refresh of the later change and test 2's next snapshot rejects again.
- Base plus `reference.patch`: 2 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts session-list-empty-after-timeout --apply-diff bench/chat-ab/tasks/session-list-empty-after-timeout/reference.patch
```

## Design variant

- Recovery belongs to the account service component that owns the project's session catalog, using one ordered path for the baseline and later changes.
- A failed baseline must leave later catalog work runnable. Read the baseline again on the next request or change until one read succeeds, then reuse it.
- Retain queued changes across failed baseline attempts, including changes received during a read, and apply them after the successful baseline.
- Preserve existing error reporting. The failed request itself need not return a populated list.
- Limit the change to catalog recovery rather than other session-list behavior.
