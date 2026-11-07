# subagent-interrupted-shows-failed

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(subagents): list an interrupted subagent as interrupted, not failed".

## Re-posed on 2026-11-06

The task was re-posed on 2026-11-06, when it moved from a pre-public base to the public base. Results from before that date are not comparable with later results. The person approved this change.

The original task said that the parent's `process list` showed an interrupted subagent as "failed". At the public base that surface no longer reads the registry record: `processList` in `src/orchestration/agent-runtime/tools/process.ts` leaves out registry records of kind subagent and lists each child from its durable child state. So no defect in the pause path can make the list say "failed" any more. The same defect now has other symptoms that a person reaches, and the task poses those instead. The person-interrupt expectation also changed: the original acceptance test required that a child a person interrupted leaves the parent's active work, which contradicts PI-AGENT-025 and ARCH-SESSIONS-023. The new test requires that it stays.

## The bug

A person or the runtime pauses a child run. In `createChildExecution` (`src/orchestration/modules/subagents/execution/child-execution.ts`), `publishTerminal` handles the pause: it records the paused fact and the turn end, and it gives the parent no completion. But it returns the settled result of the run, which `resolveSettledRun` makes "stopped" for a paused run, to the background work registry. The registry then treats the child as ended work that owes a result:

- The session process record says "stopped", which means a Stop that never resumes.
- The registry keeps the child as a pending owed result. No completion is ever recorded for a pause, so the child stays in the parent's outstanding work: a child that the runtime interrupted holds every wait of the parent and blocks its handoff, contrary to PI-AGENT-025 and ARCH-SESSIONS-023.
- The registry never announces the runtime's interrupt to the parent.
- A child that a person interrupted counts only as an owed result, not as the parent's live child work.

The fix returns `{ status: "interrupted", interruptedBy }` from the pause branch. The registry already knows that status: an interrupted run owes no result, a person's interrupt keeps the child the parent's work, and the runtime's interrupt is announced. The change is 5 lines in 1 file.

## Why it is a fair task

The person sees a parent that waits too long or cannot finish after an update. The cause is several layers away: the parent's waits and handoff read the outstanding-work set of `BackgroundWorkRegistry` (`src/orchestration/agent-runtime/background-work.ts`), which the tracked task's result settles, which `child-execution.ts` produces from `result-resolver.ts` after a pause. A solver must read at least those files and decide where the pause can name its own status without turning it into a completion. A naive change, such as mapping every aborted run to "interrupted" in the resolver, loses who interrupted the child and so breaks the person case, or breaks the failure path, which the tests also check.

## Acceptance

`acceptance/subagent-interrupted-status.test.ts`, built on the repository's subagent child harness:

1. For an interrupt by the person and by the runtime, the process record is `{ kind: "subagent", status: "interrupted" }`.
2. After a person's interrupt the parent's outstanding work (`activeTaskCount`) is 1 (PI-AGENT-025); after the runtime's interrupt it is 0.
3. A child whose run ends with a provider error still records as "failed".

The tests use a SQLite store under `tmpdir()` that the harness removes. They make no network request and start no process.

## Sandbox

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.` and removes the 5 lines of the pause branch that set the interrupted status. It also removes the unit test assertions that the fix made true, so the unit suite passes on the bugged tree: the test "a paused child lists as interrupted, not failed, and leaves the active work count" in `subagent-child-controls.test.ts`, and the outstanding-work, handoff, and notice assertions in `subagent-process-control.test.ts`, `agent-runtime/subagent/pause.test.ts`, and `agent-runtime/subagent/durable-conversation.test.ts`. `reference.patch` restores them.

## Validation

- Base: 1 pass, 2 fail (both interrupts record "stopped"; the runtime case also keeps 1 outstanding item).
- Base plus `reference.patch`: 3 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts subagent-interrupted-shows-failed --apply-diff bench/chat-ab/tasks/subagent-interrupted-shows-failed/reference.patch
```

## Design variant

- The child lifecycle owner makes the interruption decision where it knows who paused the child, rather than relabeling the record or treating every aborted run as interrupted.
- The interrupted state and its interrupter travel through background work tracking into the parent's records.
- A child that the runtime or the parent agent interrupted leaves the parent's outstanding work and keeps its parent relationship for resume; a child that a person interrupted stays the parent's work.
- Interruption must not record a completion or deliver one to the parent.
- Existing behavior for genuine failures and other completed work stays unchanged.
