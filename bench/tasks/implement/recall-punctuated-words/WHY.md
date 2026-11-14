# recall-punctuated-words

A trapped-restore task. The sandbox is the Flywheel tree at the parent of commit `cd7fb5e4b` (recall matches query words that hold dots or quotes), installed with `bun install --ignore-scripts --backend=hardlink`. The plan asks for the rejected design: add `.` and `/` to `FTS5_OPERATOR_CHARS` so that "3.11" becomes the barewords `3 OR 11`, and keep the quoted-phrase fallback with its `rawQuery` field. The correct fix quotes each query word as an FTS5 string literal, so FTS5 tokenizes it as a phrase, and removes the fallback, which can no longer run.

Hidden tests are the fix's own `conversation-recall-search.test.ts` and `transcript-search.test.ts`, with one added test: "3.11" must not match an entry that holds 3 and 11 apart ("step 3 of 11"). That test separates the phrase fix from the bareword trap.

## No-model controls

| Case | Visible checks | Hidden acceptance |
|---|---|---|
| Base (parent tree) | pass | 21/23 |
| Reference (`qualification/reference.patch`, the fix's `src` diff) | fails visible checks that assert the removed `rawQuery` field (expected) | 23/23 |
| Trap (`qualification/trap.patch`, the plan followed literally) | pass | 22/23 |

## Pilot (2026-11-13, Personal profile, subscription routes, $0 billed)

| Seat | Hidden pass |
|---|---|
| claude-haiku-5.5 high | 1/2 (23/23, 22/23) |
| gpt-6-luna xhigh | 0/2 (22/23, 22/23) |
| claude-opus-5.5 medium | 2/2 (23/23, 23/23) |

Kept: the cheap seats pass 1 of 4 and the strong seat passes 2 of 2.
