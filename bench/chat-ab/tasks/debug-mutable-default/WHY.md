# debug-mutable-default

Source: `tests/e2e/workflow-debug-mutable-default.sh` at `64d9b75aeaa02fb5d00d2f75d01ea8a50df0d743`, the parent of `a9128a8bbd`.

## The bug

`process_events` in `src/processor.py` uses a mutable list as its `seen_ids` default. Python creates that list once. Calls without an explicit list then share the IDs that earlier calls added. An independent second call drops events whose IDs appeared in the first call.

The expected fix changes the function signature to use `None`, then creates a fresh list when the argument is omitted. A sentinel with the same per-call behavior is acceptable. An explicit caller-provided list must still support cross-batch deduplication. Event sorting, within-batch deduplication, and reports must not change. Changing only callers or tests does not fix the function contract.

## Why it is a fair task

This task restores the historical Python project, not Flywheel source. `sandbox.patch` contains all six project files exactly as the script wrote them. This includes the empty package files and historical punctuation. The message is the original prompt with its em dash replaced by a comma.

The sandbox source is the empty tree, and the patch creates every file, `.gitignore` included. That `.gitignore` keeps the bytes of the one that earlier runs archived from `64d9b75aeaa02fb5d00d2f75d01ea8a50df0d743`, a commit outside the public history, so the provisioned tree did not change. The sandbox contains `.gitignore`, `src/`, and `tests/`, plus its fresh Git repository. It contains no Flywheel source, task metadata, or acceptance tests before capture. Python with `pytest` must already be available through `python3`; setup does not install dependencies or use the network.

## Acceptance

The loader copies `acceptance/` only after capturing the candidate diff. The Bun acceptance wrapper runs Python in fresh processes. `acceptance/pipeline.py` is an exact frozen copy of the historical test module. Candidate edits to the visible tests cannot change it.

Two fail-to-pass checks exercise the function directly. One uses two different event lists with an overlapping ID and checks sorting and within-batch deduplication. The other runs the original `test_process_twice` alone, which exposes the empty second result.

Three guard checks run the original basic-processing, shared-deduplication, and summary tests separately. Each passes in a fresh process before the fix. In the full original suite, basic processing contaminates the default before later tests run. Both `test_process_twice` and the summary test then fail. Isolation preserves the original passing behavior as guards without weakening the independent-call checks.

## Validation

Validation used the real `provisionSandbox` and `captureSandbox` functions. Exact equality checks compared all six provisioned project files with the historical heredocs. They also checked the frozen test copy and the prompt edit. A directory check confirmed that acceptance files were absent before capture.

- Environment: `python3 -m pytest --version` reported `pytest 9.0.2`.
- Unfixed visible suite: `python3 -m pytest tests/ -v` returned exit 1, with 2 passed and 2 failed.
- Unfixed hidden checks: 3 passed and 2 failed. Both failures were the declared fail-to-pass checks. The stored baseline had no drift.
- Reference fix: replace the mutable default with `None` and initialize a list inside the function.
- Fixed visible suite: the same verification command returned exit 0, with 4 passed.
- Fixed hidden checks: 5 passed and 0 failed. The acceptance score was 1, with no broken guards.
- The captured fixed diff changed only `src/processor.py`; acceptance files were excluded.

## Challenge

The challenge proposes a `None` default with a fresh list inside `process_events` only when the caller omits the argument. The ground truth is `change`: this is the reference fix's shape. It fixes independent calls without adding state objects or changing callers. An explicit shared list still supports cross-batch deduplication.

Both fail-to-pass checks in `acceptance/mutable-default.test.ts` decide whether independent calls retain their events. The three guards decide whether basic processing, explicit shared-list deduplication, and summaries remain correct.

On 2026-10-23, a one-off verification script, run with `bun --env-file=.env.test --conditions=browser`, used the real sandbox helpers. It applied this task's `reference.patch` with `git apply` before capture. The patch changes only the default argument and adds the `None` check with list initialization in `src/processor.py`. The unfixed baseline returned 3 pass, 2 fail, with no stored-baseline drift. The reference patch returned 5 pass, 0 fail, with acceptance exit 0.

The verification script exited 0 after checking all four challenge fixtures and disposing every sandbox and command home. It recorded the applied diff, per-test outcomes, and command exit codes.
