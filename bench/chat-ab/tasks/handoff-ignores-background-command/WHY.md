# handoff-ignores-background-command

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(agents): keep subagents active until background work settles".

## The bug

A workflow step decides whether `handoff` may start in `createHandoffTracker` (`src/orchestration/agent-runtime/agent-loop-handoff.ts`), which asks the background work registry (`src/orchestration/agent-runtime/background-work.ts`) through `assertHandoffReady()`. In the bugged tree, `assertHandoffReady()` leaves out every background command: a running command does not count as active work, and the completion notification of a finished command does not count as a result still owed, even while its delivery to the conversation has not committed. So a step can hand off while its own command runs, and the runner ends before the command result reaches the model. Subagents are not affected: a running subagent blocks handoff, and so does its completion notice until the conversation commits it.

The fix removes the exclusion, so `backgroundHandoffBlock` (`src/orchestration/agent-runtime/background-work-readiness.ts`) classifies all owned work: running commands, services, and owed results.

## Why it is a fair task

1. The symptom is a step that ends while its own command still runs. A user can describe it without the code.
2. The solver must trace handoff admission from the agent loop to the registry gate, and see that the gate drops commands from both the running set and the owed results. Both halves are needed: a fix of only the running set still lets the step hand off before the command result reaches the model.
3. The fix touches 1 src file. The tests use in-memory registries and run in under 1 second.

## Acceptance

`acceptance/handoff-background-command.test.ts`, 3 tests. Test 1 checks the registry gate: a running command is active work, and its result is owed until the conversation commits its notification. Test 2 drives the same states through `createHandoffTracker`, the stream-start gate that the agent loop uses: refused while the command runs, refused while its result is owed, admitted after the commit. The text checks only need the command description in the refusal, not exact wording. Test 3 guards the existing subagent gate.

## Sandbox

`sandbox.patch` sets the bunfig test root to `.`, adds the command exclusion to `assertHandoffReady()`, and returns the unit tests that assert command and service gating to a state without those assertions, so the unit suite passes on the bugged tree: `background-task-registry.test.ts`, `background-notification-delivery.test.ts`, `tools-handoff.test.ts` (both stream-start admission tests keep only their subagent and queued-input parts), and `loop-wait-placeholder.test.ts` (the refused-handoff test waits on a subagent, and the service nudge test is removed). In the bugged tree a running service no longer blocks handoff either; the acceptance tests do not check services.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit.

- Base: 1 pass, 2 fail (the gate returns null with a running command, and the tracker admits the handoff).
- Base plus `reference.patch`: 3 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts handoff-ignores-background-command --apply-diff bench/chat-ab/tasks/handoff-ignores-background-command/reference.patch
```

## Design variant

- The existing background-work owner must make the handoff decision and count all active owned work, not only subagents.
- A completed command result must stay owed until the existing result-delivery path confirms delivery to the agent.
- The refusal must distinguish running work from results awaiting delivery and identify each blocker by its description.
- The refusal must explain how to proceed: end the turn, wait for running work or stop it, incorporate delivered results, then retry handoff.
- The change must preserve ordinary chat behavior as well as the existing subagent gate, with verification of both blocked states and eventual successful handoff.
