# Unattended run rules: prompt rules, tool descriptions, and a bounded review

Dates: 2026-11-11 (E4 and E2), 2026-11-14 (E5 and E5 on Haiku), 2026-11-15 to 2026-11-16 (E6), and 2026-11-16 (E7). Harness: `bench/harbor/` on Harbor Hub (hosted trials, launcher guide in `bench/harbor/README.md`). The raw rounds, trial stores, and analysis scripts are not in the repository. They stay in local spike worktrees and session scratch directories on the machine that ran them. This page names each run by its round name and run id only.

Four experiments test changes to an unattended chat, the purpose that a benchmark trial runs (`flywheel --headless --acp --unattended`). E4 asks whether one prompt rule or shorter tool descriptions make Haiku do the same work with fewer model requests. E2 asks whether a self-review rule or one bounded reviewer subagent makes Haiku pass more repository tasks, and at what cost. E5 asks, on GPT-6 Luna and with an A/A control, whether a narrower probe rule or E4's deliverable-first rule cuts requests, and E5 on Haiku asks the probe question again on Haiku 5.5. E6 searches, on DeepSeek-V4.1-Flash and GPT-6 Luna, for text in the system prompt that cuts the cost of a trial without a loss of passes, and tests the one text that passed the screen on harder tasks. E7 puts the whole system prompt of another agent in place of ours, and then removes parts of our prompt one at a time, to find the parts that cost money with no gain in passes. Each arm is one change against a control that runs at the same time from the same base commit. A decision rule was fixed before any trial of each experiment ran. E6 and E7 are the exceptions to both: they are sequential searches whose arms ran against pooled baseline rounds, and their rules are given as they were applied.

## Decisions

Decisions (2026-11-11):

- A1 (deliverable-first rule) is not adopted. Requests fell 12.1% and pre-write requests fell 20%, below the 15% and 30% bars. By the rule this is "not detectable at this size", not "no effect".
- A2 (bounded verify rule) is not adopted. Requests fell 11.8%, below the 15% bar, and the interval reaches no change.
- A3 (terse tool descriptions) is acceptable: no loss of passes, fewer tool errors, and no rise in shell refusals or miscalls. On this evidence the shell tool description was shortened in all three of its variants (commit `2d486f14e`). The subagent and message_session descriptions keep their full text, because no trial dispatched a subagent or sent a message, so the benchmark did not test the behavior that those descriptions govern.
- B1 (self-review rule) is not adopted. Its pass difference of +5 sits in the inconclusive band, and the permitted rerun cannot reach a threshold, so the result is "no detectable gain".
- B2 (one bounded reviewer) does not pay. It costs 1.58 times control with no pass gain. Reviewers stay off for unattended runs.

Results (2026-11-14), with the adoption decision left to the maintainer:

- E5 probe-scoped rule: does not pass stage 1. Requests fell 3.6% with an interval that reaches no change, inside the A/A interval.
- E5 deliverable-first rule: does not pass stage 1. Requests did not change (ratio 0.997).
- Because neither treatment passed, stage 2 on DeepSWE did not run.
- E5 on Haiku probe-scoped rule: does not pass stage 1 on `claude-haiku-5.5` either. Requests fell 4.6% [0.878, 1.022], below the bar of 13.2% that the A/A gap of 6.6% sets.

Decisions (2026-11-16):

- E6 finishing rule: not adopted. On the easy set it cut cost to x0.70 on DeepSeek and to x0.80 on Luna with no detectable loss of passes. On the Luna hard set it passed 66 of 168 trials against 80 of 168 for the baseline (p = 0.027) at a cost of x0.73.
- E6 own-words additions to the rule and repair variants of the rule: none is adopted. No addition beat the rule alone on DeepSeek. Among repair variants B, C, D, and E, more passes generally went with less saving, with one reversal: variant D costs less than variant E and passes more. Variant F does not fit that trend. In two hard rounds it passed 41 of 84 trials against 80 of 168 for the baseline (p = 0.83) at a cost of x0.82. Its easy-set savings are small and not significant alone (x0.86 on DeepSeek, p = 0.11, and x0.91 on Luna, p = 0.14), and two rounds of 42 trials do not establish that it keeps both the passes and the saving. No variant is shown to keep both.
- E6 donor text: cannot ship, because it is the system prompt of another agent. It was the ceiling of the search (x0.55 on DeepSeek), and on Luna it did not cut cost (x0.97).
- The wording search stops. The next work is on structural levers, not on the wording of the prompt.
- E7 donor prompts: none is adopted, and a donor prompt cannot ship. On DeepSeek, the prompt of donor agent A in place of ours passed 64 of 84 trials against 58 of 84 (p = 0.32) at a neutral cost of x0.84 (p = 0.009). On Luna, every whole replacement lost passes: 31 to 33 of 84 trials against 80 of 168 (p = 0.014 to 0.053).
- E7 removal of prompt parts: the three suspected parts together, and each of them alone, are not adopted. On Luna they cut cost (x0.64 to x0.85) with fewer passes in every arm (34 to 38 of 84), and on DeepSeek the three parts together did not cut cost (x1.00).
- E7 review-only skills: adopted. The maintainer chose to fix the specific skills that cost money with no gain. Commit `4764d8fe3` takes six skills out of the skill list in every mode (PI-AGENT-132). With the six hidden, two Luna hard rounds passed 41 of 84 trials against 80 of 168 (p = 0.83) at a cost of x0.80 (p = 0.006).

## E4: prompt rules and tool descriptions on Terminal-Bench

### Question

An earlier audit found that much of the request gap on Terminal-Bench is probing before the first deliverable. Do a deliverable-first rule (A1), a bounded verify rule (A2), or shorter tool descriptions (A3) cut model requests without a loss of passes or a rise in tool errors?

### Setup

- Model: `claude-haiku-5.5` at high effort on the Claude subscription of the maintainer's auth profile. Subagents on, with the advisor, reviewer, and ship types off. Skills on. Arm config: the settings of `bench/harbor/configs/haiku-high-agent-types.toml`, the same file in every arm. The arm branches ran a copy that differs only in its first comment line (sha256 `2ac9ba3c92481dcfc55a8901039e6682924b139552ceb0e38d30394eece9da05`).
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

## E5: probe rule scope and the deliverable-first rule on GPT-6 Luna

### Question

An audit found that about 65% of Flywheel's extra model requests per Terminal-Bench trial, against another agent on Haiku, come before the first deliverable, and that most of them are throwaway probe scripts: 4.05 per trial against 1.66. The suspected source is the shell branch of the first `CONSTRAINTS` bullet of the core prompt (`src/infra/definitions/agent-assets/system-prompt.md`), which asks for a probe before each design step and again after it, and says that a cheap probe "is not optional". E4 never changed that rule, and E4 had no A/A control. Does a probe rule scoped to the decision that it serves (probe-scoped), or E4's deliverable-first rule (deliverable-first), cut model requests on another model family without a loss of passes, measured against an A/A noise floor?

### Setup

- Model: `gpt-6-luna` at high effort for every role (chat, title generation, subagent summary, explorer, implementer) on the ChatGPT subscription of the maintainer's auth profile. Subagents on, with the advisor, reviewer, and ship types off. Skills on. Arm config `bench/harbor/configs/tb-luna-high-agent-types.toml` (sha256 `b16cc5a50a0cd9b82c6777cd0cd5ef08094ffc0697bd4b343e91cf4a7e6213e1`), the same file in every arm.
- Stage 1 tasks: the 14 tasks of the `subset` split of `terminal-bench-2.1`, 6 trials per task, 84 trials per arm, 336 measured trials.
- Base commit: `origin/main` at `72455098b`. Each arm is one local worktree branch with its change committed on top. All four arms started together.
- Arms:
  - Control: no change.
  - Control-b: identical to control, as an A/A noise floor.
  - Probe-scoped: for an unattended chat only, the shell branch of the first `CONSTRAINTS` bullet keeps every sentence up to "for those it is a hypothesis." and then says: "Settle such a claim with a throwaway script against the real thing when the claim decides your next step and reading cannot settle it. Do not probe before every design step and again after; where running the deliverable itself can settle the claim, let it be the probe. Keep credentials out of probe output." Every other agent renders the bullet byte for byte as before. An interactive chat does not read this file (it renders the chat body), so its prompt does not change.
  - Deliverable-first: control plus E4's A1 bullet, verbatim, in the `WORKING UNATTENDED` section: "Write the first complete version of the requested deliverable at its requested path as soon as you understand the request. Before that, read or run only what that version needs; inspect the rest of the environment when a failure or a named requirement calls for it."
- Uptake: one bring-up trial per arm on `kv-store-grpc` passed in every arm. Its first system prompt holds the new probe text in probe-scoped only, the A1 bullet in deliverable-first only, and the original probe text in every other arm. With the change and the session ids removed, each arm's first system prompt equals control's, and all 14 tool registrations have the same description and input schema hashes as control.
- Accounting: billed spend was $0. All 7,257 recorded requests settled as included subscription use on the one ChatGPT account. List-equivalent spend was $1.29 (control), at least $1.50 (control-b, one unpriced request), $1.10 (probe-scoped), and $1.23 (deliverable-first), about $5.14 in total with the bring-ups. Harbor Hub compute charges are not known. A separate DeepSWE experiment of another chat ran `gpt-6-luna` on the same subscription account at the same time; no usage limit was reached.
- Runs (round, run id, Hub job): `e5-control` `flywheel-terminal-bench-2.1-gpt-6-luna-2026-11-14T18-19-16.947Z` (`f4163791`); `e5-control-b` `flywheel-terminal-bench-2.1-gpt-6-luna-2026-11-14T18-19-16.926Z` (`ad59c528`); `e5-probe-scoped` `flywheel-terminal-bench-2.1-gpt-6-luna-2026-11-14T18-19-16.925Z` (`8cac941b`); `e5-deliverable-first` `flywheel-terminal-bench-2.1-gpt-6-luna-2026-11-14T18-19-16.964Z` (`9d2852bf`). Concurrency 6 per arm.

Measures. As E4: requests are model responses per trial over all sessions; D1 is the number of root-session requests before the first `write` or `edit` call, where Luna's `apply_patch` tool counts as `edit`; "after last write" counts root requests after the last such call. D1 is not defined for a trial that writes only through the shell, so its ratio rests on 13 tasks. Probes per trial (the mechanism measure) counts the root-session tool calls before the first deliverable write that are throwaway probe scripts: a shell command that runs inline interpreter code (`python -c`, `python3 -I -c`, `python3 - <<`, `node -e`, `bun -e`, `perl -e`, `ruby -e`, `Rscript -e`, or an interpreter fed a heredoc), a shell command that runs a script file under `/tmp` or the session scratch directory, or a `write` of a file under `/tmp` or the scratch directory. The first deliverable write is the first `write` or `edit` call, or the first shell command that writes a file outside `/tmp` and the scratch directory, whichever comes first; a trial with no deliverable write counts its probes over the whole trial. Each ratio is the geometric mean of per-task ratios to control, with a 90% bootstrap interval over tasks (10,000 resamples). The D1 and after-last-write ratios add 1 to each task mean and the probe ratio adds 0.5, so that a task mean of 0 has a ratio. Passes use a Wilson 95% interval. Miscalls are input-validation failures plus repaired tool names plus tool identity conflicts.

### Decision rule (fixed before the run)

1. Validity, as E4: every round finalizes, the uptake check passes, and only slots that `hill.ts rerun` lists as infrastructure losses are run again. Any billed charge stops the experiment.
2. Noise floor: the control-b request ratio to control and its interval. The gap is g = |1 - ratio(control-b)|.
3. A treatment passes stage 1 when its request ratio's 90% interval excludes 1, its point reduction (1 - ratio) is at least 2g, and the quality guard holds.
4. Quality guard: arm passes minus control passes of -1 or more is no loss, -4 or less rejects the arm, and -2 or -3 starts a rerun of the tasks that differ. A task that falls from 6/6 in control to 2/6 or lower rejects the arm unless a rerun clears it.
5. If both treatments pass, the one with the larger request reduction goes to stage 2. If neither passes, the experiment stops after stage 1.
6. Stage 2 runs the chosen arm and a fresh control on the 23 `deep-swe-1.1` tasks of E2, 5 attempts each, 115 trials per arm. Delta is arm passes minus control passes, paired by task, with a 95% paired bootstrap interval over tasks. Stage 2 rejects the arm if Delta is -10 or less, or if a task at 5/5 in control falls to 1/5 or lower and stays at 1/3 or lower in a 3-attempt rerun.
7. A treatment is adopted only if it passes stage 1 and stage 2 does not reject it. The request and cost ratios on DeepSWE are reported in either case.

