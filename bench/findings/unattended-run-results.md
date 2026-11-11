# Unattended run rules: prompt rules, tool descriptions, and a bounded review

Dates: 2026-11-11. Harness: `bench/harbor/` on Harbor Hub (hosted trials, launcher guide in `bench/harbor/README.md`). The raw rounds, trial stores, and analysis scripts are not in the repository. They stay in local spike worktrees and session scratch directories on the machine that ran them. This page names each run by its round name and run id only.

Two experiments test changes to an unattended chat, the purpose that a benchmark trial runs (`flywheel --headless --acp --unattended`). E4 asks whether one prompt rule or shorter tool descriptions make Haiku do the same work with fewer model requests. E2 asks whether a self-review rule or one bounded reviewer subagent makes Haiku pass more repository tasks, and at what cost. Each arm is one change against a control that runs at the same time from the same base commit. A decision rule was fixed before any trial of each experiment ran.

## Decisions

Decisions (2026-11-11):

- A1 (deliverable-first rule) is not adopted. Requests fell 12.1% and pre-write requests fell 20%, below the 15% and 30% bars. By the rule this is "not detectable at this size", not "no effect".
- A2 (bounded verify rule) is not adopted. Requests fell 11.8%, below the 15% bar, and the interval reaches no change.
- A3 (terse tool descriptions) is acceptable: no loss of passes, fewer tool errors, and no rise in shell refusals or miscalls. On this evidence the shell tool description was shortened in all three of its variants (commit `2d486f14e`). The subagent and message_session descriptions keep their full text, because no trial dispatched a subagent or sent a message, so the benchmark did not test the behavior that those descriptions govern.
- B1 (self-review rule) is not adopted. Its pass difference of +5 sits in the inconclusive band, and the permitted rerun cannot reach a threshold, so the result is "no detectable gain".
- B2 (one bounded reviewer) does not pay. It costs 1.58 times control with no pass gain. Reviewers stay off for unattended runs.

## E4: prompt rules and tool descriptions on Terminal-Bench

### Question

An earlier audit found that much of the request gap on Terminal-Bench is probing before the first deliverable. Do a deliverable-first rule (A1), a bounded verify rule (A2), or shorter tool descriptions (A3) cut model requests without a loss of passes or a rise in tool errors?

### Setup

- Model: `claude-haiku-5.5` at high effort on the Claude subscription of the maintainer's auth profile. Subagents on, with the advisor, reviewer, and ship types off. Skills on. Arm config `bench/harbor/configs/tb-haiku-high-agent-types.toml` (sha256 `2ac9ba3c92481dcfc55a8901039e6682924b139552ceb0e38d30394eece9da05`), the same file in every arm.
- Tasks: the 14 tasks of the `subset` split of `terminal-bench-2.1`, 3 trials per task, 42 trials per arm, 168 measured trials. Nine of the 14 tasks always pass or always fail on Haiku, so the pass rate is a guard, and the request counts are the primary outcome.
- Base commit: `daca9bf56`. Each arm is one local worktree branch with its change committed on top. All four arms started together, at concurrency 4 each.
- Arms. A1 and A2 add one bullet to the `WORKING UNATTENDED` prompt section, which only an unattended chat receives:
  - Control: no change.
  - A1: "Write the first complete version of the requested deliverable at its requested path as soon as you understand the request. Before that, read or run only what that version needs; inspect the rest of the environment when a failure or a named requirement calls for it."
  - A2: "Verification ends at the smallest check that proves each named requirement. Do not run a check again after it passed unless you changed what it covers, and do not add checks that the request does not need."
  - A3: shorter descriptions for three tools, with every tool name and input schema byte-identical to control: shell 2,343 to 1,222 bytes, subagent 3,294 to 1,153 bytes, message_session 2,252 to 1,102 bytes (sizes as rendered in the bring-up trials).
- Uptake: one bring-up trial per arm on `kv-store-grpc` showed the new bullet in the A1 and A2 system prompts and nowhere else, and the three shorter descriptions in A3 with all 14 input-schema hashes equal to control.
- Accounting: billed spend was $0. All 3,319 recorded requests settled as included subscription use. List-equivalent spend was at least $1.44 (control), $0.94 (A1), $0.94 (A2), and $1.14 (A3), and about $4.49 in total with the bring-ups. "At least" because a timed-out trial is priced from its last snapshot. Harbor Hub compute charges are not known.
- Runs (round, run id): `e4-control` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-11T05-31-48.531Z`; `e4-a1` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-11T05-31-48.709Z`; `e4-a2` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-11T05-31-49.687Z`; `e4-a3` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-11T05-31-50.485Z`.

