# Model benchmark summary

This is the unified view of Flywheel's model benchmarks. Each benchmarked seat section states the measured variants, decisions, and per-seat findings document. Current policy comes from `ROLE_MODEL_DEFAULTS` in `src/orchestration/config/role-model-defaults.ts`, not from historical benchmark decisions. Harness code lives in `bench/` (refer to `bench/README.md`).

Raw run outputs stay on the machine that ran them and are not published. The result pages name each run by its run id only. To produce your own runs, use the launch steps below and the commands in [bench/README.md](../README.md#live-benchmark-faces).

Method in one paragraph: live benchmarks run the production Agent host with only the seat's model:effort varied. Candidate cells and tool-free judges share the same Agent invocation boundary, captured auth profile, model preflight, admission, request audit, cancellation, provider attribution, and Usage settlement. Current strict evidence records serving attribution as observed or explicitly unavailable; older records do not gain attribution that they did not store. Quality judging is blinded and pairwise where used; recall-style metrics, acceptance tests, and trap classification are absolute per-cell and comparable across runs. Earlier campaigns used the historical Sol judge. Persona judges now resolve the live profile's `benchmark-judge` setting. Older Chat A/B scorers keep an explicit setting from that role's coded entry and resolve it for every request. Each harness retains its scoring identity and cross-family eligibility rule. Each seat section states its repeat count; treat small deltas as noise and rankings as directional.

How a benchmark is launched: the live console faces are persona, research strategy, Chat routing, and cross-run comparison benchmarks under `bench/`; the Agent face is the embedded `benchmark` tool for the persona service. From an agent turn, call that tool with `{ action: "run", persona, variants, repeats, dryRun }` or `{ action: "resume", resultId, dryRun }`; input names are exact and camelCase. Every standalone face acquires one canonical profile runtime and performs the same profile-bound candidate and judge preflight as the embedded face. Plan first with `--dry-run` or `dryRun: true`: dry runs perform preflight, report provider plans and the matrix, create no campaign directory, invoke no candidate or judge Agent, and issue zero provider requests. `bench/README.md` holds all face-specific commands and mechanics.

The findings below are historical measurements and decisions, not current defaults. Historical Sol, Terra, and Luna labels identify the retired models measured in those campaigns. Their exact recorded identities remain in the linked findings and run records. No historical score or price establishes performance or pricing for a current preference.

Evidence has one authority per question. Current persona campaigns use `campaign.json` for execution and scoring content identities and `events.jsonl` for successful cells, unsuccessful accounting, judges, scores, and inherited role evidence. Resume accepts a changed profile and records it for later cells; content drift still refuses reuse. Older split-ledger harnesses retain their `run-config.json`, `runs.jsonl`, `attempts.jsonl`, `judge-attempts.jsonl`, and `scores.jsonl` contracts. Successful completions alone suppress candidate work, and successful scores alone suppress judging. Reports are projections. Accounting derives from committed `UsageEntry` values and distinguishes estimated-equivalent from billed spend: subscription-covered work can have positive equivalent cost and zero billed cost, while missing price evidence remains unavailable and makes totals incomplete rather than appearing as `$0.0000`.

Never launch a paid matrix to verify a code change, and never verify the benchmark surface itself by spending. `tests/unit/orchestration/modules/development/benchmark-tool-execution.test.ts` exercises the tool with fake candidate and judge clients and makes no provider request.

The historical campaign `reviewer-code-quality-2026-09-10T03-12-57-087Z` retains its 44/46 quality evidence. Its historical cost is unavailable, and the campaign is not repriced. This preserves the recorded quality conclusion without inventing monetary evidence.

## Chat methods (`chat-method-results.md`)

Work methods for the parent Chat agent are judged end to end on 16 real Flywheel bugs with `bench/chat-ab/`: a blinded `claude-opus-5.5` judge compares each candidate change with the baseline change for the same task, in both slot orders. No measured method beats the shipped chat agent. A second sample of the primary code reviewer lost 5 pairs to 9, with 6 ties, at 20% more cost, because its extra findings made the chat widen its change past the request. Delegating all code to an implementer and a playbook procedure checklist matched baseline acceptance at 62% and 36% more cost per accepted result in an earlier POC. The 2026-10-23 challenge campaign in the same file sends a scripted user challenge after the first turn on four tasks, two where the simpler proposal is wrong and two where it is right; with the `design` skill's Challenge method the chat agent made the correct decision in 8 of 8 cells against 7 of 8 without it, and the one miss was a reverted correct fix.

## Workflow audit parity (`workflow-audit-results.md`)

This benchmark compares current Flywheel with the latest Claude Code, with Ultracode on, across 11 workflow-audit tasks and four repeats. Three Flywheel arms measure subagents off, subagents on with shipped defaults, and subagents on with every role pinned to Sonnet medium. Every root and Flywheel workflow agent uses Sonnet 5.5 at medium effort on the maintainer's auth profile. In the 2026-10-23 run, every Flywheel arm took 0.83 to 0.95 of Claude Code's time and 0.61 to 0.70 of its estimated cost. Blinded judging favored the subagents-off arm 22/11/11 (wins, losses, ties), the all-Sonnet arm 19/13/12, and split the shipped-defaults arm 17/17/10. The findings document records the capability asymmetry, procedure, per-arm speed, estimated cost, blinded quality, workflow choice, and recovered October 14 to 15 tables. Raw results are git-ignored, so each campaign summary belongs in that document in the same commit.

## Workflow authorship (`workflow-authorship-results.md`)

This benchmark compares Flywheel's former predefined implement, qa, and debug workflows, frozen in today's grammar, with workflows that the agent writes for the task. Both arms use the same revision, model, skills, and tasks, and run through `bun run bench:workflow-authorship`. The 2026-10-22 pilot used `claude-sonnet-5-5` at medium effort on the maintainer's auth profile, with 3 tasks and 3 trials per arm. With Workflows On, the agent launched no workflow in 18 discretionary cells, so that comparison measured nothing. With the root chat limited to launching a workflow, both arms passed 5 of 9 trials. Authored workflows used fewer agents and no repeat rounds, but cost $12.84 against $7.73. Handcrafted workflows took 7 to 121 seconds longer per task. The blinded judge preferred authored changes in 4 of 9 pairs and handcrafted changes in 2. The sample is too small for a decision. A later calibration of 13 design-given tasks also launched no workflow, and solved 12 of them alone, so the benchmark is paused until it has epic-sized tasks on which the agent orchestrates by itself.

## Unattended run rules (`unattended-run-results.md`)

Two Harbor Hub experiments on 2026-11-11 test one change at a time to an unattended Haiku 5.5 high chat, against a control that ran at the same time, with a decision rule fixed before each run and $0 billed. E4 ran 14 Terminal-Bench tasks x 3 trials per arm. A deliverable-first rule cut requests by 12.1% and a bounded verify rule by 11.8%, both below the 15% bar, so neither is adopted. Shorter tool descriptions lost no passes (+1) and gave fewer tool errors (18 against 22), so the shell tool description was shortened (commit `2d486f14e`); the subagent and message_session descriptions keep their text because no trial used those tools. E2 ran 23 non-saturated DeepSWE tasks x 5 attempts per arm. A self-review rule passed 58 of 115 against control's 53 (+5, interval -6 to +15), in the inconclusive band, so it is not adopted. One bounded Sonnet 5.5 low review passed 52 at 1.58 times control's cost, so it does not pay, and reviewers stay off for unattended runs. A usage limit on the subscription account failed E2's 2% throttling gate in every arm, which weakens its pass comparisons.

## Subagent personas

### explorer (`explorer-results.md`)

Read-only research questions; full round-robin blinded pairwise quality (18 judgments per variant).

| Variant | Quality (W-L of 18) | Avg cost/run | Avg latency |
|---|---:|---:|---:|
| luna/xhigh | 11-7 | $0.32 | 82s |
| terra/medium | 10-8 | $0.21 | 27s |
| luna/high | 10-8 | $0.19 | 52s |
| terra/low | 5-13 | $0.17 | 19s |
| sonnet-4-6/medium | 6-12 (separate 3-way) | $3.16 total (6 runs) | 102s |
| haiku-4-5/high | 1-17 (separate 3-way) | $1.14 total (6 runs) | 69s |

Decision: terra/medium won this 2026-07-23 matrix. Top-tier quality, 2-3x faster than quality peers. terra/low visibly cuts research depth. sonnet-4-6/medium is the Anthropic fallback.

2026-08-21 rerun (3 seats, same 3 tasks, 2 repeats; post-luna-optimization):

| Variant | Quality (W-L of 18) | Avg cost/run | Avg latency |
|---|---:|---:|---:|
| luna/xhigh | 9-9 | $0.10 | 111s |
| luna/high | 7-11 | $0.06 | 65s |
| terra/medium | 2-16 | $0.30 | 58s |

Decision update (2026-08-21): the explorer seat moves to luna/high as a cost-first default. The incumbent terra/medium lost on both axes: 2-16 in the blind round-robin (judge rationales cite miscitations and omitted layers, not just verbosity) at 5x luna/high's cost. luna/xhigh is the quality leader and the swap-back choice when research depth outranks latency; explorers gate the parent's research phase, so luna/high's 1.7x latency advantage matters.

2026-09-21 expanded matrix (7 seats, same 3 tasks, 2 repeats):

| Variant | Quality | Avg cost/run | Avg latency |
|---|---:|---:|---:|
| luna/xhigh | 30-6 | $0.104 | 230s |
| grok-4.7/high | 29-7 | $1.714 | 229s |
| luna/high | 22-14 | $0.070 | 157s |
| deepseek-v4.1-flash/max | 17-19 | $0.027 | 102s |
| sol/low | 15-21 | $0.402 | 110s |
| deepseek-v4.1-flash/high | 10-26 | $0.035 | 123s |
| glm-5.3-flash/max | 3-33 | $0.060 | 155s |

Decision update (2026-09-21): explorer keeps luna/high as the cost-first primary, adds deepseek-v4.1-flash/max as the fixed fallback, then uses cheap-tier inference at high effort. luna/xhigh remains the quality-first manual choice. The generated report overstated losses by charging every non-winner for each verdict; these quality rows preserve valid wins and recompute losses over each variant's 36 actual comparisons.

### reviewer (`reviewer-results.md`)

Current evidence: the 2026-11-11 two-stage sweep of persona reviewer-code-quality on a new public corpus of 31 tasks (defect fixtures derived from real reviews in size strata plus 6 clean controls, 52 labeled defects). The judge is gpt-6.1-sol xhigh; a Claude opus high judge agreed on 16 of 16 rescored labels. Every reported candidate ran on a subscription with $0 billed; the stopped DeepSeek runs billed $0.19 through a fallback route. Stage 1 screened 15 settings once; stage 2 repeated the finalists once. Pooled results (recall of 104 labels, or 103 where one cell failed on provider overload; alarms of 12 clean-control reviews; list-equivalent cost per review):

| Variant | Recall | Control alarms | Cost/review | Avg latency |
|---|---:|---:|---:|---:|
| sol/xhigh | 91/104 (87.5%) | 3/12 | $0.47 | ~340s |
| terra/xhigh | 89/104 (85.6%) | 7/12 | $0.13 (lower bound) | ~120s |
| sol/high | 88/104 (84.6%) | 0/12 | $0.33 | ~180s |
| terra/high | 86/103 (83.5%) | 8/12 | $0.08 | ~60s |
| opus-5.5/medium | 82/104 (78.8%) | 2/12 | $0.89 | ~150s |
| sol/medium | 79/104 (76.0%) | 0/12 | $0.23 | ~110s |
| terra/medium | 76/103 (73.8%) | 7/12 | $0.07 | ~50s |

Stage 1 alone: fable-5.2/low 82.7%, sonnet-5.5/high 69.2%, astra/low 69.2%, sonnet-5.5/low 63.5%, sonnet-5.5/medium 59.6%, opus-5.5/low 57.7%. Recall among the top five settings is within noise. Terra alarmed on most clean controls; sol/high never did. 27 of 52 labels came from gpt-6-astra reviews, and Claude settings catch far fewer astra labels than other labels, so part of the GPT lead may be label-source bias.

Decision (2026-11-11): `reviewer-quality` moves from astra/medium to sol/high, the shared `reviewer` default, which the role now inherits: recall within noise of the best, zero false alarms on clean code, about a third of astra's cost per review. terra/xhigh is the cost-first alternative if false alarms can be filtered. `reviewer-elegance` and `reviewer-mechanism` stay on astra/medium until an elegance-shaped corpus exists.

Earlier seeded-defect detection recall. Evidence: the 2026-07-30 full-matrix run over 7 fixtures (3 synthetic projects plus 4 commit-pinned fixtures derived from real production workflows: 2 plan reviews of real plan-handoff JSON with seeded mutations, 2 production-scale code reviews). 78 opportunities per variant.

| Variant | Recall | Plan review | Production code review | Unsupported | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|---:|---:|
| sol/medium | 91.0% | 100% | 68% | 89 | $0.74 | 126s |
| opus-5/medium | 91.0% | 100% | 73% | 186 | $2.21 | 332s |
| luna/xhigh | 88.5% | 96% | 68% | 97 | $0.67 | 256s |
| luna/high | 88.5% | 92% | 68% | 72 | $0.38 | 134s |
| terra/high | 87.2% | 88% | 73% | 65 | $0.54 | 116s |
| terra/medium | 82.1% | 92% | 59% | 55 | $0.35 | 64s |
| fable-5/low | 79.5% | 85% | 59% | 83 | $1.76 | 165s |
| opus-4-8/medium | 75.6% | 65% | 68% | 45 | $1.11 | 224s |

Historical decision: Terra/high served the shared reviewer seat and unconfigured generic brief reviewers. Quality, Elegance, and Mechanism later used Astra/low; only Quality had direct persona-benchmark evidence. These decisions do not define current efforts or fallback. Refer to `reviewer-results.md` for the September 10 comparison and dated decisions.

2026-08-20 rerun (4 seats, same 7 fixtures, 2 repeats; post-luna-optimization):

| Variant | Recall | Unsupported | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|
| sol/medium | 71/78 (91.0%) | 89 | $1.10 | 163s |
| luna/xhigh | 68/78 (87.2%) | 74 | $0.16 | 243s |
| sol/low | 65/78 (83.3%) | 55 | $0.62 | 93s |
| luna/high | 64/78 (82.1%) | 77 | $0.09 | 156s |

Decision update (2026-08-20): the global reviewer seat moves to luna/xhigh as a cost-first default; its recall sits 4 points under sol/medium at one seventh of the cost, with the fewest uncertain classifications. sol/medium remains the recall leader and the swap-back choice when review is the last line of defense. sol/low is not a good reviewer seat (drops 8 recall points from medium).

### implementer (`implementer-results.md`)

The 2026-08-08 replacement matrix added a production-scale provider-chain task to the trapped metrics refactor and template control. One repeat per cell, 53 hidden acceptance opportunities, six trap opportunities, and 21 blinded pairwise comparisons per variant. The 2026-08-20 round-robin re-ran the frontier seats with 2 repeats after the luna optimizations.

2026-08-20 round-robin (4 seats, 2 repeats, 18 blinded verdicts per seat):

| Variant | Acceptance | Quality W-L-T | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|
| sol/low | 104/106 (98.1%) | 15-3-0 | $0.794 | 98s |
| terra/xhigh | 90/93 (96.8%) | 9-9-0 | $0.715 | 234s |
| luna/xhigh | 105/106 (99.1%) | 6-12-0 | $0.108 | 258s |
| luna/max | 97/100 (97.0%) | 6-12-0 | $0.123 | 349s |

2026-08-08 matrix (8 seats, 1 repeat, 21 verdicts per seat):

| Variant | Acceptance | Traps self-corrected / blind / lucky | Quality W-L-T | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|---:|
| sol/low | 53/53 (100.0%) | 4 / 0 / 2 | 12-9-0 | $0.716 | 117s |
| terra/high | 53/53 (100.0%) | 4 / 0 / 2 | 11-10-0 | $0.593 | 264s |
| sonnet-5/high | 53/53 (100.0%) | 5 / 0 / 1 | 10-11-0 | $2.035 | 599s |
| opus-5/low | 53/53 (100.0%) | 5 / 0 / 1 | 10-11-0 | $3.627 | 500s |
| terra/xhigh | 51/53 (96.2%) | 4 / 0 / 2 | 17-4-0 | $1.161 | 424s |
| luna/max | 51/53 (96.2%) | 3 / 1 / 2 | 9-12-0 | $0.196 | 484s |
| opus-4-6/medium | 50/53 (94.3%) | 3 / 1 / 2 | 4-17-0 | $2.257 | 344s |
| terra/max | 49/53 (92.5%) | 4 / 1 / 1 | 11-10-0 | $1.366 | 376s |

Decision update (2026-08-20): the implementer seat moves to luna/xhigh as a cost-first default: best acceptance on the board (99.1%) at about a seventh of sol/low's cost, and it strictly dominates luna/max. sol/low remains the quality leader (15-3, zero blindly followed traps in the 08-08 matrix, fastest complete-correctness seat) and is the swap-back choice when diff quality outranks cost. luna's quality losses concentrate in one repeated public-contract mistake (moving the numeric sort out of `computePercentiles`) plus diff-economy verdicts; terra/xhigh's 08-08 dominance (17-4) did not replicate (9-9, one non-compiling diff). A luna fast-mode probe (2026-08-20, `speed: "fast"`) cut latency ~23% for ~2.7x cost; not adopted. claude-sonnet-5/high stays the Anthropic fallback.

## Limits of the recorded evidence

- Learning Review has no dedicated benchmark in these findings.
- Workflow Agent has no consolidation-shaped fixture in these findings.
- Chat method comparisons do not establish the quality of its current model preferences.
- Advisor routing evidence does not establish advice quality.
- Reviewer Design has no interface-taste fixture in these findings.

## Cross-cutting findings

1. Effort is model-specific and task-difficulty-specific, never monotonic. terra's effort curve inverts with fixture difficulty: medium wins on easy review fixtures, high wins decisively on production-scale code review (73% vs 59%) and as a solo implementer. sol/high buys grounding at the cost of elegance and latency. fable prefers low effort as an orchestrator and executor but medium as a planner. Never transplant an effort level across models, and do not trust an effort ranking measured at a recall ceiling.
2. Seat competence does not transfer across seats, even for one model. opus-4-8: trap-follower executor, plan-blind reviewer (65% plan-review recall). opus-5: dominant executor, top-recall-but-spraying reviewer. Reviewing itself splits by artifact: plan review and production code review reorder the reviewer ranking (sol leads plans, terra/high leads code). Benchmark the seat, not the model.
3. Latency, not list price, is the recurring Anthropic penalty in research seats: 3-5x slower per dispatch at equal or worse quality on discovery workloads.
4. Handoff discipline is a real capability axis: sonnet-5 was disqualified as reviewer for findings-free handoffs, and silently-lucky trap fixes (opus-5 as orchestrator, sol/medium) starve downstream reviewers of the correction record.

## Historical reference prices (per M tokens, input/output)

| Model | Price |
|---|---|
| Historical Sol | $5 / $30 |
| Historical Terra | $2.5 / $15 |
| Historical Luna | $1 / $6 |
| claude-fable-5 | $10 / $50 |
| claude-opus-5 | $5 / $25 |
| claude-opus-4-8 | $5 / $25 |
| claude-sonnet-5 | $2 / $10 |
| claude-sonnet-4-6 | $3 / $15 |
| claude-haiku-4-5 | $1 / $5 |