### Results

| Arm | Passes /84 (Wilson 95%) | Pass delta | Requests per trial | Request ratio [90%] | List cost per trial | Cost ratio [90%] | Mean wall (median) | Wall ratio [90%] | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| Control | 65 [0.67, 0.85] | | 21.6 | 1 | $0.0153 | 1 | 299 s (175 s) | 1 | 0 |
| Control-b | 64 [0.66, 0.84] | -1 | 23.4 | 1.007 [0.924, 1.099] | $0.0179 | 1.009 [0.917, 1.111] | 350 s (185 s) | 0.987 [0.895, 1.090] | 0 |
| Probe-scoped | 65 [0.67, 0.85] | 0 | 19.8 | 0.964 [0.896, 1.031] | $0.0131 | 0.960 [0.881, 1.040] | 296 s (179 s) | 0.965 [0.881, 1.055] | 0 |
| Deliverable-first | 66 [0.69, 0.86] | +1 | 21.7 | 0.997 [0.937, 1.056] | $0.0146 | 0.989 [0.924, 1.057] | 309 s (181 s) | 0.989 [0.930, 1.047] | 0 |

| Arm | D1 per trial | D1 ratio [90%] | After last write ratio [90%] | Probes before the first deliverable per trial | Probe ratio [90%] | Probes per trial, whole trial | Tool errors | Shell refusals | Miscalls |
|---|---|---|---|---|---|---|---|---|---|
| Control | 6.3 | 1 | 1 | 2.08 | 1 | 6.58 | 13 of 2,292 | 0 | 0 |
| Control-b | 8.2 | 1.124 [0.930, 1.389] | 1.030 [0.864, 1.298] | 2.88 | 1.152 [0.934, 1.440] | 6.82 | 18 of 2,466 | 0 | 0 |
| Probe-scoped | 7.5 | 1.076 [0.929, 1.270] | 0.901 [0.806, 0.996] | 1.83 | 0.918 [0.795, 1.048] | 5.89 | 10 of 2,129 | 0 | 0 |
| Deliverable-first | 6.6 | 0.936 [0.773, 1.158] | 1.000 [0.870, 1.175] | 1.85 | 0.923 [0.830, 1.027] | 6.55 | 24 of 2,239 | 0 | 0 |

- Noise floor: control-b against control gives a request ratio of 1.007 [0.924, 1.099], so g = 0.007 and the bar for a treatment is a point reduction of at least 1.4% with an interval that excludes 1. At this size the A/A interval is about plus or minus 9%.
- No trial timed out, so the ratios without timed-out tasks are the same.
- No task fell from 6/6 in control to 2/6 or lower in any arm. The largest per-task falls were one trial each on `bn-fit-modify` and `build-pmars` (6/6 to 5/6) in probe-scoped, and two trials on `install-windows-3.11` (4/6 to 3/6) in control-b and probe-scoped.
- `install-windows-3.11` dominates the plain means: control used 79 requests per trial on it, control-b 98, probe-scoped 51, and deliverable-first 77. The geometric means of per-task ratios weigh it as one task of 14.
- No trial dispatched a subagent, so every trial ran one session.
- With deliverable-first, the first deliverable came through the `write` or `apply_patch` tool in 56 of 84 trials, against 44 in control, so the rule moved writes from the shell to the file tools. It did not move requests.

### Validity

All four rounds finalized with 84 of 84 trials scored, and `hill.ts rerun` listed no lost slots, so nothing ran again. The uptake check passed. Billed spend was $0. Exactly one response of 7,257 was not `ok`: a stream error in one control-b trial on `install-windows-3.11`, whose request is also the one unpriced request. No usage limit or rate limit refusal was recorded.

### Verdicts

- Probe-scoped: does not pass stage 1. Its 3.6% request reduction is above the 1.4% bar, but its interval [0.896, 1.031] includes 1. The guard holds (0 passes difference). The mechanism moved in the predicted direction but by less than the noise: probes before the first deliverable fell 8% [-20%, +5%] and whole-trial probes fell from 6.58 to 5.89 per trial, while D1 did not fall. Requests after the last write fell 10% [0.806, 0.996], so the effect, if any, is less re-verification after the work, not less probing before it.
- Deliverable-first: does not pass stage 1. Requests did not change (0.997 [0.937, 1.056]), the point reduction of 0.3% is below the 1.4% bar, and the interval includes 1. The guard holds (+1).
- Neither treatment passed, so by the rule the experiment stopped after stage 1 and stage 2 on DeepSWE did not run. Neither treatment is adopted by this evidence.

### What the result cannot show

- Luna probes less than the audit's Haiku trials: 2.08 probe scripts per control trial before the first deliverable, against the audit's 4.05 on Haiku, with a different counting rule. The headroom that the rule change targets is about half as large on this model, so a real effect on Haiku can be invisible here.
- A reduction smaller than about 9% is not detectable at 14 tasks x 6 trials, as the A/A interval shows. The probe-scoped point estimate of 3.6% sits inside that band, so "no effect" is not shown either.
- The probe measure is a text pattern over shell commands and was corrected once after a hand check of control trials, before any ratio was read: the first pattern missed interpreter flags before `-c` (as in `python3 -I -c`) and `Rscript -e`. It still misses probe scripts that a shell command writes and runs under another path.
- The result covers GPT-6 Luna at high effort on 14 Terminal-Bench tasks only. It says nothing about Haiku, other models, repository tasks, interactive chat, or the two rules together.

## E5 on Haiku: probe rule scope on Claude Haiku 5.5

### Question

On GPT-6 Luna the probe-scoped rule cut requests by 3.6% [0.896, 1.031], inside the A/A noise. But Luna ran 2.08 probe scripts per control trial before the first deliverable, while the audit that found the gap counted 4.05 on Haiku. Does the same probe-scoped rule cut model requests on `claude-haiku-5.5`, the model where the gap was found, without a loss of passes, measured against an A/A noise floor?

### Setup

- Model: `claude-haiku-5.5` at high effort for every role on Flywheel's Claude engine route, with the `claude setup-token` tokens of the maintainer's two Claude subscription accounts (both keychain items passed, so that a usage limit on one account moves the trial to the other). Subagents on, with the advisor, reviewer, and ship types off. Skills on. Arm config `bench/harbor/configs/haiku-high-agent-types.toml` (sha256 `ec6b20bd0b90b20f8b8f59effae45e578d3e9b7fd00dfc21e7dfcb797efff74c`), the file that E4 used, the same file in every arm.
- Tasks: the 14 tasks of the `subset` split of `terminal-bench-2.1`, 6 trials per task, 84 trials per arm, 252 measured trials.
- Base commit and arms: the E5 arm branches, unchanged. Control, control-b (A/A), and probe-scoped, each on `72455098b` with its E5 arm commit on top; the deliverable-first arm did not run. All three arms started together, at concurrency 6 each.
- Uptake: one bring-up trial per arm on `kv-store-grpc` passed in every arm. Its first system prompt holds the new probe text in probe-scoped only and the original probe text in control and control-b. With the change and the session ids removed, each arm's first system prompt equals control's, and all 14 tool registrations have the same description and input schema hashes as control.
- Quota preflight: the launcher reported both tokens as "not checked", because a login token is its own account of the trial profile, which no host store has observed. It gave no other quota state.
- Accounting: billed spend was $0. All 5,504 recorded usage entries, bring-ups and the rerun included, settled as included subscription use. List-equivalent spend was at least $3.05 (control, one timed-out trial priced from its last snapshot), $3.30 (control-b), and $2.66 (probe-scoped, with its rerun), about $9.03 in total with the bring-ups. The stores record one Claude engine credential lineage per trial, not which of the two accounts served it. Harbor Hub compute charges are not known.
- Runs (round, run id, Hub job): `e5h-control` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-14T21-26-05.208Z` (`5578207d`); `e5h-control-b` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-14T21-26-05.213Z` (`e417da4f`); `e5h-probe-scoped` `flywheel-terminal-bench-2.1-claude-haiku-5.5-2026-11-14T21-26-05.224Z` (`e2feab39`), with one rerun slot (Hub job `03084f1f`). Bring-ups: Hub jobs `d19e7b9e` (control), `5d668366` (control-b), and `ad44defc` (probe-scoped).

Measures: as E5, with the same metric and analysis scripts. Haiku has no `apply_patch` tool, so D1 and "after last write" count the `write` and `edit` calls only.

### Decision rule (fixed before the run)

1. Validity, as E5: every round finalizes, the uptake check passes, and only slots that `hill.ts rerun` lists as infrastructure losses are run again. Any billed charge stops the experiment. A usage limit on both accounts is a hard stop; a rate limit is queueing.
2. Noise floor: the control-b request ratio to control and its interval. The gap is g = |1 - ratio(control-b)|.
3. Probe-scoped passes when its request ratio's 90% interval excludes 1, its point reduction (1 - ratio) is at least 2g, and the quality guard holds.
4. Quality guard: arm passes minus control passes of -1 or more is no loss, -4 or less rejects the arm, and -2 or -3 starts a rerun of the tasks that differ. A task that falls from 6/6 in control to 2/6 or lower rejects the arm unless a rerun clears it.
5. If probe-scoped passes, the result is reported and the experiment stops there. Whether DeepSWE runs is the maintainer's decision, not part of this rule.

### Results

| Arm | Passes /84 (Wilson 95%) | Pass delta | Requests per trial | Request ratio [90%] | List cost per trial | Cost ratio [90%] | Mean wall (median) | Wall ratio [90%] | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| Control | 67 [0.70, 0.87] | | 21.7 | 1 | $0.0363 | 1 | 377 s (156 s) | 1 | 1 |
| Control-b | 70 [0.74, 0.90] | +3 | 23.2 | 1.066 [1.016, 1.118] | $0.0392 | 1.073 [1.028, 1.116] | 378 s (172 s) | 1.058 [1.001, 1.120] | 0 |
| Probe-scoped | 71 [0.75, 0.91] | +4 | 20.2 | 0.954 [0.878, 1.022] | $0.0316 | 0.952 [0.885, 1.019] | 340 s (166 s) | 0.966 [0.885, 1.049] | 0 |

| Arm | D1 per trial | D1 ratio [90%] | After last write ratio [90%] | Probes before the first deliverable per trial | Probe ratio [90%] | Probes per trial, whole trial | Tool errors | Shell refusals | Miscalls |
|---|---|---|---|---|---|---|---|---|---|
| Control | 8.2 | 1 | 1 | 1.35 | 1 | 3.37 | 22 of 1,907 | 0 | 0 |
| Control-b | 8.6 | 1.081 [0.951, 1.235] | 0.905 [0.762, 1.053] | 1.52 | 1.045 [0.875, 1.281] | 4.42 | 21 of 2,024 | 0 | 0 |
| Probe-scoped | 9.6 | 1.061 [0.910, 1.267] | 0.875 [0.733, 1.024] | 1.40 | 0.994 [0.850, 1.181] | 4.07 | 14 of 1,773 | 0 | 0 |

- Noise floor: control-b against control gives a request ratio of 1.066 [1.016, 1.118], so g = 0.066 and the bar for a treatment is a point reduction of at least 13.2% with an interval that excludes 1. The A/A interval excludes 1 itself: an interval over 14 tasks does not hold the trial-to-trial noise of two identical arms, which is why the rule uses 2g as well.
- With the task that timed out in control left out (`mcmc-sampling-stan`), the request ratios are 1.077 (control-b) and 0.956 (probe-scoped).
- No task fell from 6/6 in control to 2/6 or lower in any arm. The only per-task falls were one trial on `custom-memory-heap-crash` (3/6 to 2/6) in control-b and probe-scoped. This task is broken on Hub (see E4).
- `install-windows-3.11` dominates the plain means: control used 76 requests per trial on it, control-b 75, and probe-scoped 67.
- No trial dispatched a subagent, so every trial ran one session. The first deliverable came through the shell in 53 (control), 61 (control-b), and 54 (probe-scoped) of 84 trials.

### Validity

All three rounds finalized with 84 of 84 trials scored. `hill.ts rerun` listed one lost slot, a probe-scoped `cobol-modernization` trial that exited before its first model request (`NonZeroAgentExitCodeError`, 0 requests). It ran again once and passed, and the analysis uses the rerun in its place; after that the plan showed no open attempt. The uptake check passed. Billed spend was $0. Exactly three responses of 5,475 measured were not `ok`: one `output_overflow` in each arm, all on `filter-js-from-html`. No usage limit or rate limit refusal was recorded. One bring-up (control-b) was started twice, because the first push of the agent package to its build repository failed with HTTP 500 before any trial was queued.

