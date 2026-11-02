# process-wait-loop-nudge

Fix commit: `aeb5193086d078f5fede5fddbc91957d52e52a33` fix(agent): stop the doom-loop nudge after legitimate process waits

Base commit: `d154a1354b9f4154f91c1473c47a9008ccd6590a` (the parent of the fix)

## The requirement

An agent that waits with the `process` tool on background work that is still running must not get the "Doom loop detected" nudge, also when the nudge would come at the turn end after that work has finished. A real loop must still get the nudge: waits when nothing is running, or the same failing command retried between waits.

## The bug

The repetition guard in `src/orchestration/agent-runtime/doom-loop.ts` removed `process` waits from its history only when the current turn ended with live background work. A `process` wait parks the loop only while work is live, so each parked wait ends a turn with live work. The reply turn after the last completion ends with no live work. At that turn end, the guard read the liveness flag as false and counted all the earlier parked waits. Three waits on a long command or a subagent then produced "Doom loop detected ... Try a different approach."

The reference fix classifies each wait once, at the first turn end after it. A wait whose turn end had live work leaves the history. A wait whose turn end had no live work stays, so a real loop of waits and a repeated failing call between waits still trip the guard. Another correct design classifies each wait when the wait policy accepts it on live work and passes the accepted wait ids to the guard (recorded repeat 0 does this). The tests accept both.

## Why it is a fair task

1. The symptom is a nudge text in the agent's context after legitimate waits. A user can describe it without the code.
2. The cause is a timing error: liveness at a later turn end is applied to earlier waits. To find it, the solver must trace the background-liveness signal from the agent loop and the wait parking (`agent-loop-wait.ts`, `process.ts`, `stream-observers.ts`) into `doom-loop.ts`.
3. The obvious fix, "never count process waits", fails the regression guards: waits that found nothing to wait for must still trip the guard.

## Acceptance

`acceptance/process-wait-nudge.test.ts`, 7 tests. `acceptance/loop-harness.ts` holds copies of two base test fixtures (`RequestToolMap` and `asModelClient`), so the tests do not depend on test files that the solver can edit.

Each test runs the real `runAgentLoop` with the real `createWorkflowLoopObservers` wiring and `createObserverChain([createRepetitionGuard()])`. A scripted model makes the tool calls. Fake tools return ok or error. A fake background registry starts with N live tasks, and each park of the loop finishes one task and wakes the loop with a notification. The scripted model sends the guard the same `tool_use` and `text` stream events that the workflow host maps from runtime events. The tests never build a turn context themselves. They read only the nudges that the observers enqueue, and they count messages that contain "Doom loop detected".

What the tests check:

1. Three waits on three running tasks, then a reply: no nudge (fails on base).
2. Four waits with a limit on four running tasks, then a reply: no nudge (fails on base).
3. Three identical reads (one nudge), then three waits on running work, then a reply: exactly one nudge in total (fails on base, which sends a second nudge after the waits).
4. Regression guard: three waits with nothing running get a nudge. It catches an exemption for every wait.
5. Regression guard: one running task, four waits (the first parks, the other three find nothing), then a reply, get a nudge. It catches an exemption that lasts after the work ran.
6. Regression guard: the same failing bash command and a wait in each of three turns on running work get a nudge. It catches an exemption that also hides the other calls in the turn.
7. Regression guard: the same `process` list in three turns while work runs gets a nudge. It catches an exemption for every `process` action.

What the tests do not check: the nudge wording (single call or sequence), how the guard learns that a wait parked (a turn-end liveness flag, wait ids, or another signal), the names or fields of the turn context, the chat runner wiring, and which file holds the fix.

## Applying the reference

The sandbox is `git archive` of the base at the task paths (including `crates/tokenizer`, which the agent loop needs for token counting), with `sandbox.patch` (bunfig test root set to `.` so that `bun test acceptance` finds the directory), then `bun install`.

Apply the fix commit's source change with:

```
bun --conditions=browser bench/chat-ab/check-task.ts process-wait-loop-nudge --overlay aeb5193086d0:. --overlay-files src/orchestration/agent-runtime/doom-loop.ts
```

The fix commit changes only that file in `src`.

## Validation evidence

1. Base: 4 pass, 3 fail. Tests 1 to 3 fail; the 4 regression guards pass.
2. Reference (fix commit overlay): 7 pass, 0 fail.
3. Recorded run repeat 0 (wait ids from the wait policy): 7 pass, 0 fail.
4. Recorded run repeat 1 (the reference design): 7 pass, 0 fail.
5. Wrong patches built on the reference: every wait exempt, 5 pass and 2 fail (tests 4, 5); exemption that lasts after work ran, 6 pass and 1 fail (test 5); clear the whole history on live work, 4 pass and 3 fail (tests 3, 6, 7); drop every `process` call on live work, 6 pass and 1 fail (test 7).
