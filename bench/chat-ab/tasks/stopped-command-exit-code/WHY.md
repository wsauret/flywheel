# stopped-command-exit-code

Fix commit: `5c7dcdbd75c69dd05d27e59b219360ef2dda329b` fix(background): show a stopped command as stopped, with no exit code

Base commit: `7954a94ade78ec5093f37e4cc0e83dea9fd4dcd7` (the parent of the fix)

## The bug

When a signal ended a background command, the owned process reported `code: null` with a signal. `startManagedCommand` in `src/orchestration/agent-runtime/tools/managed-command.ts` wrote `exitCode: code ?? 1` into the result, and the notification text said "exited with code unknown". The registry in `background-work.ts` then recorded exit code 1 in the background index, and the /bg row (`src/protocol/client/background-index.ts`) showed "Stopped · exit 1". The made-up code also marked the exit as observed.

The fix carries the exit as either a code or a signal through the settlement, the process table, and the index record. The notification names the signal. The /bg row of a stopped or canceled command shows no exit code, also for records that already hold one.

## Why it is a fair task

1. The symptom is visible in /bg and in the agent's completion note. A user can describe it without the code.
2. The made-up code starts in the managed command settlement and travels through the background work registry, the process table, and the index record to the protocol client row. The solver must read at least four files to see where the number comes from.
3. The row rule for stopped and canceled commands is a separate client decision that the message states.
4. The fix touches 5 src files, about 70 lines. The tests use a mock owned process and a temporary log path under `tmpdir()`, which `temporaryDirectories()` removes. They run in under 1 second.

## Acceptance

`acceptance/stopped-command.test.ts`, 5 tests. Two drive `startManagedCommand` with a mock owned process that a signal ends (a person's Stop, and an unprompted SIGKILL). One guards that a normal exit keeps its code. Two check `backgroundRowDetail`. The text assertions only need the signal name and no "code unknown" text, not the exact wording of the fix.

## Validation evidence

The sandbox is `git archive` of the base at the task paths, with `sandbox.patch` (bunfig test root set to `.`), then `bun install`.

1. Base: 2 pass, 3 fail (both signal tests recorded `exitCode` 1, and the stopped row showed "exit 1").
2. Base plus `git diff 7954a94ad 5c7dcdbd7 -- src`: 5 pass, 0 fail.

## Design variant

- The command owner distinguishes observed numeric exits, observed signal terminations, and unobserved outcomes instead of using an exit code as proof of observation.
- That distinction travels through background tracking and recorded results, including runtime restart and ownership handover paths.
- An observed signal termination is recorded without an exit code; an unobserved outcome stays unrecorded.
- The agent receives the signal name when the platform supplies it, or a generic signal explanation when it does not.
- Launch-failure stderr explanations apply only to exits with a real code, not signal terminations.
- Stop intent remains separate from process outcome: requested stops retain their stopped status, while unsolicited signal terminations count as failures.
- A real zero exit code means success; other real exit codes remain failures.
- Shared row presentation hides exit codes for stopped or canceled commands in both clients and preserves status and duration.
- This display rule covers older records without rewriting them, including numeric codes produced by trapped signals or Windows termination.
- Verification explicitly includes requested stops, unsolicited signals, ordinary exits, and stopped or canceled rows that already contain exit codes.