### Verdicts

- Probe-scoped: does not pass stage 1. Its 4.6% request reduction is below the 13.2% bar, and its interval [0.878, 1.022] includes 1. The guard holds (+4). The mechanism did not move: probes before the first deliverable did not change (0.994 [0.850, 1.181]) and D1 did not fall. As on Luna, requests after the last write fell most (0.875 [0.733, 1.024]), inside the A/A band of 0.905.
- The experiment stops here by the rule. The rule is not adopted by this evidence.

### What the result cannot show

- The noise floor is larger on Haiku than on Luna: two identical arms differ by 6.6% in requests and 7.3% in cost. A reduction smaller than about 13% is not detectable at 14 tasks x 6 trials on this model.
- The probe measure counts 1.35 probe scripts per Haiku control trial before the first deliverable, against the audit's 4.05 with a different counting rule. A hand check of the 776 shell commands that came before the first `write` or `edit` call in the control trials flagged 170. Most of the missed probes are scripts that a shell heredoc writes into the scratch directory and that the next command runs by a relative path or a shell variable (`cd $S && python3 resid.py`). The pattern does not see these, so the probe ratio covers only part of the probing on Haiku. The rule's effect on that unseen part shows only in the request and D1 ratios, which did not move.
- The result covers Claude Haiku 5.5 at high effort on 14 Terminal-Bench tasks only. It says nothing about other models, repository tasks, interactive chat, or the deliverable-first rule on Haiku.

## E6: wording of the finish, added to the system prompt, on DeepSeek-V4.1-Flash and GPT-6 Luna

### Question

Can text in the system prompt of an unattended chat cut the cost of a trial without a loss of passes? The search had three parts: add sections of the system prompt of another agent (donor text), find the part of that text that has the effect, and write that part in our own words. One candidate survived the screen, a "Finishing" rule of four lines. Does that rule keep its passes on harder tasks?

### Setup

- Models: `deepseek-v4.1-flash-1017` at max effort and `gpt-6-luna` at high effort, each for every role. Subagents on, with the advisor, reviewer, and ship types off. Baseline configs on the experiment branch: `bench/harbor/configs/fh-deepseek-1017-max.toml` (sha256 `d515266e6c62e5e4594720b2c297fc8f4fcbbc0cd30f95762bd6fd5370629294`) and `bench/harbor/configs/tb-luna-high-agent-types.toml` (sha256 `b16cc5a50a0cd9b82c6777cd0cd5ef08094ffc0697bd4b343e91cf4a7e6213e1`).
- Routes. DeepSeek ran through an aggregator route that is pinned to one upstream provider with no fallback, and through a subscription route. One donor round ran on the DeepSeek API. When a route refused a request, the next route served it: the 29 easy rounds record 3,000 refusals with HTTP 429 and 865 with HTTP 402, and 46 of their 1,160 trials have model calls from two routes. Luna ran on the ChatGPT subscription of the maintainer's auth profile.
- Cost measures. The routes cache prompts differently, so a DeepSeek cost in USD is comparable only between rounds on one route. The DeepSeek tables use three measures that do not depend on the route: model calls with measured usage per trial, completion tokens per trial (reasoning plus visible output), and a neutral cost. The neutral cost of a trial is its completion tokens at $1.20 per million plus all its input tokens, cached and uncached, at one blended price. The blended price is the price that charges the input of the baseline pool at $0.30 per million uncached and $0.007 per million cached, which is $0.0333 per million. The Luna tables use the launcher's list-equivalent cost of each trial.
- Tasks: benchmark `frontier-harness-1.1`. Easy set: `fix-git`, `log-summary-date-ranges`, `kv-store-grpc`, `regex-log`, and `cancel-async-tasks`, 8 attempts per task, 40 trials per round. Hard set: `schemelike-metacircular-eval`, `adaptive-rejection-sampler`, `mteb-leaderboard`, `chess-best-move`, `embedding-drift-monitor`, `intrastat-meldung`, and `large-scale-text-editing`, 6 attempts per task, 42 trials per round. All trials of a round start together.
- Arm mechanism: each arm is the baseline config plus a `[diagnostic]` table whose `first_block_text` key holds the tested text. The runtime puts that text before every part of the shipped system prompt. The key exists only on the experiment branch. A diagnostic arm never ships: a text that passes is written into the product prompt in a separate change. The tested text is byte-identical in the DeepSeek and the Luna config of each arm, and the sha256 of every arm config equals the sha256 in its round record.
- Baseline pools: three DeepSeek easy rounds (`screen-shipped-3`, `-4`, `-5`, 120 trials), three Luna easy rounds (`luna-screen-shipped-1`, `-2`, `-3`, 120 trials), four Luna hard rounds (`luna-hard-shipped-1` to `-4`, 168 trials), and one DeepSeek hard round (`ds-hard-shipped-1`, 42 trials). Baseline rounds and arm rounds ran at different times over two days, not side by side.
- Screen size and noise: one easy round is 40 trials. Each of the three DeepSeek baseline rounds is within about 3.4% of their pool on neutral cost (x0.983, x0.984, x1.033). An arm round varies more: the same text measured x0.63 and x0.81 in two rounds (the notes block), and the rule measured x0.76 and x0.64.
- Accounting: the launcher's cost figures total at least $34.96 for the 29 DeepSeek easy rounds, at least $10.00 for the two DeepSeek hard rounds, at least $4.62 for the 25 Luna easy rounds, and at least $25.32 for the 22 Luna hard rounds. "At least" because a timed-out trial is priced from its last snapshot. The Luna figures are list-equivalent. Billed spend and Harbor Hub compute charges were not read.
- Uptake: in every scored trial of every round on this page (3,166 trials), the first assembled system prompt starts with the arm's text, and no baseline trial holds the rule.
- Source archives: each run manifest records the sha256 of the source archive of its run (`source_archive_sha256`), which is the runtime archive in the agent package. The 78 runs hold two digests. Archive A is `5ae56638ce5f951eb333e273a2f05661976edf7ebcae2860e64605502a538444`, in 70 runs. Archive B is `fd3e7145c9dae8fb3abf6c14d7453d318f6d47bfba7a1915d80376ab2693a177`, in 8 runs: donor round 1 on the DeepSeek easy set, and the 7 Luna easy rounds at source commits `c8e7db830`, `54dc1f2ee`, and `889b9efe7`. The run list below names the archive of each group.

The texts. The rule, 380 bytes:

```
# Finishing
Decide once that the work is finished. The moment you begin to plan your final message, the work is finished: write the message and stop.
After that moment, start no new test, edge case, cleanup edit, refactor, or record-keeping step. The only reason to go back is a check that you have just seen fail.
A new doubt at that moment is one sentence in the final message.
```

| Text | Bytes of the first block | Content |
|---|---|---|
| The rule | 380 | The four lines above |
| Role sentence, then the rule | 581 | One paragraph that states the role of the agent, then the rule |
| Whole donor prompt | 17,119 | The whole system prompt of another agent, 13 sections |
| Donor style sections A | 3,179 | Its sections on personality, on short notes before tool calls, and on progress updates |
| Donor style sections B | 6,056 | Its sections on the final message and on the format of the final answer |
| The rule, then donor style sections A and B | 9,617 | |
| The rule, then donor style sections A | 3,560 | |
| The rule, then One check | 902 | One check script holds a case for each named requirement; no one-off command tests a further case |
| The rule, then Scope of the result | 853 | The words of the request set the scope; no edit for a case, caller, or environment that the request does not name |
| The rule, then Questions about behavior | 864 | No reading of library source and no throwaway experiment; the check of the first draft answers the question |
| The rule, then Read once | 782 | No read of a file only to confirm a write that reported success |
| Finishing, second version | 480 | Replaces the rule. Finished means that the result exists and a check of each named thing has passed; a check that passed closes its question |
| The rule, then Open readings | 772 | Choose the reading that the words of the request state, write it as one line, and decide each such question once |
| The rule, then Final message | 640 | The final message has at most six lines and is written with no draft |
| Finishing, second version, then Open readings and Final message | 1,132 | |
| The rule, then Notes while you work | 726 | One sentence of at most 12 words before each group of tool calls; related commands go in one group in the same turn; one sentence at each milestone |
| The rule, then Notes while you work and Final message | 986 | |
| The rule, then notes without the grouping sentence | 633 | |
| The rule, then Grouped tool calls | 604 | Commands that do not depend on each other go in the same turn; a check stays in its own turn after its change |
| Repair variant B | 550 | Replaces the rule. Finished means that every requirement has a check that ran and passed; while a check fails, continue the repair |
| Repair variant C | 561 | The rule after a new first sentence: while a check that you ran still fails, continue the repair until it passes or you have tried every cause that you can name |
| Repair variant D | 581 | The rule and a new last line: the rule is for work that passes, and a check that still fails is not finished work |
| Repair variant E | 566 | The rule with the condition "and no check of your work still fails" in its second sentence, and a last line that asks for a different approach before a failure is reported |
| Repair variant F | 717 | Variant E, and: when the cause is a limit that you cannot change, change the work to fit inside the limit; report a failing check only after two different approaches have failed |

Runs. All source commits are on the experiment branch. Each run id is `flywheel-frontier-harness-1.1-deepseek-v4.1-flash-1017-2026-` or `flywheel-frontier-harness-1.1-gpt-6-luna-2026-` and the suffix below. Seven rounds have a name that holds the name of the donor agent. This page gives each of them a label and its run id only.

