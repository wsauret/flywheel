# session-list-empty-after-timeout

## Source

- Fix commit: `441e7b698a2073848368c566e14bd2dd7f3f622d` "fix(app-service): keep the session list complete and its warnings" (2026-10-01).
- Base commit: `217735ebeac0629ea024cbefa111be957469d3d8` (the parent of the fix).
- Source files in the fix: 3 (`project-control-client.ts`, `project-state-recovery.ts`, `runtime-summary-projection.ts` under `src/orchestration/app-service/`), 118 changed lines.

## The bug

The account's project control client builds the session catalog on one promise chain. The first link reads the history baseline. Every later metadata refresh and every `snapshot` query chains on that promise. When the first history read failed (for example, past its deadline on a large store), the chain stayed rejected for the life of the project. Every queued refresh was skipped, every heard change was lost, and the session list stayed empty until the account service restarted.

The fix replaces the one-shot baseline with a `syncCatalog` step that reads the baseline again until one read succeeds, keeps the changes heard during a failure queued, and applies them after the next successful baseline. The same commit also fixes two smaller catalog issues (summary warnings and mutation rows). This task covers only the empty-list symptom.

## Why it is a fair task

The symptom (an empty list forever) is far from the cause (a cached rejected promise that every later step chains on). A solver must read the control client's catalog chain, the history lane, and the state client's change subscription, and must keep the changes heard during a failure. A naive fix that only catches the error makes the chain continue, but it drops the baseline rows or the queued changes. The tests do not require a specific answer for the failed request itself: it may reject or return no rows.

## Acceptance

`acceptance/catalog-baseline-retry.test.ts`, 2 tests:

1. After a failed baseline, a change heard later causes a new baseline read, and the next snapshot lists the baseline row with the rename and both added sessions that were heard before and after the failure.
2. After a failed baseline, the next snapshot request reads the baseline again and lists its rows, and a later snapshot does not read the baseline a third time.

The sandbox applies `sandbox.patch` (bunfig test root set to `.`). The paths include `crates/tokenizer/tokenizer-prebuilt.json` and `.env.test`.

## Validation

Run from the sandbox root with `bun test acceptance`, sandbox built exactly from `task.json`:

- Base: 0 pass, 2 fail (test 1 times out at 5 s waiting for the refresh, because the chain never runs; test 2 rejects with `history deadline` again).
- Base plus the fix commit's `src` changes: 2 pass, 0 fail (repeated 4 times, stable, about 1.5 s).

## Design variant

- Recovery belongs to the account service component that owns the project's session catalog, using one ordered path for the baseline and later changes.
- A failed baseline must leave later catalog work runnable. Read the baseline again on the next request or change until one read succeeds, then reuse it.
- Retain queued changes across failed baseline attempts, including changes received during a read, and apply them after the successful baseline.
- Preserve existing error reporting. The failed request itself need not return a populated list.
- Limit the change to catalog recovery rather than the other session-list fixes in the source commit.
