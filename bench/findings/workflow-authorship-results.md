# Workflow authorship benchmark: handcrafted against agent-authored workflows

Dates: 2026-10-22. Harness: `bun run bench:workflow-authorship` (`bench/chat-ab/workflow-authorship.ts`, described in `bench/chat-ab/README.md`). The raw campaign directories are not in the repository. They were written to a session scratch directory on the machine that ran them.

This benchmark asks one question: on the same Flywheel version, model, skills, and tasks, does a workflow that the agent writes for the task do better than one of Flywheel's former predefined workflows? The former implement, qa, and debug workflows are restored as frozen fixtures in today's workflow grammar under `bench/chat-ab/workflow-authorship/handcrafted/`. They run through the current workflow engine. Each arm is one pinned source revision plus reviewed benchmark patches, so the arms differ only in how the workflow is chosen.

## Decision

The pilot does not show that either arm produces more correct work. Once a workflow is forced, the authored arm costs more and the handcrafted arm takes longer. Three tasks with three trials are too few to make a claim for the talk. These results are directional, not evidence of an effect.

All costs below exclude Flywheel's background learning reviews. Those reviews ran inside the pilot cells on `gpt-6.1-sol` and are not part of the work under test. The adjustment subtracts each cell's recorded review cost. Later campaigns apply `no-learning-review.patch` to every arm, so they run no reviews.

| Comparison | Success, handcrafted minus authored | Cost, handcrafted minus authored | Time, handcrafted minus authored | Judge pairs, authored W/T/L |
|---|---|---|---|---|
| Discretionary (agent decides whether to use a workflow) | 0.000 [0.000, 0.000] | +$0.10 [-0.02, +0.31] | +17 s [-5, +55] | 2/5/2 |
| Forced (root chat can only launch a workflow) | 0.000 [0.000, 0.000] | -$0.57 [-1.80, +0.05] | +65 s [+7, +121] | 4/3/2 |

Each interval is a task-level bootstrap: 10,000 fixed-seed resamples of the three tasks, never of trials. Each task effect is the mean difference over its three paired trials. The success and time intervals come from the campaign report. The cost intervals come from the same method applied to the adjusted cell costs.

## Findings

1. With Workflows On, Sonnet 5.5 at medium effort never launched a workflow in either discretionary arm: 0 of 18 cells. It fixed each task alone. In this setting the handcrafted catalog changed nothing that could be measured. Every cost and time difference in that comparison is noise.

2. Wording does not force a launch. An extra sentence in the system section, and then the same sentence in the turn reminder as well, did not make the authored arm launch on a small task or a medium task. The handcrafted arm launched its debug workflow each time. The forced arms therefore apply `root-workflow-only.patch`, which limits the root chat to `workflow`, `skill`, `read`, `list`, `search`, and `process`. Workflow agents keep their full tools. After this change, all 18 forced cells launched a workflow of their own arm's kind.

3. Authored workflows are smaller. Over the forced cells, authored workflows ran 21 agents and no repeat rounds. Handcrafted workflows ran 29 agents and 10 repeat rounds. The handcrafted debug loop always ran its verify round, including on the trivial task.

4. The authored arm was more expensive on the medium task. On `config-lock-first-write`, two authored cells cost about $4.35 and $4.45 without reviews, against $1.17 to $1.84 for the handcrafted cells. Both arms passed 2 of 3 trials. The total forced spend without reviews was $12.84 for authored and $7.73 for handcrafted.

5. The handcrafted arm was slower. Its median time was longer on every task, and the bootstrap interval for time excludes zero: +7 s to +121 s per task.

6. The blinded judge slightly preferred the authored arm's code when a workflow was forced: 4 wins, 3 ties, and 2 losses in 9 pairs. The judge counts a pair as a win only when both slot orders name the same side. Nine pairs are not enough to separate this from noise.

7. Neither arm solved `cut-tool-args` in any condition: 0 of 12 cells. The hidden checks fail in the same way in both arms. This task measures headroom, not a difference between the arms.

## Per-task results

Median cost excludes background learning reviews.

Discretionary pilot at `db1787f143`:

| Task | Arm | Success [Wilson 95%] | Median cost | Median time | Workflows / agents / rounds | Judge W/T/L |
|---|---|---|---|---|---|---|
| debug-mutable-default | authored | 3/3 [0.44, 1.00] | $0.066 | 23 s | 0/0/0 | 0/3/0 |
| debug-mutable-default | handcrafted | 3/3 [0.44, 1.00] | $0.071 | 24 s | 0/0/0 | 0/3/0 |
| config-lock-first-write | authored | 3/3 [0.44, 1.00] | $0.759 | 278 s | 0/0/0 | 1/0/2 |
| config-lock-first-write | handcrafted | 3/3 [0.44, 1.00] | $1.086 | 323 s | 0/0/0 | 2/0/1 |
| cut-tool-args | authored | 0/3 [0.00, 0.56] | $0.482 | 137 s | 0/0/0 | 1/1/1 |
| cut-tool-args | handcrafted | 0/3 [0.00, 0.56] | $0.435 | 154 s | 0/0/0 | 1/1/1 |