- DeepSeek easy set, source commit `4a74708da`, archive A: `screen-shipped-3` `11-15T23-06-35.280Z`; `screen-shipped-4` `11-15T23-43-32.262Z`; `screen-shipped-5` `11-16T00-49-34.519Z`; `screen-t5-finish-once-1` `11-15T23-19-03.587Z`; `screen-t5-finish-once-2` `11-15T23-47-25.596Z`; `screen-t1t5-role-finish-1` `11-16T00-40-59.003Z`; donor round 2 `11-16T00-45-20.894Z`; `screen-t5d-1` `11-15T23-14-56.001Z`.
- DeepSeek easy set, source commit `031304ef0`, archive B: donor round 1 `11-15T16-44-34.590Z`.
- DeepSeek easy set, source commit `2c9c77b81`, archive A: style A round `11-16T02-25-43.374Z`; style B round `11-16T02-17-21.617Z`; rule and style round `11-16T02-13-11.238Z`; `screen-t5-r2-1` `11-16T02-34-09.665Z`; `screen-t5-r3-2` `11-16T02-29-57.453Z`.
- DeepSeek easy set, source commit `714b53b52`, archive A: rule and style A round `11-16T02-45-05.259Z`; `screen-t5-p1-1` `11-16T02-40-50.358Z`; `screen-t5-p1-2` `11-16T03-03-37.608Z`; `screen-t5-p1-r3-1` `11-16T02-57-49.452Z`.
- DeepSeek easy set, source commit `34a9bffa1`, archive A: `screen-t5-b1-1` `11-16T01-03-08.986Z`; `screen-t5-b2-1` `11-16T01-15-55.725Z`.
- DeepSeek easy set, source commit `6f0eb3492`, archive A: `screen-t5-b3-1` `11-16T01-26-56.814Z`; `screen-t5-b4-1` `11-16T01-31-10.115Z`.
- DeepSeek easy set, source commit `e265b95e8`, archive A: `screen-r1-finish-v2-1` `11-16T01-52-10.296Z`; `screen-t5-r3-1` `11-16T02-04-43.380Z`; `screen-r1-r2-r3-1` `11-16T01-47-57.717Z`.
- DeepSeek easy set, source commit `4b58aec98`, archive A: `screen-t5-p1a-1` `11-16T03-11-45.483Z`; `screen-t5-p1b-1` `11-16T03-07-35.190Z`.
- DeepSeek easy set, source commit `35005a413`, archive A: `screen-t5e-1` `11-16T05-00-44.230Z`; `screen-t5f-1` `11-16T04-42-28.265Z`.
- Luna easy set, source commit `c8e7db830`, archive B: `luna-screen-shipped-1` `11-15T18-55-35.173Z`; `luna-screen-shipped-2` `11-15T18-59-47.875Z`; Luna donor round `11-15T19-24-54.403Z`.
- Luna easy set, source commit `54dc1f2ee`, archive B: `luna-screen-shipped-3` `11-15T20-01-37.411Z`; `luna-screen-t1t5-role-finish-1` `11-15T20-05-51.713Z`.
- Luna easy set, source commit `889b9efe7`, archive B: `luna-screen-t5-finish-once-1` `11-15T19-40-29.814Z`; `luna-screen-t5-finish-once-2` `11-15T19-57-45.125Z`.
- Luna easy set, source commit `34a9bffa1`, archive A: `luna-screen-t5-b1-1` `11-16T01-07-23.428Z`; `luna-screen-t5-b2-1` `11-16T01-11-37.130Z`.
- Luna easy set, source commit `6f0eb3492`, archive A: `luna-screen-t5-b3-1` `11-16T01-35-22.464Z`; `luna-screen-t5-b4-1` `11-16T01-39-31.437Z`.
- Luna easy set, source commit `e265b95e8`, archive A: `luna-screen-r1-finish-v2-1` `11-16T02-00-34.177Z`; `luna-screen-t5-r2-1` `11-16T02-08-55.150Z`; `luna-screen-t5-r3-1` `11-16T01-43-45.384Z`; `luna-screen-r1-r2-r3-1` `11-16T01-56-22.868Z`.
- Luna easy set, source commit `714b53b52`, archive A: `luna-screen-t5-p1-1` `11-16T02-49-19.177Z`; `luna-screen-t5-p1-r3-1` `11-16T02-53-37.650Z`.
- Luna easy set, source commit `4b58aec98`, archive A: `luna-screen-t5-p1a-1` `11-16T03-15-59.151Z`; `luna-screen-t5-p1b-1` `11-16T03-20-18.780Z`.
- Luna easy set, source commit `836d88c93`, archive A: `luna-screen-t5b-1` `11-15T22-07-23.526Z`.
- Luna easy set, source commit `7d71cff13`, archive A: `luna-screen-t5c-1` `11-15T22-17-53.050Z`.
- Luna easy set, source commit `4a74708da`, archive A: `luna-screen-t5d-1` `11-15T22-40-01.298Z`; `luna-screen-t5d-2` `11-15T22-48-04.478Z`.
- Luna easy set, source commit `35005a413`, archive A: `luna-screen-t5e-1` `11-16T04-56-29.074Z`; `luna-screen-t5f-1` `11-16T05-05-46.530Z`.
- Hard set, source commit `4e3634443`, archive A: `luna-hard-shipped-1` `11-15T20-35-10.969Z`; `luna-hard-shipped-2` `11-15T21-15-51.536Z`; `luna-hard-t5-finish-once-1` `11-15T20-43-38.208Z`; `luna-hard-t5-finish-once-2` `11-15T21-19-50.213Z`.
- Hard set, source commit `4b58aec98`, archive A: `luna-hard-shipped-3` `11-16T03-25-53.712Z`; `luna-hard-shipped-4` `11-16T03-38-23.464Z`; `luna-hard-t5-finish-once-3` `11-16T03-34-24.553Z`; `luna-hard-t5-finish-once-4` `11-16T03-30-11.646Z`; `luna-hard-t5c-3` `11-16T04-15-21.170Z`; `luna-hard-t5c-4` `11-16T04-27-50.767Z`; `luna-hard-t5d-3` `11-16T04-23-56.854Z`; `luna-hard-t5d-4` `11-16T04-19-44.366Z`.
- Hard set, source commit `836d88c93`, archive A: `luna-hard-t5b-1` `11-15T21-59-07.102Z`; `luna-hard-t5b-2` `11-15T22-03-31.103Z`.
- Hard set, source commit `7d71cff13`, archive A: `luna-hard-t5c-1` `11-15T22-22-01.973Z`; `luna-hard-t5c-2` `11-15T22-25-55.075Z`.
- Hard set, source commit `4a74708da`, archive A: `luna-hard-t5d-1` `11-15T22-51-57.672Z`; `luna-hard-t5d-2` `11-15T22-44-11.040Z`; `ds-hard-shipped-1` `11-15T23-39-28.221Z`; `ds-hard-t5-1` `11-15T23-51-18.706Z`.
- Hard set, source commit `35005a413`, archive A: `luna-hard-t5e-1` `11-16T04-38-08.763Z`; `luna-hard-t5e-2` `11-16T04-47-51.842Z`; `luna-hard-t5f-1` `11-16T05-15-00.699Z`; `luna-hard-t5f-2` `11-16T04-51-55.570Z`.

Measures. Every ratio is task-balanced: the sum over tasks of the arm's mean per trial, divided by the same sum of the baseline pool. Every p value is a two-sided permutation test with 20,000 relabellings inside each task. No p value is adjusted for the number of comparisons on this page, which is more than 100, so a single p near 0.05 is weak evidence.

### Decision rule (as it was applied)

The search was sequential, so this is the rule as it was applied to each candidate, not one rule that was fixed before the first trial:

1. Screen on the easy set: a block is kept only if the rule plus the block beats the rule alone on DeepSeek and loses no passes on Luna.
2. A text that passes the screen runs on the hard set, on both models.
3. A text is published only if it shows no clear loss of passes on the Luna hard set.
4. The repair variants came after the rule failed step 3, and they did not follow steps 1 and 2. They ran on the Luna hard set first, and variants B and C never ran on the DeepSeek easy set.

### Results

Easy set, DeepSeek. Ratios and p values are against the baseline pool, except the last column. A "pooled" row joins the rounds of one text. Each baseline round is compared with the pool that holds it.

| Text | Round | Route | Passes | Calls per trial | Calls ratio (p) | Token ratio (p) | Neutral cost ratio (p) | Neutral cost against the rule alone (p) |
|---|---|---|---|---|---|---|---|---|
| Baseline (no first block) | `screen-shipped-3` | aggregator | 40/40 | 16.1 | x0.99 (0.831) | x0.99 (0.866) | x0.98 (0.859) |  |
| Baseline (no first block) | `screen-shipped-4` | aggregator and subscription | 38/40 | 16.0 | x0.98 (0.760) | x1.02 (0.765) | x0.98 (0.853) |  |
| Baseline (no first block) | `screen-shipped-5` | subscription | 40/40 | 16.8 | x1.03 (0.594) | x0.99 (0.890) | x1.03 (0.701) |  |
| Baseline (no first block) | pooled |  | 118/120 | 16.3 | 1 | 1 | 1 |  |
| The rule | `screen-t5-finish-once-1` | aggregator | 40/40 | 14.3 | x0.88 (0.042) | x0.75 (0.002) | x0.76 (0.010) | x1.08 (0.571) |
| The rule | `screen-t5-finish-once-2` | aggregator and subscription | 40/40 | 12.8 | x0.79 (<0.001) | x0.68 (<0.001) | x0.64 (<0.001) | x0.92 (0.505) |
| The rule | pooled |  | 80/80 | 13.6 | x0.83 (<0.001) | x0.71 (<0.001) | x0.70 (<0.001) |  |
| Role sentence, then the rule | `screen-t1t5-role-finish-1` | subscription | 40/40 | 14.2 | x0.87 (0.050) | x0.73 (0.001) | x0.75 (0.008) | x1.07 (0.621) |
| Whole donor prompt | donor round 1 | DeepSeek API | 40/40 | 12.1 | x0.74 (<0.001) | x0.55 (<0.001) | x0.57 (<0.001) | x0.81 (0.125) |
| Whole donor prompt | donor round 2 | subscription | 39/40 | 11.7 | x0.72 (<0.001) | x0.52 (<0.001) | x0.52 (<0.001) | x0.75 (0.022) |
| Whole donor prompt | pooled |  | 79/80 | 11.9 | x0.73 (<0.001) | x0.54 (<0.001) | x0.55 (<0.001) | x0.78 (0.008) |
| Donor style sections A | style A round | aggregator | 40/40 | 13.7 | x0.84 (0.004) | x0.82 (0.021) | x0.79 (0.014) | x1.13 (0.287) |
| Donor style sections B | style B round | aggregator | 40/40 | 15.7 | x0.96 (0.555) | x0.90 (0.281) | x0.97 (0.801) | x1.39 (0.023) |
| The rule, then donor style sections A and B | rule and style round | aggregator | 39/40 | 11.8 | x0.72 (<0.001) | x0.63 (<0.001) | x0.60 (<0.001) | x0.86 (0.271) |
| The rule, then donor style sections A | rule and style A round | aggregator | 39/40 | 11.2 | x0.68 (<0.001) | x0.61 (<0.001) | x0.58 (<0.001) | x0.83 (0.211) |
| The rule, then One check | `screen-t5-b1-1` | subscription | 40/40 | 15.6 | x0.96 (0.488) | x1.08 (0.320) | x1.03 (0.725) | x1.47 (0.001) |
| The rule, then Scope of the result | `screen-t5-b2-1` | subscription | 39/40 | 15.4 | x0.95 (0.382) | x0.94 (0.419) | x0.93 (0.415) | x1.33 (0.008) |
| The rule, then Questions about behavior | `screen-t5-b3-1` | subscription | 40/40 | 17.7 | x1.09 (0.178) | x1.12 (0.119) | x1.18 (0.057) | x1.68 (<0.001) |
| The rule, then Read once | `screen-t5-b4-1` | subscription | 40/40 | 13.6 | x0.84 (0.008) | x0.81 (0.021) | x0.79 (0.026) | x1.13 (0.376) |
| Finishing, second version | `screen-r1-finish-v2-1` | aggregator and subscription | 40/40 | 16.1 | x0.99 (0.819) | x1.01 (0.905) | x0.99 (0.936) | x1.42 (0.004) |
| The rule, then Open readings | `screen-t5-r2-1` | aggregator | 40/40 | 14.1 | x0.86 (0.020) | x0.83 (0.070) | x0.82 (0.068) | x1.17 (0.268) |
| The rule, then Final message | `screen-t5-r3-1` | aggregator | 39/40 | 14.3 | x0.88 (0.041) | x0.62 (<0.001) | x0.63 (<0.001) | x0.90 (0.399) |
| The rule, then Final message | `screen-t5-r3-2` | aggregator | 39/40 | 14.1 | x0.86 (0.018) | x0.70 (<0.001) | x0.70 (0.001) | x0.99 (0.970) |
| The rule, then Final message | pooled |  | 78/80 | 14.2 | x0.87 (0.005) | x0.66 (<0.001) | x0.66 (<0.001) | x0.95 (0.569) |
| Finishing, second version, then Open readings and Final message | `screen-r1-r2-r3-1` | subscription and aggregator | 39/40 | 13.3 | x0.82 (0.004) | x0.83 (0.037) | x0.76 (0.009) | x1.08 (0.577) |
| The rule, then Notes while you work | `screen-t5-p1-1` | aggregator | 40/40 | 12.3 | x0.76 (<0.001) | x0.67 (<0.001) | x0.63 (<0.001) | x0.90 (0.447) |
| The rule, then Notes while you work | `screen-t5-p1-2` | aggregator | 40/40 | 13.4 | x0.82 (0.003) | x0.81 (0.028) | x0.81 (0.040) | x1.15 (0.296) |
| The rule, then Notes while you work | pooled |  | 80/80 | 12.9 | x0.79 (<0.001) | x0.74 (<0.001) | x0.72 (<0.001) | x1.03 (0.796) |
| The rule, then Notes while you work and Final message | `screen-t5-p1-r3-1` | aggregator | 40/40 | 12.8 | x0.78 (<0.001) | x0.65 (<0.001) | x0.64 (<0.001) | x0.91 (0.512) |
| The rule, then notes without the grouping sentence | `screen-t5-p1a-1` | aggregator | 39/40 | 12.2 | x0.75 (<0.001) | x0.82 (0.025) | x0.75 (0.005) | x1.07 (0.584) |
| The rule, then Grouped tool calls | `screen-t5-p1b-1` | aggregator | 40/40 | 13.5 | x0.83 (0.021) | x0.75 (0.003) | x0.74 (0.010) | x1.05 (0.753) |
| Repair variant D | `screen-t5d-1` | aggregator | 40/40 | 14.7 | x0.90 (0.094) | x0.89 (0.197) | x0.88 (0.192) | x1.25 (0.075) |
| Repair variant E | `screen-t5e-1` | subscription | 40/40 | 16.5 | x1.01 (0.834) | x1.02 (0.823) | x1.06 (0.554) | x1.51 (<0.001) |
| Repair variant F | `screen-t5f-1` | aggregator | 40/40 | 15.3 | x0.94 (0.318) | x0.85 (0.048) | x0.86 (0.114) | x1.23 (0.080) |

Easy set, Luna. Ratios and p values are against the baseline pool. `cancel-async-tasks` is the task with the most failures.

