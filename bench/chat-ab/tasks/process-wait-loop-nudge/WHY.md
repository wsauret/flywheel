# process-wait-loop-nudge

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(agent): stop the doom-loop nudge after legitimate process waits". Since then the repetition guard moved into the agent loop, which shows it each settled tool batch, so the defect is re-authored for that shape. It poses the same problem.

## The requirement

An agent that waits with the `process` tool on background work that is still running must not get the repetition notice, also when the notice would come after that work has finished. A real loop must still get the notice: waits when nothing is running, or the same failing command retried between waits.

## The bug

The loop (`createSettledBatchObservation` in `src/orchestration/agent-runtime/agent-loop-wait.ts`) names the wait calls of each batch that parked on live work. The repetition guard in `src/orchestration/agent-runtime/doom-loop.ts` leaves a named wait out of its history, except a `process` wait: it keeps every `process` wait, marked, and leaves the marked waits out of its detection only when the current batch parked. Each parked wait batch therefore hides all `process` waits, but the reply response after the last completion parks on nothing. At that point the guard counts all the earlier parked waits. Three waits on a long command or a subagent then produce "The same tool call has repeated 3 or more times ... try a different approach."

The reference fix classifies each wait once, when its own batch settles: a wait that the loop names as parked on live work never enters the history, `process` waits included. A wait that found nothing to wait for stays, so a real loop of waits and a repeated failing call between waits still trip the guard. Another correct design keeps the waits in the history and classifies each one at the first settle after it. The tests accept both.

## Why it is a fair task

1. The symptom is a notice text in the agent's context after legitimate waits. A user can describe it without the code.
2. The cause is a timing error: liveness at a later batch is applied to earlier waits. To find it, the solver must trace the wait policy (`createWaitToolPolicy`, `settleWaitCalls`) and the park decision in `agent-loop-wait.ts` and `agent-loop.ts` into `doom-loop.ts`.
3. The obvious fix, "never count process waits", fails the regression guards: waits that found nothing to wait for must still trip the guard.

## Acceptance

`acceptance/process-wait-nudge.test.ts`, 7 tests. `acceptance/loop-harness.ts` holds copies of base test fixtures (`RequestToolMap` from `tests/helpers/request-tool-surface.ts` and `asModelClient` from `tests/unit/orchestration/agent-runtime/_model-client.ts`), so the tests do not depend on test files that the solver can edit.

Each test runs the real `runAgentLoop` with the real background work registry, the real `process` tool, and the real `ChatTurnMailbox`. A scripted model makes the tool calls. Fake `Read` and `bash` tools return ok or error. The registry starts with N running background commands, and each park of the loop finishes the oldest one, whose completion notification wakes the loop. The first park with nothing running ends the session. The tests count `<repetition_notice>` in the last request that the model received.

What the tests check:

1. Three waits on three running commands, then a reply: no notice (fails on base).
2. Four waits with a `soft_timeout` on four running commands, then a reply: no notice (fails on base).
3. Three identical reads (one notice), then three waits on running work, then a reply: exactly one notice in total (fails on base, which sends a second notice after the waits).
4. Regression guard: three waits with nothing running get a notice. It catches an exemption for every wait.
5. Regression guard: one running command, four waits (the first parks, the other three find nothing), then a reply, get a notice. It catches an exemption that lasts after the work ran.
6. Regression guard: the same failing bash command and a wait in each of three batches on running work get a notice. It catches an exemption that also hides the other calls in the batch.
7. Regression guard: the same `process` list in three batches while work runs gets a notice. It catches an exemption for every `process` action.

What the tests do not check: the notice wording, how the guard learns that a wait parked (wait ids, a per-wait classification, or another signal), the guard's method signature, and which file holds the fix.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.` so that `bun test acceptance` finds the directory. It restores the defect in `doom-loop.ts` only, so other parked waits (a bash yield placeholder, a call that holds a reply wait) stay out of the history as on the base. It also removes the case "a repetition notice after the third identical wait batch keeps the wait that batch opened" from `tests/unit/orchestration/agent-runtime/context/loop-finite-wait.test.ts`, which detects the defect through a second notice after the reply. So `loop-finite-wait.test.ts` and `core/batch-observers.test.ts` pass on the bugged tree, and `reference.patch` restores the removed case.

- Base: 4 pass, 3 fail. Tests 1 to 3 fail; the 4 regression guards pass.
- Base plus `reference.patch`: 7 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts process-wait-loop-nudge --apply-diff bench/chat-ab/tasks/process-wait-loop-nudge/reference.patch
```
