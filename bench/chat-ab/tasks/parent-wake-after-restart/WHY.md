# parent-wake-after-restart

Fix commit: `673fbd227835fae9738627f7999802c60cb5a32a` fix(messaging): wake a parent when its child completes after a restart

Base commit: `6a15970e64b217a475a56b538034abeae0c1229d` (the parent of the fix).

## The requirement

A parent chat waits on its running subagent. The Flywheel service then stops: the runtime stops it, it crashes, or an update replaces it. After the restart, the subagent finishes. The parent must wake and start a model request that reads the subagent's result, as it does when no restart occurs. A person's own interrupt (Escape) is different: after it, the parent waits for the person, and a completion does not start a turn.

## The bug

The service writes a turn-end record at the end of the parent's turn when it stops or crashes. After the restart, the child's resume holds the parent's runner. On base, the hold treated every recorded runtime interrupt or unexpected exit as a stop that waits for the person. So the hold parked for the person, and the child's completion folded into history without a turn.

The reference fix changes two files. `src/orchestration/session/conversation/turn-end-record.ts` tells a runtime or crash cut of a turn that waited on background work from a cut that owed the model a request. `src/orchestration/session/chat-session-run-evidence.ts` reads the stored tail one model step past such a record, because the record is usually its own entry batch. A solver can fix the behavior with a different design. The tests do not require this design.

## Why it is a fair task

The symptom (a parent that does not wake after a restart) is far from the cause. A solver must trace the hold of a parent runner through the runner lifecycle, the message delivery, the stored run evidence, and the turn-end record. The message says that the service restarted, and it names two causes: an update installed, and the service crashed. A plain service stop and restart is the same case for the person: the service stopped the chat, not the person, and the subagent finished after the restart. So the tests check all three records that a restart writes: a runtime stop, a crash, and a planned stop for an update.

## Acceptance tests

`acceptance/parent-wake-after-restart.test.ts` has five tests. Two are labeled regression guards that pass on base.

Each test stores a parent chat whose last turn matches the message: the person asked for work, the model called `subagent`, and the dispatch returned the child's run id. In the four wait tests, the model then called a `process` wait, got the wait's result, and a turn-end record ended the turn. The test opens the chat as a runner that attaches after a restart, holds it as a child's resume does, and waits for the hold to settle. It then waits about 200 ms and checks that no model request started, because the child has not finished yet. It then delivers the subagent's completion through `deliverBackgroundNotification`.

1. The runtime stopped the service (`{ reason: "paused", pausedBy: "runtime" }`): no model request starts before the completion. After the completion, a model request starts within 3 seconds, and its context contains the completion text.
2. The service crashed (`{ reason: "crash" }`): the same checks.
3. An update replaced the service (`{ reason: "paused", pausedBy: "runtime", planned: true }`): the same checks.
4. Regression guard: the person interrupted the wait (`{ reason: "paused", pausedBy: "person" }`). No model request starts before the completion. After the completion, no model request starts within about 400 ms, and the chat shows as interrupted.
5. Regression guard: the parent started its child and answered the person, and no stop or crash cut the turn. No model request starts before the completion, and the completion starts a model request that reads it. This is the "without a restart" behavior that the message expects to keep.

What the tests check beyond a wake:

1. A design that resumes the cut turn at attach, before the child completes, fails tests 1 to 3. The message asks the parent to wake when its child completes, not when the service restarts.
2. A design that wakes after every recorded cut, the person's Escape included, fails test 4.

What the tests do not check:

1. They do not check a park flag, an event field, or the result of a turn-end predicate. Only model requests count.
2. They do not check the chat's displayed state before or after the completion in the restart cases. The message does not ask for a specific display.
3. They do not check that a cut which owed the model a request (for example, mid-request) still waits for the person. The message does not state that case.
4. They do not check a restart cut of a turn that did not start a subagent, for example a turn that waited on a shell command. The message is about a subagent.

The tests use a SQLite store under `tmpdir()` that `temporaryDirectories()` removes. They make no network request and start no process.

## How to apply the reference

Make a patch from the fix commit's source changes, then rescore with it:

```
git diff 673fbd227^..673fbd227 -- src > pw-ref.patch
bun --conditions=browser bench/chat-ab/check-task.ts parent-wake-after-restart --apply-diff pw-ref.patch
```

The overlay form gives the same result:

```
bun --conditions=browser bench/chat-ab/check-task.ts parent-wake-after-restart --overlay 673fbd227:. --overlay-files src/orchestration/session/conversation/turn-end-record.ts,src/orchestration/session/chat-session-run-evidence.ts
```

## Sandbox notes

The sandbox adds `bunfig.toml`, `.env.test`, the four workspace `package.json` files (so `bun install` resolves the workspaces), and the two tokenizer assets under `crates/tokenizer/` (the stored chat counts tokens). `sandbox.patch` removes `root = "./tests"` from `bunfig.toml`, so `bun test acceptance` finds the acceptance directory and the test preload still runs.

## Validation evidence

All scores below come from `check-task.ts` with `--apply-diff`, and each was also run in a kept sandbox for per-test results.

- Base: 2 pass, 3 fail. Only the two labeled regression guards pass.
- Base with the reference patch: 5 pass, 0 fail (two runs through `check-task.ts` and three direct runs, about 3.2 s for the file each time).
- Recorded attempts rescored against these tests:
  - `results/2026-10-05T18-45-16.841Z` r0 (`baseline-r0-3b8a762a`): 5 of 5.
  - `results/2026-10-05T18-45-16.841Z` r1 (`baseline-r1-cceec180`): 5 of 5.
  - `results/2026-10-05T22-50-19.896Z` r0 (`baseline-r0-2536845b`): 5 of 5.
  - `results/2026-10-05T22-50-19.896Z` r1 (`baseline-r1-2ac2f1c3`): 4 of 5. It fails test 1: after the runtime stopped the service, no model request starts within 3 seconds of the completion.
- Adversarial patches:
  - A design that reads back past the record to the person's message, so that it requires the subagent dispatch: 5 of 5.
  - A patch that waits for the person only after a person's interrupt, placed in the runner lifecycle or in `waitsForPerson`: 5 of 5 in both places.
  - A patch that never waits for the person: 4 of 5. It fails test 4.
  - A patch that resumes the cut turn at attach after a runtime or crash cut: 2 of 5. It fails tests 1 to 3, because a model request starts before the child completes.

## Design variant

- The saved conversation owns the distinction between a background wait and an interrupted turn that still needs a model request. Completion delivery must not bypass interruption rules.
- The last model step before the interruption supplies the evidence: an answer or a finished tool batch containing a background wait qualifies; an interrupted tool result does not.
- A service interruption during a turn that still needs a model request must continue to wait for the person.
- The history reader must reach the preceding model step across a separate stored batch and later system notices.
- The distinction comes from existing conversation history, not another persisted status.
- Reattaching must not start a model request before the child completes. The later completion must start one with the child's result in context.
- A person's interruption must remain in force after child completion. Completion must still wake a parent when no restart occurs.
- A plain service stop has the same recovery behavior as a crash or an update.