| Text | Rounds | Passes | `cancel-async-tasks` passes | Calls per trial | Cost ratio (p) | Calls ratio (p) | Completion token ratio (p) | Passes against the baseline (p) |
|---|---|---|---|---|---|---|---|---|
| Baseline (no first block) | `luna-screen-shipped-1`, `luna-screen-shipped-2`, `luna-screen-shipped-3` | 115/120 | 21/24 | 11.9 | 1 | 1 | 1 |  |
| The rule | `luna-screen-t5-finish-once-1`, `luna-screen-t5-finish-once-2` | 75/80 | 14/16 | 9.9 | x0.80 (<0.001) | x0.84 (<0.001) | x0.85 (0.001) | 0.736 |
| Role sentence, then the rule | `luna-screen-t1t5-role-finish-1` | 36/40 | 5/8 | 10.5 | x0.84 (0.007) | x0.89 (0.014) | x0.89 (0.058) | 0.215 |
| Whole donor prompt | Luna donor round | 37/40 | 7/8 | 9.3 | x0.97 (0.572) | x0.79 (<0.001) | x0.95 (0.449) | 0.676 |
| The rule, then One check | `luna-screen-t5-b1-1` | 39/40 | 7/8 | 11.0 | x0.99 (0.934) | x0.93 (0.141) | x0.91 (0.136) | 1.000 |
| The rule, then Scope of the result | `luna-screen-t5-b2-1` | 37/40 | 6/8 | 9.8 | x0.87 (0.022) | x0.82 (<0.001) | x0.85 (0.008) | 0.675 |
| The rule, then Questions about behavior | `luna-screen-t5-b3-1` | 35/40 | 4/8 | 10.3 | x0.95 (0.409) | x0.87 (0.006) | x0.87 (0.022) | 0.101 |
| The rule, then Read once | `luna-screen-t5-b4-1` | 37/40 | 6/8 | 9.9 | x0.92 (0.224) | x0.83 (<0.001) | x0.88 (0.054) | 0.668 |
| Finishing, second version | `luna-screen-r1-finish-v2-1` | 36/40 | 6/8 | 10.2 | x0.98 (0.792) | x0.86 (0.001) | x0.92 (0.149) | 0.223 |
| The rule, then Open readings | `luna-screen-t5-r2-1` | 37/40 | 7/8 | 10.0 | x0.98 (0.745) | x0.84 (0.001) | x0.92 (0.157) | 0.676 |
| The rule, then Final message | `luna-screen-t5-r3-1` | 39/40 | 7/8 | 9.4 | x0.86 (0.018) | x0.79 (<0.001) | x0.80 (<0.001) | 1.000 |
| Finishing, second version, then Open readings and Final message | `luna-screen-r1-r2-r3-1` | 38/40 | 7/8 | 10.1 | x0.95 (0.427) | x0.85 (0.001) | x0.87 (0.029) | 1.000 |
| The rule, then Notes while you work | `luna-screen-t5-p1-1` | 34/40 | 5/8 | 8.8 | x0.89 (0.059) | x0.74 (<0.001) | x0.90 (0.065) | 0.026 |
| The rule, then Notes while you work and Final message | `luna-screen-t5-p1-r3-1` | 35/40 | 6/8 | 9.0 | x0.89 (0.065) | x0.76 (<0.001) | x0.91 (0.125) | 0.115 |
| The rule, then notes without the grouping sentence | `luna-screen-t5-p1a-1` | 35/40 | 4/8 | 9.3 | x0.94 (0.323) | x0.78 (<0.001) | x0.91 (0.128) | 0.108 |
| The rule, then Grouped tool calls | `luna-screen-t5-p1b-1` | 39/40 | 8/8 | 9.4 | x0.85 (0.008) | x0.80 (<0.001) | x0.87 (0.027) | 1.000 |
| Repair variant B | `luna-screen-t5b-1` | 37/40 | 7/8 | 11.1 | x0.97 (0.609) | x0.94 (0.182) | x1.09 (0.153) | 0.681 |
| Repair variant C | `luna-screen-t5c-1` | 36/40 | 6/8 | 10.8 | x0.92 (0.143) | x0.91 (0.041) | x0.96 (0.482) | 0.217 |
| Repair variant D | `luna-screen-t5d-1`, `luna-screen-t5d-2` | 77/80 | 14/16 | 10.1 | x0.78 (<0.001) | x0.85 (<0.001) | x0.84 (<0.001) | 1.000 |
| Repair variant E | `luna-screen-t5e-1` | 36/40 | 5/8 | 11.1 | x0.92 (0.158) | x0.93 (0.159) | x0.88 (0.031) | 0.217 |
| Repair variant F | `luna-screen-t5f-1` | 36/40 | 6/8 | 10.3 | x0.91 (0.136) | x0.87 (0.005) | x0.89 (0.069) | 0.224 |

Hard set, per round. A cost that starts with "at least" holds one or more trials that are priced from a snapshot.

| Text | Round | Scored trials | Passes | Cost of the round | `schemelike-metacircular-eval` | `adaptive-rejection-sampler` | `mteb-leaderboard` | `chess-best-move` | `embedding-drift-monitor` | `intrastat-meldung` | `large-scale-text-editing` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | `luna-hard-shipped-1` | 42/42 | 21 | $1.379 | 4/6 | 6/6 | 1/6 | 4/6 | 0/6 | 0/6 | 6/6 |
| Baseline | `luna-hard-shipped-2` | 42/42 | 20 | at least $1.222 | 6/6 | 6/6 | 0/6 | 1/6 | 0/6 | 1/6 | 6/6 |
| Baseline | `luna-hard-shipped-3` | 42/42 | 19 | at least $1.398 | 4/6 | 6/6 | 0/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| Baseline | `luna-hard-shipped-4` | 42/42 | 20 | at least $1.405 | 4/6 | 5/6 | 2/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| The rule | `luna-hard-t5-finish-once-1` | 42/42 | 18 | $1.124 | 3/6 | 6/6 | 1/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| The rule | `luna-hard-t5-finish-once-2` | 42/42 | 17 | at least $0.963 | 4/6 | 4/6 | 0/6 | 2/6 | 0/6 | 1/6 | 6/6 |
| The rule | `luna-hard-t5-finish-once-3` | 42/42 | 14 | at least $0.961 | 2/6 | 4/6 | 0/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| The rule | `luna-hard-t5-finish-once-4` | 42/42 | 17 | $0.922 | 3/6 | 5/6 | 0/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| Repair variant B | `luna-hard-t5b-1` | 42/42 | 17 | $1.193 | 4/6 | 6/6 | 1/6 | 0/6 | 0/6 | 0/6 | 6/6 |
| Repair variant B | `luna-hard-t5b-2` | 42/42 | 21 | at least $1.328 | 4/6 | 6/6 | 1/6 | 4/6 | 0/6 | 0/6 | 6/6 |
| Repair variant C | `luna-hard-t5c-1` | 42/42 | 20 | at least $1.299 | 4/6 | 5/6 | 1/6 | 4/6 | 0/6 | 0/6 | 6/6 |
| Repair variant C | `luna-hard-t5c-2` | 42/42 | 19 | at least $1.114 | 4/6 | 6/6 | 0/6 | 2/6 | 0/6 | 1/6 | 6/6 |
| Repair variant C | `luna-hard-t5c-3` | 42/42 | 19 | at least $1.120 | 6/6 | 5/6 | 1/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Repair variant C | `luna-hard-t5c-4` | 42/42 | 17 | at least $1.287 | 5/6 | 3/6 | 1/6 | 1/6 | 0/6 | 1/6 | 6/6 |
| Repair variant D | `luna-hard-t5d-1` | 42/42 | 18 | $1.096 | 4/6 | 5/6 | 1/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Repair variant D | `luna-hard-t5d-2` | 41/42 | 18 | at least $0.961 | 3/6 | 6/6 | 2/6 | 1/6 | 0/6 | 0/5 | 6/6 |
| Repair variant D | `luna-hard-t5d-3` | 42/42 | 19 | $1.041 | 5/6 | 6/6 | 1/6 | 2/6 | 0/6 | 0/6 | 5/6 |
| Repair variant D | `luna-hard-t5d-4` | 41/42 | 16 | at least $0.930 | 3/6 | 5/6 | 0/5 | 2/6 | 0/6 | 0/6 | 6/6 |
| Repair variant E | `luna-hard-t5e-1` | 42/42 | 17 | at least $1.185 | 5/6 | 4/6 | 0/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Repair variant E | `luna-hard-t5e-2` | 42/42 | 18 | at least $1.185 | 3/6 | 6/6 | 0/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| Repair variant F | `luna-hard-t5f-1` | 42/42 | 19 | $1.088 | 5/6 | 6/6 | 1/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Repair variant F | `luna-hard-t5f-2` | 42/42 | 22 | $1.123 | 4/6 | 6/6 | 3/6 | 2/6 | 0/6 | 1/6 | 6/6 |
| DeepSeek baseline | `ds-hard-shipped-1` | 42/42 | 27 | at least $5.348 | 5/6 | 1/6 | 6/6 | 5/6 | 3/6 | 4/6 | 3/6 |
| DeepSeek, the rule | `ds-hard-t5-1` | 42/42 | 30 | at least $4.656 | 5/6 | 3/6 | 6/6 | 6/6 | 6/6 | 1/6 | 3/6 |

Hard set, pooled per task. "Four tasks" are the four tasks on which the baseline and the rule differ in passes. The cost ratio is task-balanced. For Luna it is on the launcher's cost. For DeepSeek it is on the neutral cost, because the launcher's cost of a DeepSeek round depends on the route.

| Text | Rounds | `schemelike-metacircular-eval` | `adaptive-rejection-sampler` | `mteb-leaderboard` | `chess-best-move` | `embedding-drift-monitor` | `intrastat-meldung` | `large-scale-text-editing` | Four tasks that differ | All 7 tasks | Cost ratio | p against the baseline, four tasks | p against the baseline, all 7 | p against the rule, all 7 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | 4 | 18/24 | 23/24 | 3/24 | 11/24 | 0/24 | 1/24 | 24/24 | 55/96 | 80/168 (47.6%) | 1 |  |  |  |
| The rule | 4 | 12/24 | 19/24 | 1/24 | 9/24 | 0/24 | 1/24 | 24/24 | 41/96 | 66/168 (39.3%) | x0.73 | 0.020 | 0.027 |  |
| Repair variant B | 2 | 8/12 | 12/12 | 2/12 | 4/12 | 0/12 | 0/12 | 12/12 | 26/48 | 38/84 (45.2%) | x0.93 | 0.819 | 0.657 | 0.210 |
| Repair variant C | 4 | 19/24 | 19/24 | 3/24 | 8/24 | 0/24 | 2/24 | 24/24 | 49/96 | 75/168 (44.6%) | x0.89 | 0.371 | 0.490 | 0.193 |
| Repair variant D | 4 | 15/24 | 22/24 | 4/23 | 7/24 | 0/24 | 0/23 | 23/24 | 48/95 | 71/166 (42.8%) | x0.77 | 0.278 | 0.166 | 0.410 |
| Repair variant E | 2 | 8/12 | 10/12 | 0/12 | 5/12 | 0/12 | 0/12 | 12/12 | 23/48 | 35/84 (41.7%) | x0.88 | 0.259 | 0.185 | 0.675 |
| Repair variant F | 2 | 9/12 | 12/12 | 4/12 | 3/12 | 0/12 | 1/12 | 12/12 | 28/48 | 41/84 (48.8%) | x0.82 | 1.000 | 0.830 | 0.044 |
| DeepSeek baseline | 1 | 5/6 | 1/6 | 6/6 | 5/6 | 3/6 | 4/6 | 3/6 | 17/24 | 27/42 (64.3%) | 1 |  |  |  |
| DeepSeek, the rule | 1 | 5/6 | 3/6 | 6/6 | 6/6 | 6/6 | 1/6 | 3/6 | 20/24 | 30/42 (71.4%) | x0.98 (neutral cost) | 0.396 | 0.593 |  |

The trade, per text. Each row pairs the cost ratio with the pass rate.

| Text | DeepSeek easy set: neutral cost ratio | Luna easy set: cost ratio | Luna easy set: passes | Luna hard set: cost ratio | Luna hard set: passes |
|---|---|---|---|---|---|
| Baseline | 1 | 1 | 115/120 (95.8%) | 1 | 80/168 (47.6%) |
| The rule | x0.70 | x0.80 | 75/80 (93.8%) | x0.73 | 66/168 (39.3%) |
| Repair variant D | x0.88 | x0.78 | 77/80 (96.2%) | x0.77 | 71/166 (42.8%) |
| Repair variant F | x0.86 | x0.91 | 36/40 (90.0%) | x0.82 | 41/84 (48.8%) |
| Repair variant E | x1.06 | x0.92 | 36/40 (90.0%) | x0.88 | 35/84 (41.7%) |
| Repair variant C | not run | x0.92 | 36/40 (90.0%) | x0.89 | 75/168 (44.6%) |
| Repair variant B | not run | x0.97 | 37/40 (92.5%) | x0.93 | 38/84 (45.2%) |

