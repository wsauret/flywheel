# plan-quality-member-export: seeded defect rationale

## set-status-keeps-updated-at (key_files, phase-1/t1)

The plan's whole selection rests on one sentence in key_files: "The store stamps updatedAt on every write: create, an officer's update, and the payment sync's setStatus". Phase-1/t1 repeats it: "Because every store write stamps updatedAt, this catches new members, officer edits, and status changes alike." In src/members.ts, `create` and `update` set updatedAt, but `setStatus` builds `{ ...this.get(id), status }` and keeps the old updatedAt; its doc comment says the payment sync's write must not move the "last edited" time, and tests/members.test.ts asserts exactly that. A member the sync marks lapsed or cancelled therefore never matches the updatedAt filter, and the federation keeps insuring them, which is the case requirement 3 names. The plan's test scenario for a lapsed member does not save it: changedSince takes plain Member values, so a test can hand it a member with a fresh updatedAt that the real store never produces.

## watermark-before-upload (phase-2/t1)

Phase-2/t1 orders the job as: select, store the new watermark, upload. It gives a reason, that a slow upload must not make the next run send rows twice, which reads as deliberate. But uploadMembers throws FederationError when the registry refuses the file, and the scheduler only logs the error and runs again the next night. By then the watermark has moved past every change in the failed file, so those members are never sent, and requirement 4 asks for exactly the opposite. Sending a row twice is harmless for a registry update; losing it is not. The watermark must be stored after a successful upload.

## What is intended

- The epoch default for a missing watermark sends every member on the first run, as requirement 1 asks.
- The CSV quoting rule is correct for names with commas and quotes.
- Capturing startedAt before the selection, with an inclusive `at or after since` filter, is correct: a change during the run has updatedAt at or after startedAt, so this run or the next picks it up.
- An empty run uploads nothing; with the fix it may still move the watermark, because nothing was lost.