Forced pilot at `ae60d74ac4`:

| Task | Arm | Success [Wilson 95%] | Median cost | Median time | Workflows / agents / rounds | Judge W/T/L |
|---|---|---|---|---|---|---|
| debug-mutable-default | authored | 3/3 [0.44, 1.00] | $0.182 | 51 s | 3/6/0 | 0/3/0 |
| debug-mutable-default | handcrafted | 3/3 [0.44, 1.00] | $0.218 | 61 s | 3/9/3 | 0/3/0 |
| config-lock-first-write | authored | 2/3 [0.21, 0.94] | $4.349 | 447 s | 3/9/0 | 2/0/1 |
| config-lock-first-write | handcrafted | 2/3 [0.21, 0.94] | $1.492 | 566 s | 3/11/4 | 1/0/2 |
| cut-tool-args | authored | 0/3 [0.00, 0.56] | $0.873 | 238 s | 3/6/0 | 2/0/1 |
| cut-tool-args | handcrafted | 0/3 [0.00, 0.56] | $0.863 | 346 s | 3/9/3 | 1/0/2 |

## Method

- Model: `claude-sonnet-5-5` at medium effort on the maintainer's auth profile, for the root chat and for every workflow agent. Workflows On was verified before every cell.
- Arms: arm B (authored) is the unpatched revision. Arm A (handcrafted) adds `handcrafted.patch`. That patch replaces only the sentences that tell the agent to write a workflow file, in the Workflows On section and in the workflow tool description. It adds a catalog of the three frozen workflows, with their names, descriptions, and `use_when` text copied word for word. The forced arms add one identical forcing sentence and `root-workflow-only.patch`. `bench/chat-ab/workflow-authorship/LEDGER.md` lists every edit.
- Tasks: `debug-mutable-default` is the former debug workflow's own end-to-end scenario, restored as a campaign task. `config-lock-first-write` and `cut-tool-args` are real Flywheel bug fixes from the repository's history. Each task has hidden fail-to-pass and guard checks.
- Success is the hidden-check result. Quality is a blinded pairwise judge. It sees each pair twice with the slots swapped, and a second judge tries to refute its verdict. Workflow files, workflow names, and phase names are removed before the judge reads a pair.
- Cost is the estimated API-equivalent value. Billed spend was $0 for every cell. Candidate cells cost $9.34 (discretionary) and $21.33 (forced), including $1.35 of background learning reviews: 12 reviews in the discretionary pilot and 28 in the forced pilot. Judging cost $0.98. Smoke and probe cells cost about $5.
- Every model request settled on the maintainer's auth profile: 1,061 of 1,061 usage records. Each cell's session record names the machine's default profile, which is another profile, as its profile. That label is a recording defect, not the serving profile.

## Calibration of design-given tasks

After the pilots, 11 Flywheel history tasks received a design-given message (`design.md`): the problem, the approach, and the key decisions, with no file paths or code. Two plan tasks were ported from `bench/ab-steps`. One discretionary authored cell ran per task at `3959d60fa6`, on the same model and profile, for $11.65 estimated and $0 billed.

| Task | Passed | Cost | Time | Workflow launched |
|---|---|---|---|---|
| stopped-command-exit-code | yes | $1.17 | 4.1 min | no |
| child-wait-refused-as-cycle | yes | $0.56 | 3.6 min | no |
| parent-wake-after-restart | no | $1.43 | 7.7 min | no |
| handoff-ignores-background-command | yes | $0.70 | 2.5 min | no |
| subagent-interrupted-shows-failed | yes | $0.88 | 4.6 min | no |
| custom-provider-role-default | yes | $1.53 | 6.2 min | no |
| interrupted-question-blank-result | yes | $0.82 | 3.4 min | no |
| session-list-empty-after-timeout | yes | $0.67 | 2.8 min | no |
| cut-tool-args | yes | $1.35 | 6.6 min | no |
| provider-chain-fix | yes | $1.38 | 5.1 min | no |
| config-lock-first-write | yes | $0.63 | 1.8 min | no |
| template-multiphase | yes | $0.35 | 1.1 min | no |
| metrics-resteer | yes | $0.18 | 0.8 min | no |

The agent launched no workflow on any task. The design-given message made 12 of 13 tasks solvable alone, including `cut-tool-args`, which failed in all 12 earlier cells with its bug-report message. These tasks are too small for the question: a workflow is not needed to solve them, so forcing one measures overhead.

## Status

The benchmark is paused. `bench/chat-ab/README.md` ("Status and future directions") lists the ideas for a later campaign: epic-sized tasks on which the agent orchestrates by itself, a gate of one discretionary cell per candidate task before any paid matrix, more tasks than trials, and the model-capability axis on qualified tasks.