Measures. Requests are model responses per trial, over all sessions. D1 is the number of root-session requests before the first `write` or `edit` call. D1 is not defined for a trial that writes only through the shell, so it rests on 8 or 9 tasks. "After last write" counts requests after the last `write` or `edit`. Each ratio is the geometric mean of per-task ratios to control, with a 90% bootstrap interval over tasks (10,000 resamples). Miscalls are input-validation errors plus repaired calls plus tool identity conflicts.

### Decision rule (fixed before the run)

1. Validity: every round finalizes, the uptake check passes, and only slots that `hill.ts rerun` lists as infrastructure losses are run again.
2. Quality guard for every arm: arm passes minus control passes of -1 or more is no loss, -4 or less rejects the arm, and -2 or -3 starts a rerun of the tasks that differ. A task that falls from 3/3 in control to 0/3 or 1/3 also rejects the arm unless a rerun clears it.
3. A1 is worth promoting if the guard holds, D1 drops by at least 30%, and total requests drop by at least 15% with an interval that excludes no change.
4. A2 is worth promoting if the guard holds and total requests drop by at least 15% with list cost not higher.
5. A3 is acceptable if the guard holds, tool errors are below twice control or below control plus 8, the shell refusal classes rise by fewer than 5, and miscalls are at most control plus 3. A cost gain is not required, because the trimmed bytes are about 0.7% of a trial's cost.
6. A drop smaller than these bars is "not detectable at this size", not "no effect".

### Results

Passes use a Wilson 95% interval. The second pass column leaves out `custom-memory-heap-crash`, which is broken on Hub.

| Arm | Passes /42 | Passes without the broken task | Pass delta | Requests per trial | Request ratio [90%] | List cost per trial | Cost ratio [90%] | Mean wall (median) | Wall ratio [90%] | Timeouts |
|---|---|---|---|---|---|---|---|---|---|---|
| Control | 33 [0.64, 0.88] | 33/39 | | 23.6 | 1 | $0.0343 | 1 | 468 s (257 s) | 1 | 2 |
| A1 | 36 [0.72, 0.93] | 35/39 | +3 | 17.6 | 0.879 [0.786, 0.982] | $0.0223 | 0.827 [0.694, 0.978] | 324 s (224 s) | 0.806 [0.699, 0.942] | 1 |
| A2 | 36 [0.72, 0.93] | 34/39 | +3 | 17.9 | 0.882 [0.780, 1.001] | $0.0224 | 0.840 [0.698, 1.007] | 354 s (216 s) | 0.838 [0.728, 0.985] | 1 |
| A3 | 34 [0.67, 0.90] | 33/39 | +1 | 20.0 | 0.961 [0.882, 1.047] | $0.0271 | 0.928 [0.811, 1.078] | 459 s (232 s) | 0.958 [0.873, 1.064] | 4 |

| Arm | D1 per trial | D1 ratio [90%] | After last write ratio [90%] | Tool errors | Shell refusals | Miscalls |
|---|---|---|---|---|---|---|
| Control | 13.1 | 1 | 1 | 22 of 1,021 | 8 | 8 |
| A1 | 5.8 | 0.798 [0.668, 0.916] | 1.047 [0.903, 1.208] | 12 of 748 | 3 | 8 |
| A2 | 6.5 | 0.855 [0.765, 0.945] | 0.942 [0.717, 1.199] | 15 of 759 | 5 | 6 |
| A3 | 8.7 | 0.950 [0.795, 1.121] | 0.947 [0.811, 1.103] | 18 of 849 | 6 | 9 |

- With tasks that timed out in either arm left out, the request ratios are 0.873 (A1), 0.869 (A2), and 0.938 (A3). No verdict changes.
- No task fell from 3/3 in control to 0/3 or 1/3 in any arm.
- In every arm, 6 to 8 of the input-validation miscalls are the same Haiku `edit` call, which passes `edits` as a string where an array is required.

### Validity

All four rounds finalized with 42 of 42 trials scored, and `hill.ts rerun` listed no lost slots, so nothing ran again. The uptake check passed. Exactly one response of 3,319 was not `ok`: a stream error in one control trial. Every trial ran one session, so no subagent was dispatched in any arm. No usage limit was reached.

### Verdicts

- A1: not promoted. The guard holds, but the 12.1% request drop and the 20% D1 drop are below the 15% and 30% bars. Requests after the last write did not change, so the rule moves no work to the end; it removes some early probing, by an amount this size cannot confirm.
- A2: not promoted. The guard holds, but the 11.8% request drop is below the bar and its interval reaches 1. Requests after the last write, the mechanism this rule targets, show no clear drop.
- A3: acceptable. The guard holds, tool errors (18) are below control (22), shell refusals fell from 8 to 6, and miscalls rose by 1, inside the limit of 3. As the design predicted, no cost gain is shown.

