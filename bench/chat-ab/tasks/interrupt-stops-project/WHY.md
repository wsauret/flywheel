# interrupt-stops-project

## Source

- Fix commit: `c7c1f232deac093ecc3aaef6a493364d8958ad85` "fix(runtime): stop one session without ending every turn in the project" (2026-09-22).
- Base commit: `d7b05a4266e7d441b3692d79e1a8f259c5b0265e` (the parent of the fix).
- Source files in the fix: 2 (`src/orchestration/app-service/project-control-client.ts`, `src/orchestration/app-service/project-execution-channel.ts`), 34 changed lines.

## The bug

The account service sends `chat.interrupt` and `workflow.interrupt` to the project executor over a reattachable channel, and waits a short cooperative window for the answer. If the answer does not come, it calls `terminate`, which hard-stops the whole project executor and ends every running session's turn.

When the socket to the executor dropped while an interrupt was in flight, the channel rejected the call with a plain `Error`. The control client caught every rejection and treated it as a stop that did not land in time, so it escalated at once. A short connection blip during Stop therefore ended every turn in the project. The executor process was alive the whole time, and the reattachable endpoint would have delivered a resent interrupt after the reattach.

The fix makes the detach rejection recognizable and resends the idempotent interrupt while the cooperative window is still open. Any other rejection, and a window that expires before the reattach, still escalate.

## Why it is a fair task

The symptom (other sessions stop) is far from the cause. A solver must connect the control client's interrupt path, the execution channel's detach handling, and the reattachable endpoint's send-waits-for-reattach behavior. The solver must also keep the existing escalation contract for other errors and for a transport that does not come back. The acceptance tests drive the real `connectProjectExecutionChannel` over a real `createReattachableProcessEndpoint` with fake transports, so they do not depend on the name or the shape of any new error type.

## Acceptance

`acceptance/interrupt-across-detach.test.ts`, 5 tests:

1. A chat interrupt in flight when the socket drops is answered after the reattach, and nothing is terminated.
2. The same for a workflow interrupt.
3. A transport that does not reattach inside the window still terminates the session (guard).
4. A non-detach rejection still terminates the session (guard).
5. An interrupt that the executor answers at once terminates nothing (guard).

The sandbox applies `sandbox.patch` (bunfig test root set to `.`) so that `bun test acceptance` finds the directory. The paths include `crates/tokenizer/tokenizer-prebuilt.json` because the import graph loads it.

## Validation

Run from the sandbox root with `bun test acceptance`, sandbox built exactly from `task.json`:

- Base: 3 pass, 2 fail (tests 1 and 2 fail: `terminated` is `["one"]` / `["flow"]` instead of `[]`).
- Base plus the fix commit's `src` changes: 5 pass, 0 fail (repeated 4 times, stable, about 1.5 s).
