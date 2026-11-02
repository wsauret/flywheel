# handoff-ignores-background-command

Fix commit: `0b2de789ba33baafdcbbdbd0932f01e49b47306b` fix(agents): keep subagents active until background work settles

Base commit: `7e28a03747d04a4b464bd6a0b6cde08d74f90a89` (the parent of the fix)

## The bug

The workflow background work registry in `src/orchestration/agent-runtime/background-work.ts` gated handoff with `assertHandoffReady()`. That gate counted only active subagents, and only a settled subagent batch entered the pending bucket. A background command that was still running did not block handoff, and the result of a finished command never entered the pending bucket. So a workflow step or a subagent could call `handoff` (`src/orchestration/agent-runtime/tools/handoff.ts`) while its own background command ran, and the runner ended before the command result reached the model.

The fix counts every active entry in the gate and records a settled standalone notification in the pending bucket. The handoff message names running and unincorporated work in general terms. The same commit also changes a subagent prompt paragraph, which this task does not test.

## Why it is a fair task

1. The symptom is a step that ends while its own command still runs. A user can describe it without the code.
2. The solver must trace handoff from the tool to the registry gate, and see that the gate and the pending bucket both handle only subagents. Two separate changes are needed: the active count and the pending record for a settled command.
3. The fix touches 2 relevant src files, about 25 lines. The tests use in-memory registries and run in under 1 second.

## Acceptance

`acceptance/handoff-background-command.test.ts`, 3 tests. The registry test and the handoff tool test come from the fix commit's test changes. The text checks only need the command description in the refusal, not the new wording. The third test guards the existing subagent gate.

## Validation evidence

The sandbox is `git archive` of the base at the task paths, with `sandbox.patch` (bunfig test root set to `.`), then `bun install`.

1. Base: 1 pass, 2 fail (`assertHandoffReady()` returned null with a running command, and the handoff tool accepted the handoff).
2. Base plus `git diff 7e28a0374 0b2de789b -- src`: 3 pass, 0 fail.

## Design variant

- The existing background-work owner must make the handoff decision and count all active owned work, not only subagents.
- A completed command result must enter the pending state and stay there until the existing result-delivery path confirms delivery to the agent.
- The refusal must distinguish running work from results awaiting delivery and identify each blocker by its description.
- The refusal must explain how to proceed: end the turn, wait for running work or stop it, incorporate delivered results, then retry handoff.
- The change must preserve ordinary chat behavior as well as the existing subagent gate, with verification of both blocked states and eventual successful handoff.
