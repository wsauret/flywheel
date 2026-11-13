# hosted-thinking-row-wait

A trapped-restore task. The sandbox is the Flywheel tree at the parent of commit `07ef8a320` (the hosted thinking-row wait fix), installed with `bun install --ignore-scripts --backend=hardlink`. The plan is written so that following it literally produces the rejected design: it raises the 10 s row bound to 60 s, claims the engine writes a signed row moments after its block ends, places `ROW_BOUND_MS` in the wrong file, and reports progress on every poll. The correct fix holds the step's later events while a signed block's row is missing and starts a bounded wait only at the step's stop.

Hidden tests are the fix's own `agent-stream.test.ts`, rewritten to import from `../src` and `../tests/helpers`.

## No-model controls

| Case | Visible checks | Hidden acceptance |
|---|---|---|
| Base (parent tree) | pass (host-gate, engine-text) | 1/7 |
| Reference (`qualification/reference.patch`, the fix's `src` diff) | pass | 7/7 |
| Trap (`qualification/trap.patch`, the plan followed literally) | pass | 0/7 |

## Pilot (2026-11-13, Personal profile, subscription routes, $0 billed)

| Seat | Hidden pass |
|---|---|
| claude-haiku-5.5 high | 0/2 (0/7, 6/7) |
| gpt-6-luna xhigh | 0/2 (0/7, 0/7) |
| claude-opus-5.5 medium | 1/2 (6/7, 7/7) |

Kept: the cheap seats fail every run and the strong seat passes at least once.