### What the result cannot show

- The control looks like a heavy draw: 23.6 requests per trial is at the top of the range of earlier Haiku rounds on these tasks (20.5 to 23.1). One task, `install-windows-3.11`, dominates the plain means.
- No direct A/A noise floor exists. Four earlier rounds with the same prompt gave request ratios of 0.94 to 0.99 against each other and D1 ratios of 0.75 to 0.80, so the A1 D1 drop sits inside that earlier noise band.
- The pass guard is weak. Nine tasks are saturated, and pass differences of +1 to +3 are noise.
- The result covers Haiku 5.5 on 14 Terminal-Bench tasks only. It says nothing about other models, repository tasks, interactive chat, combined arms, or the subagent and message_session descriptions in use.

## E2: self-review rule and one bounded review on DeepSWE

### Question

Earlier benchmark runs turned reviewers off because they raised cost without a measured gain. Does a self-review rule (B1) or one bounded reviewer subagent (B2) make an unattended Haiku chat pass more repository tasks, and does the gain pay for its cost?

### Setup

- Model: `claude-haiku-5.5` at high effort on the Claude subscription of the maintainer's auth profile, on the second subscription account. Control and B1 use the same arm config as E4. B2 uses `bench/harbor/configs/dswe-haiku-high-review-b2.toml`, which leaves only the quality reviewer role on and assigns it `claude-sonnet-5.5` at low effort on the same subscription.
- Tasks: 23 tasks of `deep-swe-1.1`, 5 attempts per task, 115 trials per arm, 345 measured trials. These are the tasks that neither always passed nor always failed in four earlier Haiku rounds on a 38-task list. The 15 saturated tasks carry no pass signal, so the design moved their attempts to the other tasks.
- Base commit: `origin/main` at `7badb399b`. Each arm is one local worktree branch. All three arms started together.
- Arms. Each treatment adds one bullet to the `WORKING UNATTENDED` prompt section:
  - Control: no change.
  - B1: "Before your final reply, review your own change once. Read the complete diff, including new files, against each requirement that the request names, and fix each requirement that the diff does not meet or meets only in part. This review starts no new exploration: after a fix, run again only the checks that cover it."
  - B2: "When your change is complete and verified and its diff has more than 50 changed lines, get one independent review before your final reply. Dispatch exactly one `reviewer-code-quality` subagent, give it the request's requirements and the command that shows the diff, and dispatch no other reviewer. Wait for it with the process tool for at most 600 seconds in total; if it has not finished by then, stop it and finish without it. Fix each P1 or P2 finding that you confirm against the code and the request, run again only the checks that cover the fix, and do not request a second review."
- Accounting: billed spend was $0. Every request in every arm settled as included subscription use, including all 514 reviewer requests. List-equivalent spend was $26.63 (control), $26.14 (B1), and $40.40 (B2), $93.17 in total. Harbor Hub compute charges are not known.
- Runs (round, run id, Hub job): `e2-control` `flywheel-deep-swe-1.1-claude-haiku-5.5-2026-11-11T08-42-09.716Z` (`9e124720`); `e2-b1` `flywheel-deep-swe-1.1-claude-haiku-5.5-2026-11-11T08-42-11.904Z` (`065d1a4f`); `e2-b2` `flywheel-deep-swe-1.1-claude-haiku-5.5-2026-11-11T08-42-14.136Z` (`8f95085c`).

### Decision rule (fixed before the run)

The design's rule counted passes of 38 tasks x 3 attempts. Before any E2 trial ran, it was rescaled to 23 tasks x 5 attempts: each threshold is a change in expected passes per attempt round, so each is multiplied by 5/3. Delta is arm passes minus control passes of 115, paired by task, with a 95% paired bootstrap interval over the 23 tasks (10,000 draws).

1. Reject an arm if Delta is -10 or less, or if a task at 5/5 in control falls to 0/5 or 1/5 and stays at 1/3 or lower in a 3-attempt rerun.
2. B2 pays only if Delta is +14 or more with a lower bound above 0, the cost ratio is 1.30 or less, the wall ratio is 1.20 or less, and gate V3 holds.
3. B1 pays if Delta is +10 or more with a lower bound above 0 and the cost ratio is 1.10 or less.
4. Inconclusive band, between rejection and the win threshold: run 3 more attempts in control and the arm on tasks whose pass counts differ by 3 or more of 5, then decide again on pooled rates. Still in the band means "no detectable gain", and the arm is not adopted.
5. If both pay, choose B1 unless B2 minus B1 is +10 or more.
6. Any billed spend stops the experiment.