- The rule on the easy set: neutral cost x0.70 on DeepSeek (80 of 80 passes) and cost x0.80 on Luna (75 of 80 against 115 of 120, p = 0.74). It became the candidate, and no later text beat it under the decision rule.
- The rule on the Luna hard set: 66 of 168 passes against 80 of 168 (p = 0.027), and 41 of 96 against 55 of 96 on the four tasks that differ (p = 0.020). Every rule round (14 to 18 passes) is below every baseline round (19 to 21). No single task is significant alone (p = 0.14, 0.18, 0.61, and 0.77).
- Where the hard-set saving is: the rule saves $0.36 per round of 42 trials. `intrastat-meldung` gives 49% of that saving with passes equal at 1 of 24, and `schemelike-metacircular-eval` gives 34% with 12 of 24 passes against 18 of 24.
- The rule on the DeepSeek hard set, one round against one round: 30 of 42 passes against 27 of 42 (p = 0.59), calls x0.97 (p = 0.67), completion tokens x1.03, and neutral cost x0.98 (p = 0.80). The rule did not save there. The agent time limit ended 16 rule trials and 14 baseline trials, and 7 and 8 of them failed.
- The donor ceiling: the whole donor prompt gives x0.55 on DeepSeek (79 of 80 passes), which is x0.78 of the rule alone (p = 0.008). On Luna it does not cut cost (x0.97, p = 0.57) and passes 37 of 40.
- The style-section split: sections A alone give x0.79 (p = 0.014) and sections B alone give x0.97 (p = 0.80). The rule with A and B gives x0.60, and the rule with A only gives x0.58, so sections B add nothing (x0.97 between these two rounds, p = 0.84). The two rule-and-style rounds pooled are x0.85 of the rule alone on neutral cost (p = 0.13) and x0.84 on calls (p = 0.005).
- The own-words additions: no added block beats the rule alone on DeepSeek. The lowest single rounds are x0.90 of the rule alone (p = 0.40 and 0.45), and the two texts with a second round are x0.95 (Final message, p = 0.57) and x1.03 (Notes while you work, p = 0.80) when pooled. Four additions cost more than the rule alone (One check x1.47, Scope of the result x1.33, Questions about behavior x1.68, and the second version of Finishing x1.42, each with p below 0.01).
- The notes block on Luna: calls fall to x0.74, but the round passes 34 of 40 (p = 0.026 against the baseline). The two rounds that hold the block pass 69 of 80 against 75 of 80 for the rule alone (p = 0.17).
- The repair variants on the Luna hard set: none differs from the baseline in passes (p = 0.17 to 0.83), and only variant F differs from the rule (p = 0.044). Variants B, C, D, and E order by cost almost as they order by passes (the trade table gives each pair): more passes generally go with less saving, with one reversal, because variant D costs less than variant E and passes more.
- Variant F does not fit that trend. Its two hard rounds pass 19 and 22 of 42 trials. Together that is 41 of 84 against 80 of 168 for the baseline (p = 0.83), at a cost of x0.82, and each of the two rounds costs less than every baseline round ($1.088 and $1.123 against $1.222 to $1.405). On the easy set its savings are small and not significant alone: x0.86 on DeepSeek (p = 0.11) and x0.91 on Luna (p = 0.14). Two rounds of 42 trials do not establish that it keeps both the passes and the saving.
- The repair variants on the DeepSeek easy set: variants D, E, and F cost x1.25, x1.51, and x1.23 of the rule alone (p = 0.075, below 0.001, and 0.080). The repair sentences give back part of the saving.

Mechanism. These counts come from readings of the recorded trials and from text patterns over the reasoning and the tool calls. They are approximate.

- Where the rule saves, DeepSeek easy set: the rule cuts the work after the first plan of the final message. Model calls after the first call whose reasoning turns to the final message fall to x0.54 (p = 0.006), and the calls up to that call do not change (x0.96, p = 0.62). The comparison is the two rule rounds against `screen-shipped-3` and `-4`.
- What the donor text adds to the rule, DeepSeek easy set: the three rounds with the rule use 17,902 completion tokens per trial against 13,329 for the two donor rounds (p below 0.001), and `cancel-async-tasks` and `regex-log` hold 95% of that gap. The gap is in the calls after the first draft: 2.00 calls per trial with 1,000 or more reasoning tokens against 1.23 (p = 0.001). In those calls a check has just passed, and the agent argues again about a choice that it already made. Trials that go back on a new doubt after the first plan of the final message are equally frequent (7 of 120 against 5 of 80).
- Which part of the donor text has the effect: its sections on short notes before grouped tool calls (sections A). Its rules for the format of the final answer (sections B) add nothing. In our own words the notes block does group more: tool calls per model call rise from 1.29 to 1.43 on Luna. It does not beat the rule alone on DeepSeek, and on `kv-store-grpc` 4 of 16 Luna trials with the block ended at the agent time limit, against 0 of 16 with the rule alone.
- Why the rule loses hard-task passes: of the 14 passes lost on the four tasks, 9 are give-ups and 5 are trials that ended in the belief that the work was correct. A give-up is a trial that ends while a check that it ran still fails: 13 rule trials against 4 baseline trials. In `schemelike-metacircular-eval` 10 of 24 rule trials end 1 to 3 calls after a failing check, against 4 of 24. The rule trials stop the repair a mean of 17.6 calls after the first failing check, and the baseline trials continue for 39.2 calls.
- The second cause is speed: in `adaptive-rejection-sampler` 4 rule trials end with their own test green, but that test ran 63 to 147 seconds and the verifier stops it at 60 seconds. A slow test phase occurred in 9 of 24 rule trials and was removed in 3, and in 7 of 24 baseline trials and was removed in 5.
- The failures that the rule does not explain are equal in both arms (36 and 36 on the four tasks).
- Work after the first plan of the final message did not make the baseline pass: in the 31 passing baseline trials that were read on `schemelike-metacircular-eval` and `adaptive-rejection-sampler`, no edit after that point fixed a defect that the verifier tests. The baseline passes because of earlier work: the repair between the first failing check and the first passing check, and the work between the first green run and the final message. The saving of the rule and its loss of passes are the same work: on `schemelike-metacircular-eval` the rule uses 27.6 model calls per trial against 50.8.

### Validity

- Final rounds only. All 29 DeepSeek easy rounds and all 25 Luna easy rounds finalized with 40 of 40 trials scored, and both DeepSeek hard rounds with 42 of 42.
- All hard rounds of the baseline, the rule, and the repair variants are included: 22 on Luna and 2 on DeepSeek.
- Four of the 22 Luna hard rounds ended with the launcher outcome `trials_unverified`, which is fail-closed: `luna-hard-t5b-2` and `luna-hard-t5c-2` with 42 of 42 trials scored, and `luna-hard-t5d-2` and `luna-hard-t5d-4` with 41 of 42. Their ledgers are used here as they are. Variant D therefore has 166 trials.
- No separate A/A arm ran. The baseline rounds of each set are the noise reference.
- The arms and the baseline pools ran at different times, on 15 source commits. Outside the arm configs, those commits differ only in the diagnostic code that reads the configs, its setting definitions, its test, and its documentation. A change of provider load or behavior during the two days is not separated from an arm effect.
- The agent time limit ended 17 trials of the DeepSeek easy rounds, 21 of the Luna easy rounds, 11 of the Luna hard rounds, and 30 of the two DeepSeek hard rounds. A timed-out trial has fewer calls than it would have had, and its cost is a lower bound.
- The mechanism counts rest on hand readings and on text patterns. Luna records reasoning summaries only, so the Luna readings rest on visible text, tool calls, and tool results.

### Verdicts

- The rule is not adopted. It was approved for publication subject to the hard-set check, and it failed that check: on the Luna hard set it loses passes (66 of 168 against 80 of 168, p = 0.027) for a cost of x0.73.
- No own-words addition is adopted. None beats the rule alone on DeepSeek, and the round with the notes block passes 34 of 40 on Luna.
- No repair variant is adopted. Among variants B, C, D, and E, more passes generally go with less saving, with one reversal: variant D costs less than variant E and passes more. Variant F does not fit that trend. In two hard rounds it passes about as many trials as the baseline (41 of 84 against 80 of 168, p = 0.83) at a lower cost (x0.82). Its easy-set savings are small and not significant alone (x0.86 on DeepSeek and x0.91 on Luna), and two rounds of 42 trials do not establish it. No variant is shown to keep both the passes and the saving.
- The donor text cannot ship, because it is the text of another agent. On Luna it also gives no saving (x0.97) at 37 of 40 passes.
- The result is the trade. On these tasks the text that cuts cost cuts the repair of a failing check, and the passes of the hard set come from that repair. No tested wording is shown to separate the two.
- The maintainer's decision of 2026-11-16: do not ship the rule, stop the wording search, and work on structural levers.

### What the result cannot show

- Two models only, each at one effort.
- 5 easy tasks and 7 hard tasks. Two of the hard tasks pass almost never on Luna and one passes always, so four tasks carry the pass result.
- One DeepSeek hard pair only, and it went the other way: 30 of 42 with the rule against 27 of 42, with time-limit failures in both arms (7 and 8). The two rounds also overlapped on the same provider accounts while one route was out of quota: the baseline trials waited 16,626 seconds in total for provider capacity and the rule trials 2,702 seconds, so the pair does not compare the texts alone. Whether the rule loses hard-task passes on DeepSeek is not known.
- One screening round gives an uncertain estimate of an effect: two rounds of one text measured x0.63 and x0.81.
- Variant F has two hard rounds. Its 41 of 84 is not different from the baseline (p = 0.83), and its cost is x0.82. Two rounds of 42 trials cannot show that a text keeps both the passes and the saving.
- Interactive chat and child agents were not tested. Every trial is an unattended chat.
- Which sentence of the donor text has the effect, and whether its position, its length, or its voice has it. The own-words blocks did not reproduce the effect on DeepSeek.

## E7: replacement of the system prompt, and removal of its parts, on the hard set

### Question

E6 found no wording that cuts cost without a loss of passes on the hard set. E7 asks two structural questions on that set. First, does the whole system prompt of another agent, in place of ours and with our tools, cost less and keep the passes? Second, which parts of our prompt cost money with no gain in passes?

### Setup

- Models, tasks, and measures: as the E6 hard set. `deepseek-v4.1-flash-1017` at max effort and `gpt-6-luna` at high effort, each for every role, with the advisor, reviewer, and ship types off. Benchmark `frontier-harness-1.1`, the 7 hard tasks of E6, 6 attempts per task, 42 trials per round, 2 rounds per arm. The agent time limit is 900 seconds per trial.
- Arm mechanism: as E6, a `[diagnostic]` table in the arm config on the experiment branch. E7 uses five keys. `first_block_text` puts a text before the system prompt, as in E6. `drop_prompt_parts` leaves named parts of the shipped system prompt out. `probe_rule_short` puts a short form of the probe bullet of `CONSTRAINTS` in place of the shipped bullet. `skills_hidden` leaves named skills out of the skill list. `skill_rule_off` leaves out the rule that tells the agent to scan the skill triggers and load each skill that matches. A diagnostic arm never ships.
- A replacement arm leaves eight parts of our prompt out: the core doctrine, the core constraints, the proportionality section, the guidelines, the skill catalog, the unattended section, the scratchpad section, and the checkpoint guidance. It puts the donor prompt first. The tools and their descriptions are the shipped ones.
- Baselines. Luna: the four Luna hard baseline rounds of E6 (`luna-hard-shipped-1` to `-4`, 168 trials). DeepSeek: two new rounds of the shipped prompt (`ds-hard-shipped-2` and `-3`, 84 trials). The DeepSeek donor rounds ran in the same hour as `ds-hard-shipped-2` (model requests 17:09 to 18:26 UTC), and the DeepSeek three-parts rounds in the same hour as `ds-hard-shipped-3` (18:52 to 20:03 UTC). The Luna arms ran during the day against the E6 pool, not side by side.
- `ds-hard-shipped-1`, the DeepSeek baseline of E6, is not used. It ran during a provider outage: its trials record 110 refusals with HTTP 429 on the subscription route (weekly usage limit), 109 with HTTP 402 on the DeepSeek API (insufficient balance), and 1,186 with HTTP 429 on the aggregator route, and the aggregator served 1,017 of its 2,025 calls. The E6 DeepSeek hard pair rests on this round.
- Routes. The subscription route served every measured call of `ds-hard-shipped-2`, both donor rounds, and `ds-hard-three-off-1`. In `ds-hard-shipped-3` and `ds-hard-three-off-2` the aggregator route served 4% and 2% of the calls, after 7 and 6 refusals with HTTP 429 on the subscription route. Luna ran on the ChatGPT subscription of the maintainer's auth profile.
- Cost measures: as E6. DeepSeek uses the neutral cost, with a blended input price of $0.0147 per million that the two new DeepSeek baseline rounds give. Luna uses the launcher's list-equivalent cost (rate card).
- Accounting: the launcher's cost figures total at least $20.10 for the 6 DeepSeek rounds and at least $24.16 for the 24 Luna arm rounds. Billed spend and Harbor Hub compute charges were not read.
- Uptake: in every scored trial of all 34 rounds below, baselines included (1,428 trials), the first assembled system prompt agrees with its arm config. The arm's first block starts the prompt. The skill list, the scan-and-load rule, the scratchpad section, the checkpoint guidance, and the long probe bullet are present or absent as the arm states. Where an arm keeps the skill list, the six review-only skills are absent from it only in the arm that hides them.
- Source archives: 30 runs hold archive A of E6. The four runs at source commit `6a0134d4a` hold archive C, `d47c7ba6b610a084ccfa79784c204452817cb5353461d325cfb89e38b7277aa3`.

