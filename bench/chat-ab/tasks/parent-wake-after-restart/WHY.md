# parent-wake-after-restart

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(messaging): wake a parent when its child completes after a restart".

## The requirement

A parent chat waits on its running subagent. The Flywheel service then stops: the runtime stops it, it crashes, or an update replaces it. After the restart, the subagent finishes. The parent must wake and start a model request that reads the subagent's result, as it does when no restart occurs. A person's own interrupt (Escape) is different: after it, the parent waits for the person, and a completion does not start a turn (PI-INTERACTION-102).

## The bug

The service writes a turn-end record at the end of the parent's turn when it stops or crashes. After the restart, the child's resume holds the parent's runner. The hold asks whether the parent's last turn waits for the person. In the sandbox, the chat runner answers that itself in `src/orchestration/chat/runner-lifecycle.ts`: every recorded interrupt or unexpected exit waits for the person. So the hold parks for the person, and the child's completion folds into history without a turn.

The saved conversation already tells the two cases apart: the turn-end reader in `src/orchestration/session/conversation/turn-end-record.ts` marks a runtime or crash cut of a turn that waited on background work (`ChatTurnEnd.backgroundWait`), and `waitsForPerson` reads that mark. The reference fix makes the runner's hold call `waitsForPerson`. A solver can fix the behavior with a different design. The tests do not require this design.

## Why it is a fair task

The symptom (a parent that does not wake after a restart) is far from the cause. A solver must trace the hold of a parent runner through the runner lifecycle, the wait state, the message delivery, the stored run evidence, and the turn-end record, and see that one reader of the record ignores what the record says. The message names the three causes: a service restart, a crash, and an update.

## Acceptance tests

`acceptance/parent-wake-after-restart.test.ts` has five tests. Two are labeled regression guards that pass on the sandbox.

Each test stores a parent chat whose last turn matches the message: the person asked for work, the model called `subagent`, and the dispatch returned the child's run id. In the four wait tests, the model then called a `process` wait, got the wait's result, and a turn-end record ended the turn. The test opens the chat as a runner that attaches after a restart, holds it as a child's resume does, and waits for the hold to settle. Except in the update test, it then waits about 200 ms and checks that no model request started, because the child has not finished yet. It then delivers the subagent's completion through `deliverBackgroundNotification`.

1. The runtime stopped the service (`{ reason: "paused", pausedBy: "runtime" }`): no model request starts before the completion. After the completion, a model request starts within 3 seconds, and its context contains the completion text.
2. The service crashed (`{ reason: "crash" }`): the same checks.
3. An update replaced the service (`{ reason: "paused", pausedBy: "runtime", planned: true }`): after the completion, a model request that contains the completion text starts within 3 seconds, and the chat does not show as interrupted.
4. Regression guard: the person interrupted the wait (`{ reason: "paused", pausedBy: "person" }`). No model request starts before the completion. After the completion, no model request starts within about 400 ms, and the chat shows as interrupted.
5. Regression guard: the parent started its child and answered the person, and no stop or crash cut the turn. No model request starts before the completion, and the completion starts a model request that reads it. This is the "without a restart" behavior that the message expects to keep.

Test 3 differs from the earlier fixture, which required quiet before the completion for an update too. Current product intent says that an update hands running work to the new service, which continues it with no visible interruption (PI-REMOTE-012): the successor re-enters the parent's wait at once. The test store holds no live child, so that wait finds nothing pending and asks the model once before the completion. That request is correct product behavior, so the test does not count it. In the sandbox, the hold parks for the person instead, and the completion starts no request.

What the tests check beyond a wake:

1. A design that resumes the cut turn at attach after a stop or a crash, before the child completes, fails tests 1 and 2. The message asks the parent to wake when its child completes, not when the service restarts.
2. A design that wakes after every recorded cut, the person's Escape included, fails test 4.

What the tests do not check:

1. They do not check a park flag, an event field, or the result of a turn-end predicate. Only model requests count, and in test 3 the displayed interrupted state.
2. They do not check the chat's displayed state before or after the completion in tests 1 and 2. The message does not ask for a specific display.
3. They do not check that a cut which owed the model a request (for example, mid-request) still waits for the person. The message does not state that case.
4. They do not check a restart cut of a turn that did not start a subagent, for example a turn that waited on a shell command. The message is about a subagent.

The tests use a SQLite store under `tmpdir()` that `temporaryDirectories()` removes. They make no network request and start no process.

## Sandbox notes

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. It holds `bunfig.toml`, `.env.test`, the four workspace folders (so `bun install` resolves the workspaces), and the two tokenizer assets under `crates/tokenizer/` (the stored chat counts tokens). `sandbox.patch` makes three changes:

- It sets the `bunfig.toml` `[test] root` to `.`, so `bun test acceptance` finds the acceptance directory and the test preload still runs.
- It restores the defect in `src/orchestration/chat/runner-lifecycle.ts`: the hold's `readLastTurnWaitsForPerson` checks only that the turn end is recorded and resumable, and ignores `backgroundWait`.
- It deletes `tests/unit/orchestration/chat/chat-session-restored-wait.test.ts`. That suite came after the original fix and depends on it: 27 of its 32 tests fail on the bugged tree, and they describe the fix. The original task's base had no such suite. `reference.patch` restores it.

## Validation

- Sandbox: 2 pass, 3 fail. Only the two labeled regression guards pass.
- Sandbox plus `reference.patch`: 5 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts parent-wake-after-restart --apply-diff bench/chat-ab/tasks/parent-wake-after-restart/reference.patch
```

The scores of attempts recorded against the earlier, pre-public fixture do not carry over to this fixture; they need a new baseline.