Validity gates, checked before outcomes: V1, each round scores 115 trials; V2, the bring-up trials show uptake; V3, B2 dispatches a reviewer in at least 70% of trials and exactly one in at least 90% of those; V4, non-`ok` model responses are below 2% in each arm.

### Results

Cost and wall ratios are geometric means of per-task ratios to control, with 95% bootstrap intervals.

| Arm | Passes /115 (Wilson 95%) | Delta [95%] | List spend | Cost ratio [95%] | Requests per trial (root) | Request ratio | Mean wall, p90 | Wall ratio [95%] | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| Control | 53 [0.373, 0.552] | | $26.63 | 1 | 81.8 (79.3) | 1 | 1,803 s, 2,547 s | 1 | 2 |
| B1 | 58 [0.414, 0.594] | +5 [-6, +15] | $26.14 | 0.975 [0.93, 1.03] | 79.2 (77.1) | 0.961 | 1,769 s, 2,638 s | 0.974 [0.91, 1.04] | 2 |
| B2 | 52 [0.364, 0.543] | -1 [-12, +11] | $40.40 | 1.581 [1.47, 1.70] | 83.8 (78.5) | 1.039 | 1,910 s, 2,660 s | 1.074 [1.00, 1.16] | 4 |

- B2 minus B1 is -6 [-19, +8].
- Without the stalls that the usage limit caused, the wall ratios are 0.954 (B1) and 1.055 [1.006, 1.114] (B2).
- Control's 53 passes match the 55.0 that the four earlier Haiku rounds predict on these 23 tasks.

How the B2 review worked:

- A reviewer ran in 112 of 115 trials, exactly one each time. All 112 reviews finished inside 600 s (median 59 s, p90 105 s, maximum 454 s), and all before the root's last response.
- A review cost 4.6 requests and $0.129, $14.42 in total. That equals the whole B2 cost increase of $13.77: B2 without its reviewer costs 0.979 times control. The root then made 6.0 more requests per review and changed files after 51 of 112 reviews.
- The design counted findings with the pattern `\bP[12]\b`, which reports a P1 or P2 in 109 of 112 reviews. That count is wrong, because reviewers write "no P1 or P2". A negation-aware count, checked by hand on 20 reviews, finds a P1 or P2 finding in 49 of 112 reviews, 16 of them tagged unverified by the reviewer.
- With a finding, 28 trials passed against 22.8 expected from control's rates on the same tasks. Without a finding, 24 of 63 passed against 28.4 expected. The net is about +0.8, consistent with a Delta of -1. Trial state selects this split, so it is not causal.
- A hand audit of 20 sampled reviews found a P2 in 8 and a P1 in none. In 6 of the 8 the root changed the cited file or a related file. Only one pass looks review-driven: on `ink-grid-box-layout`, the root fixed the cited cell overwrite and passed a task that control passed 0 of 5 times.

### Validity

- V1 passed: 115 trials scored per round, with no infrastructure losses.
- V2 passed: each bring-up passed, the B1 and B2 bullets appear in all 115 first prompts of their arm and in no other arm, and the B2 bring-up ran one quality reviewer on `claude-sonnet-5.5` at low effort as included use.
- V3 passed: a reviewer ran in 97.4% of B2 trials, and exactly one in all of those.
- V4 failed in every arm. Non-`ok` responses were 3.4% (control), 3.3% (B1), and 2.7% (B2), against the 2% gate. Most were usage-limit errors on the second subscription account (165, 172, and 184 per arm), and the rest were engine-host stream errors (138, 118, and 70 per arm). The mean root stall after a non-`ok` response was 430 s to 483 s. Because the arms ran together, the throttling hit all arms alike, but it makes the pass and wall results less certain than the design planned.

### Verdicts

- B1: inconclusive band, so "no detectable gain". The permitted rerun on the one task that differed by 3 or more (`superjson-error-stack-serialization`) can only move Delta to between +4.25 and +8.0, which stays below +10. No rerun was launched, and B1 is not adopted.
- B2: does not pay. The cost ratio of 1.58 is far above the 1.30 limit, and Delta of -1 is far below +14. It is not rejected, because Delta is above -10 and no task collapsed. The permitted rerun (`scc-bounded-memory-spilling`) can only move Delta to between -4.4 and -0.6, and the cost gate fails in every case. Reviewers stay off for unattended runs.

### What the result cannot show

- With the V4 throttling, a pass change smaller than about 10 to 12 trials of 115 is not detectable.
- The 50-line gate in the B2 rule was not tested: almost every DeepSWE diff is above it.
- Most of the B2 cost is the Sonnet price. A cheaper reviewer model would cost less; the reviewer model sweep decides that, not this experiment.
- The result says nothing about other chat models, Terminal-Bench, interactive work, other bounds, several reviewers, or B1 and B2 together.