The arms. Donor agent A is the donor of E6. Donor agent B is a leader of the benchmark score board. Donor agent C is a minimal agent.

| Arm | Model | First block | Left out of our prompt |
|---|---|---|---|
| Donor A, catalog-default prompt | DeepSeek and Luna | 17,119 bytes, the whole donor prompt of E6. Donor A (release 0.164.0) sends this prompt to a model that is not in its model catalog. It is therefore the prompt that donor A sends to DeepSeek, but not the prompt that it sends to Luna | The eight parts |
| Donor A, Luna prompt | Luna | 17,799 bytes, the prompt that donor A (release 0.169.0) sends to `gpt-6-luna` | The eight parts |
| Donor A persistence section, in front | Luna | 1,445 bytes, the section on autonomy and persistence of the donor A Luna prompt | Nothing |
| Donor B prompt | Luna | 4,896 bytes | The eight parts |
| Donor C prompt | Luna | 2,850 bytes | The eight parts |
| Three parts off | DeepSeek and Luna | None | The skill catalog with its scan-and-load rule, the scratchpad section, and the checkpoint guidance; the probe bullet in its short form |
| Skill catalog off | Luna | None | The skill catalog with its scan-and-load rule |
| Scratchpad off | Luna | None | The scratchpad section; the probe bullet in its short form |
| Checkpoint guidance off | Luna | None | The checkpoint guidance |
| Review-only skills hidden | Luna | None | Six skills from the skill list: the four review-principle skills (data integrity, security, elegance, and performance), `mechanism-verification`, and `uat` |
| Scan-and-load rule off | Luna | None | The scan-and-load rule; the skill list stays |
| Web search on | Luna | None | Nothing; the `web` and `web-chatgpt` modules are on, which the baseline config turns off |

Runs. All source commits are on the experiment branch. Each run id is `flywheel-frontier-harness-1.1-deepseek-v4.1-flash-1017-2026-` or `flywheel-frontier-harness-1.1-gpt-6-luna-2026-` and the suffix below. Ten rounds have a name that holds the name of a donor agent. This page gives each of them a label and its run id only.

- DeepSeek, source commit `bd533e1c0`: `ds-hard-shipped-2` `11-16T17-12-37.214Z`; donor A DeepSeek round 1 `11-16T17-03-18.607Z`; donor A DeepSeek round 2 `11-16T17-08-08.106Z`.
- DeepSeek, source commit `6a1252fa8`: `ds-hard-shipped-3` `11-16T18-59-33.385Z`; `ds-hard-three-off-1` `11-16T18-45-13.077Z`; `ds-hard-three-off-2` `11-16T19-05-10.760Z`.
- Luna, source commit `c4448a0f3`: donor A catalog-default Luna round 1 `11-16T06-49-42.770Z`; round 2 `11-16T06-06-50.273Z`; donor B round 1 `11-16T07-19-39.548Z`; donor B round 2 `11-16T06-36-01.051Z`; donor C round 1 `11-16T07-10-10.342Z`; donor C round 2 `11-16T06-55-32.020Z`; `luna-hard-web-1` `11-16T05-51-02.882Z`; `luna-hard-web-2` `11-16T06-16-16.175Z`.
- Luna, source commit `bd533e1c0`: donor A Luna-prompt round 1 `11-16T13-48-19.727Z`; round 2 `11-16T13-59-20.851Z`; `luna-hard-front-autonomy-1` `11-16T13-54-59.998Z`; `luna-hard-front-autonomy-2` `11-16T14-03-41.575Z`.
- Luna, source commit `6a1252fa8`: `luna-hard-three-off-1` `11-16T18-55-36.831Z`; `luna-hard-three-off-2` `11-16T18-51-03.778Z`.
- Luna, source commit `bb5dc1106`: `luna-hard-skills-off-1` `11-16T20-06-32.337Z`; `luna-hard-skills-off-2` `11-16T20-20-13.051Z`; `luna-hard-scratch-off-1` `11-16T20-29-57.123Z`; `luna-hard-scratch-off-2` `11-16T20-15-38.189Z`; `luna-hard-checkpoint-off-1` `11-16T20-24-37.425Z`; `luna-hard-checkpoint-off-2` `11-16T20-11-08.317Z`.
- Luna, source commit `6a0134d4a`: `luna-hard-work-skills-1` `11-16T21-27-03.330Z`; `luna-hard-work-skills-2` `11-16T21-35-40.885Z`; `luna-hard-skill-rule-off-1` `11-16T21-39-35.200Z`; `luna-hard-skill-rule-off-2` `11-16T21-31-25.998Z`.
- Luna baselines: as E6.

Measures: as E6. Every ratio is task-balanced against the baseline pool of its model, and every p value is a two-sided permutation test with 20,000 relabellings inside each task. No p value is adjusted for the number of comparisons.

### Decision rule (as it was applied)

1. A replacement that keeps the passes and cuts cost points to parts of our prompt that cost money. The parts that the replacement removes are then tested on their own.
2. A part is a candidate for removal only if its arm keeps the passes on the Luna hard set and cuts cost there. A cost cut on Luna is checked on DeepSeek where DeepSeek uses the part.
3. A change ships only as a product change with its own intent statement, never as a diagnostic arm.

### Results

DeepSeek, per round. Ratios and p values are against the two new DeepSeek baseline rounds.

| Text | Round | Passes | Timeouts | Calls per trial | Completion tokens per trial | Neutral cost ratio (p) | Cost of the round | `schemelike-metacircular-eval` | `adaptive-rejection-sampler` | `mteb-leaderboard` | `chess-best-move` | `embedding-drift-monitor` | `intrastat-meldung` | `large-scale-text-editing` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | `ds-hard-shipped-2` | 26/42 | 13 | 57.4 | 77,719 | x1.03 | at least $3.519 | 6/6 | 1/6 | 6/6 | 3/6 | 5/6 | 0/6 | 5/6 |
| Baseline | `ds-hard-shipped-3` | 32/42 | 12 | 53.3 | 77,528 | x0.97 (0.654) | at least $3.598 | 6/6 | 1/6 | 6/6 | 6/6 | 5/6 | 3/6 | 5/6 |
| Donor A, catalog-default prompt | round 1 | 35/42 | 10 | 50.8 | 62,475 | x0.83 (0.019) | at least $2.950 | 6/6 | 6/6 | 6/6 | 5/6 | 5/6 | 2/6 | 5/6 |
| Donor A, catalog-default prompt | round 2 | 29/42 | 7 | 52.9 | 64,424 | x0.85 (0.047) | at least $3.003 | 5/6 | 5/6 | 5/6 | 4/6 | 6/6 | 1/6 | 3/6 |
| Three parts off | `ds-hard-three-off-1` | 29/42 | 13 | 60.2 | 87,784 | x1.15 (0.068) | at least $3.910 | 5/6 | 3/6 | 6/6 | 4/6 | 4/6 | 2/6 | 5/6 |
| Three parts off | `ds-hard-three-off-2` | 27/42 | 11 | 51.4 | 65,610 | x0.86 (0.033) | at least $3.115 | 6/6 | 1/6 | 6/6 | 5/6 | 4/6 | 1/6 | 4/6 |

DeepSeek, pooled.

| Text | Passes | Passes against the baseline (p) | `adaptive-rejection-sampler` | Neutral cost ratio (p) | Calls ratio |
|---|---|---|---|---|---|
| Baseline | 58/84 (69.0%) |  | 2/12 | 1 | 1 |
| Donor A, catalog-default prompt | 64/84 (76.2%) | 0.315 | 11/12 | x0.84 (0.009) | x0.94 |
| Three parts off | 56/84 (66.7%) | 0.841 | 4/12 | x1.00 (0.959) | x1.01 |

Luna, per round. A cost that starts with "at least" holds one or more trials that are priced from a snapshot. The baseline rounds are in the E6 table.

| Text | Round | Passes | Cost of the round | `schemelike-metacircular-eval` | `adaptive-rejection-sampler` | `mteb-leaderboard` | `chess-best-move` | `embedding-drift-monitor` | `intrastat-meldung` | `large-scale-text-editing` |
|---|---|---|---|---|---|---|---|---|---|---|
| Donor A, catalog-default prompt | round 1 | 17/42 | $0.792 | 3/6 | 6/6 | 2/6 | 1/6 | 0/6 | 0/6 | 5/6 |
| Donor A, catalog-default prompt | round 2 | 16/42 | $0.655 | 5/6 | 5/6 | 0/6 | 0/6 | 0/6 | 0/6 | 6/6 |
| Donor A, Luna prompt | round 1 | 13/42 | $0.758 | 2/6 | 6/6 | 1/6 | 0/6 | 0/6 | 0/6 | 4/6 |
| Donor A, Luna prompt | round 2 | 18/42 | $0.774 | 4/6 | 6/6 | 1/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Donor A persistence section, in front | `luna-hard-front-autonomy-1` | 21/42 | at least $1.397 | 4/6 | 6/6 | 2/6 | 2/6 | 0/6 | 1/6 | 6/6 |
| Donor A persistence section, in front | `luna-hard-front-autonomy-2` | 21/42 | at least $1.577 | 6/6 | 6/6 | 0/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| Donor B prompt | round 1 | 15/42 | $0.909 | 3/6 | 6/6 | 0/6 | 0/6 | 0/6 | 0/6 | 6/6 |
| Donor B prompt | round 2 | 18/42 | at least $0.978 | 5/6 | 5/6 | 1/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Donor C prompt | round 1 | 16/42 | $0.594 | 4/6 | 6/6 | 0/6 | 1/6 | 0/6 | 0/6 | 5/6 |
| Donor C prompt | round 2 | 15/42 | $0.646 | 3/6 | 5/6 | 0/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Three parts off | `luna-hard-three-off-1` | 19/42 | at least $0.872 | 4/6 | 5/6 | 0/6 | 4/6 | 0/6 | 0/6 | 6/6 |
| Three parts off | `luna-hard-three-off-2` | 19/42 | at least $0.955 | 4/6 | 6/6 | 1/6 | 1/6 | 0/6 | 1/6 | 6/6 |
| Skill catalog off | `luna-hard-skills-off-1` | 19/42 | $0.901 | 4/6 | 4/6 | 1/6 | 4/6 | 0/6 | 0/6 | 6/6 |
| Skill catalog off | `luna-hard-skills-off-2` | 17/42 | $0.839 | 3/6 | 6/6 | 0/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Scratchpad off | `luna-hard-scratch-off-1` | 17/42 | at least $1.302 | 4/6 | 6/6 | 0/6 | 0/6 | 0/6 | 1/6 | 6/6 |
| Scratchpad off | `luna-hard-scratch-off-2` | 17/42 | at least $0.994 | 5/6 | 6/6 | 0/6 | 0/6 | 0/6 | 0/6 | 6/6 |
| Checkpoint guidance off | `luna-hard-checkpoint-off-1` | 19/42 | at least $1.066 | 5/6 | 5/6 | 0/6 | 3/6 | 0/6 | 0/6 | 6/6 |
| Checkpoint guidance off | `luna-hard-checkpoint-off-2` | 18/42 | $1.141 | 5/6 | 6/6 | 0/6 | 1/6 | 0/6 | 0/6 | 6/6 |
| Review-only skills hidden | `luna-hard-work-skills-1` | 22/42 | at least $1.160 | 5/6 | 6/6 | 1/6 | 3/6 | 0/6 | 1/6 | 6/6 |
| Review-only skills hidden | `luna-hard-work-skills-2` | 19/42 | at least $0.995 | 5/6 | 5/6 | 1/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Scan-and-load rule off | `luna-hard-skill-rule-off-1` | 19/42 | $1.165 | 5/6 | 6/6 | 0/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Scan-and-load rule off | `luna-hard-skill-rule-off-2` | 21/42 | at least $1.090 | 6/6 | 6/6 | 1/6 | 2/6 | 0/6 | 0/6 | 6/6 |
| Web search on | `luna-hard-web-1` | 28/42 | at least $1.305 | 5/6 | 6/6 | 5/6 | 6/6 | 0/6 | 0/6 | 6/6 |
| Web search on | `luna-hard-web-2` | 24/42 | at least $1.299 | 6/6 | 5/6 | 4/6 | 3/6 | 0/6 | 0/6 | 6/6 |

