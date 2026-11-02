# subagent-interrupted-shows-failed

Fix commit: `1a142dccf1a01c47b41442de2af435aa73d74d04` fix(subagents): list an interrupted subagent as interrupted, not failed

Base commit: `6a5d5365587343f2ffe57f0adae82417e0ef6154` (the parent of the fix).

## The bug

A person or the runtime pauses a child run. The child's agent loop ends with an aborted terminal, and `resolveSubagentResult` turns that into a "failed" result. In `dispatchSubagent` (`src/orchestration/modules/subagents/execution/tool.ts`), `publishTerminal` handles the pause: it records the paused fact and gives the parent no completion. But it still returns the failed result to the background work registry, and the registry copies that status into the session process record. So the parent's `process list` shows the paused child as "failed".

The fix adds the status "interrupted" to `BackgroundWorkResult` and `BackgroundProcessRecord`, returns it from the pause branch of `publishTerminal`, and narrows the type of a recorded completion (`EndedWorkResult`) so that an interrupted run never records a completion. It touches 5 source files and about 48 lines.

## Why it is a fair task

A user sees only the word "failed" in the parent agent's view. The cause is several layers away: the `process` tool reads `BackgroundWorkRegistry.processRecords()`, which `background-work.ts` settles from the tracked task's result, which `tool.ts` produces from `result-resolver.ts` after a pause. A solver must read at least those four files and decide where the pause can name its own status without turning the pause into a completion. A naive change (for example, mapping every aborted run to "interrupted" in the resolver) can break the completion path or the failure path, which the tests also check.

## Acceptance tests

`acceptance/subagent-interrupted-status.test.ts`, built on the repository's subagent child harness:

1. For a pause by the person and by the runtime: the process record is `{ kind: "subagent", status: "interrupted" }`, the active work count drops to zero, and the `process` tool's list shows `| interrupted | subagent |` and no `| failed |`.
2. A child whose run rejects still lists as "failed".

The tests use a SQLite store under `tmpdir()` that the harness removes. They make no network request and start no process.

## Sandbox notes

Same sandbox shape as the other production-history tasks: `bunfig.toml` (with `sandbox.patch` removing the `root` line), `.env.test`, the four workspace `package.json` files, and the two tokenizer assets.

## Validation evidence

- Base sandbox: `bun test acceptance` gave 1 pass, 2 fail (the record status was "failed").
- Base sandbox with the fix commit's `src` changes applied: 3 pass, 0 fail (three runs).
- No entry stayed in a fresh `TMPDIR` after the run.

## Design variant

- The child lifecycle owner makes the interruption decision where it knows the child was paused, rather than relabeling the display or treating every aborted run as interrupted.
- The interrupted state travels through background work tracking into the parent process list.
- An interrupted child leaves the active work count but retains its parent relationship for resume.
- Completion reporting accepts only ended work; interruption must not record a completion or deliver one to the parent.
- Existing behavior for other completed work stays unchanged.