Luna, pooled. The baseline is the four E6 baseline rounds. The cost ratio is on the launcher's cost.

| Text | Passes | Passes against the baseline (p) | Mean cost of a round | Cost ratio (p) | `schemelike-metacircular-eval` | `adaptive-rejection-sampler` | `mteb-leaderboard` | `chess-best-move` | `intrastat-meldung` | `large-scale-text-editing` |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | 80/168 (47.6%) |  | $1.351 | 1 | 18/24 | 23/24 | 3/24 | 11/24 | 1/24 | 24/24 |
| Donor A, catalog-default prompt | 33/84 (39.3%) | 0.053 | $0.723 | x0.54 (<0.001) | 8/12 | 11/12 | 2/12 | 1/12 | 0/12 | 11/12 |
| Donor A, Luna prompt | 31/84 (36.9%) | 0.018 | $0.766 | x0.57 (<0.001) | 6/12 | 12/12 | 2/12 | 1/12 | 0/12 | 10/12 |
| Donor A persistence section, in front | 42/84 (50.0%) | 0.659 | $1.487 | x1.10 (0.228) | 10/12 | 12/12 | 2/12 | 5/12 | 1/12 | 12/12 |
| Donor B prompt | 33/84 (39.3%) | 0.045 | $0.944 | x0.70 (<0.001) | 8/12 | 11/12 | 1/12 | 1/12 | 0/12 | 12/12 |
| Donor C prompt | 31/84 (36.9%) | 0.014 | $0.620 | x0.46 (<0.001) | 7/12 | 11/12 | 0/12 | 2/12 | 0/12 | 11/12 |
| Three parts off | 38/84 (45.2%) | 0.671 | $0.913 | x0.68 (<0.001) | 8/12 | 11/12 | 1/12 | 5/12 | 1/12 | 12/12 |
| Skill catalog off | 36/84 (42.9%) | 0.291 | $0.870 | x0.64 (<0.001) | 7/12 | 10/12 | 1/12 | 6/12 | 0/12 | 12/12 |
| Scratchpad off | 34/84 (40.5%) | 0.101 | $1.148 | x0.85 (0.047) | 9/12 | 12/12 | 0/12 | 0/12 | 1/12 | 12/12 |
| Checkpoint guidance off | 37/84 (44.0%) | 0.489 | $1.104 | x0.82 (0.006) | 10/12 | 11/12 | 0/12 | 4/12 | 0/12 | 12/12 |
| Review-only skills hidden | 41/84 (48.8%) | 0.834 | $1.078 | x0.80 (0.006) | 10/12 | 11/12 | 2/12 | 5/12 | 1/12 | 12/12 |
| Scan-and-load rule off | 40/84 (47.6%) | 1.000 | $1.127 | x0.83 (0.022) | 11/12 | 12/12 | 1/12 | 4/12 | 0/12 | 12/12 |
| Web search on | 52/84 (61.9%) | 0.001 | $1.302 | x0.96 (0.620) | 11/12 | 11/12 | 9/12 | 9/12 | 0/12 | 12/12 |

`embedding-drift-monitor` passes 0 times in every Luna arm, so the pooled table leaves it out.

Skill loads. A load is a call of the skill tool with the action `load`.

| Arms | Trials | Trials that load a skill | Loads | Trials that load one of the six review-only skills |
|---|---|---|---|---|
| Luna baseline | 168 | 147 | 275 | 20 (17 on `intrastat-meldung`, 2 on `embedding-drift-monitor`, 1 on `schemelike-metacircular-eval`) |
| DeepSeek baseline | 84 | 14 | 21 | 0 |
| Luna, review-only skills hidden | 84 | 67 | 101 | 0 |
| Luna, scan-and-load rule off | 84 | 41 | 73 | 3 (all on `intrastat-meldung`) |

- Luna baseline loads per skill: `implementation` 97, `verification` 60, `test-driven-development` 30, `systematic-debugging` 25, `research` 24, `data-integrity-review-principles` 13, `uat` 9, `mechanism-verification` 6, `root-cause-analysis` 4, `implementation-planning` 3, `security-review-principles` 2, `elegance-review-principles` 2, and `performance-review-principles` 0.
- Luna baseline loads per task: every trial of `adaptive-rejection-sampler` (`implementation` 24, `test-driven-development` 20), `embedding-drift-monitor` (`systematic-debugging` 24), `mteb-leaderboard` (`research` 24), and `schemelike-metacircular-eval` (`implementation` 24) loads a skill. On `intrastat-meldung`, 21 of 24 trials load a skill: `verification` 14, `data-integrity-review-principles` 12, `uat` 9, `mechanism-verification` 6, and `security-review-principles` 2.
- `intrastat-meldung` is where the review-only skills cost money. In the Luna baseline, the 17 trials on it that load one of the six cost $0.120 each and pass 0 times. The 7 other trials cost $0.110 each and pass once. With the six hidden, its 12 trials cost $0.089 each and pass once. Of the saving of the hidden arm, 61% is on `intrastat-meldung` and 21% on `schemelike-metacircular-eval`.
- DeepSeek loads few skills: 14 of 84 baseline trials load one, and no trial loads one of the six. This agrees with the result that the three parts off cut cost on Luna but not on DeepSeek.

Mechanism of the DeepSeek donor gain. These counts come from the verifier output and the tool calls of the recorded trials. The reading of the trials is approximate.

- The donor gain is on `adaptive-rejection-sampler`: 11 of 12 passes against 2 of 12. The shipped trials of that task make few calls (8.0 and 5.5 per trial in the two baseline rounds, against 18.7 and 28.8 with the donor prompt). All 12 baseline trials of that task end at the time limit, and 2 of them pass. With the donor prompt, 7 of 12 end at the time limit, and 6 of those 7 pass.
- A trial that ends at the time limit with the deliverable file still absent (the verifier reports the file as missing): 11 of 84 baseline trials (7 on `adaptive-rejection-sampler`, 3 on `chess-best-move`, 1 on `large-scale-text-editing`), 0 of 84 donor trials, and 8 of 84 three-parts-off trials. On `adaptive-rejection-sampler` this is 7 of the 12 baseline trials.
- In the shipped trials that were read, the agent plans the whole file in its reasoning, and then does other work before the first write: skill loads (`implementation`, `test-driven-development`), prototype scripts in the scratchpad, and checkpoint writes. One trial wrote its checkpoint "About to write /app/ars.R" and then reached the time limit with no file.
- The three parts off do not remove this delay on DeepSeek: 4 of 12 passes on `adaptive-rejection-sampler` and 8 timeouts with no deliverable.

Web search and an answer leak. With web search on, Luna passed 52 of 84 trials against 80 of 168 (p = 0.001). Most of the gain is on `mteb-leaderboard` (9 of 12 against 3 of 24). The searches that the agent made were general, but in all 12 web trials of that task the search results held a page about the benchmark task: its source, its page on the benchmark hub, or an explorer of benchmark results. In 11 of the 12, the expected answer appeared in the text of the results. No trial opened such a page. The pass gain on that task is therefore not evidence of a better agent, and the baseline config keeps web search off.

### Validity

- All 30 new rounds finalized with 42 of 42 trials scored.
- Three Luna rounds ended with the launcher outcome `trials_unverified`, which is fail-closed: donor A catalog-default round 2 and both donor A Luna-prompt rounds, each with 42 of 42 trials scored. Their ledgers are used here as they are.
- Each arm has 2 rounds of 42 trials. The noise between rounds is large: the four Luna baseline rounds pass 19 to 21 of 42, and the two DeepSeek baseline rounds pass 26 and 32 of 42.
- The Luna arms ran during the day against baseline rounds of E6, on 7 source commits with the two baseline commits of E6. Outside the arm configs, those commits differ only in the diagnostic code that reads the configs, its setting definitions, its test, and its documentation. A change of provider behavior during the day is not separated from an arm effect.
- The Luna costs are rate-card costs, not billed spend. Each DeepSeek cost ratio is on the neutral cost, because the launcher's cost depends on the route.
- The agent time limit ended 3 of 168 Luna baseline trials, 25 of 84 DeepSeek baseline trials, 17 of 84 DeepSeek donor trials, and 24 of 84 DeepSeek three-parts trials. A timed-out trial has fewer calls than it would have had, and its cost is a lower bound.

### Verdicts

- Donor prompts: not adopted, and a donor prompt cannot ship. On DeepSeek the donor A prompt passes as many trials (64 of 84 against 58 of 84, p = 0.32) at x0.84 of the neutral cost (p = 0.009). On Luna every whole replacement cuts cost (x0.46 to x0.70) and loses passes (31 to 33 of 84 against 80 of 168, p = 0.014 to 0.053). This holds also for the prompt that donor A sends to Luna itself. The donor A persistence section in front of our prompt keeps the passes (42 of 84) and does not cut cost (x1.10).
- Three parts off: not adopted. On DeepSeek it gives no gain: 56 of 84 passes and x1.00 of the neutral cost. On Luna it cuts cost to x0.68 with 38 of 84 passes.
- Single parts on Luna: not adopted. Every single part off cuts cost, and every arm passes fewer trials than the baseline rate: skill catalog off x0.64 with 36 of 84, scratchpad off x0.85 with 34 of 84, and checkpoint guidance off x0.82 with 37 of 84. No pass difference is significant alone (p = 0.10 to 0.49).
- Skill spikes on Luna: both keep the passes. With the six review-only skills hidden the arm passes 41 of 84 (p = 0.83) at x0.80 (p = 0.006). With the scan-and-load rule off it passes 40 of 84 (p = 1.00) at x0.83 (p = 0.022). The six review-only skills are the specific skills that cost money with no gain, and the other skills stay in the list.
- The maintainer's decision of 2026-11-16: fix the specific skills, not skills in general. Commit `4764d8fe3`, "perf(skills): stop agents loading review-only skills on their own", takes the six skills out of the skill list in every mode (PI-AGENT-132). A review or a reviewer that composes them still gets their full text.
- Confirmation of the published change: two Luna hard rounds of the shipped build, `luna-hard-lens-fix-1` and `-2`, ran at source commit `8c14dfe7c` with the baseline config (runs `11-17T00-40-28.311Z` and `11-17T00-44-54.838Z`). They passed 22 and 20 of 42, 42 of 84 (50.0%) against 80 of 168 (47.6%), at $1.179 and $1.228 per round, a mean of $1.20 against $1.351 (x0.89). No trial loaded one of the six skills. The passes hold. The saving is smaller than the x0.80 of the spike rounds; both treatments together give 83 of 168 at x0.84, so the true saving is probably between 10% and 20%. Most of it is on intrastat-meldung ($0.59 and $0.61 per round against about $0.70).

### What the result cannot show

- Two rounds of 42 trials per arm. Two identical DeepSeek baseline rounds differ by 6 passes (26 and 32 of 42), so a pass difference of a few trials in 84 is inside the noise.
- Three of the seven hard tasks carry almost no pass signal on Luna. `embedding-drift-monitor` never passes, `intrastat-meldung` almost never passes, and `large-scale-text-editing` almost always passes.
- The skill result on DeepSeek is not known: the hidden-skills arm and the rule-off arm ran on Luna only, and DeepSeek loads few skills.
- Why a donor prompt saves cost on DeepSeek and loses passes on Luna. The DeepSeek gain is on one task, and the timeout count gives one cause. Other causes are not excluded.
- Whether the six skills cost money on other tasks or in interactive chat. The hard set shows the cost on one task, `intrastat-meldung`.
