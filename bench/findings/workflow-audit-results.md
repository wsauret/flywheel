# Workflow audit: Flywheel against Claude Code

This benchmark compares current Flywheel with the latest external Claude Code on speed, estimated cost, answer quality, and workflow choice. It does not compare historical Flywheel revisions with current Flywheel.

## Method

The canonical design is `bench/chat-ab/examples/workflow-audit-parity.json`. It selects tests 1 to 11, four repeats, and four treatments, 176 cells. All root chats and Flywheel workflow agents use `claude-sonnet-5-5` at medium effort. Flywheel uses the maintainer's auth profile. Claude Code uses the person's normal Claude Code login with Ultracode on.

| Treatment | Source and roles | Subagents |
|---|---|---|
| `fw-nosub` | `HEAD`; only workflow-agent pinned to Sonnet medium | Off through `disabledTools: ["subagent"]` |
| `fw-sub-default` | `HEAD`; only workflow-agent pinned to Sonnet medium | On, with shipped defaults for other roles |
| `fw-sub-sonnet` | `HEAD`; every role, all 18, pinned to Sonnet medium | On |
| `claude-code` | Latest on PATH, Sonnet medium, Ultracode on | Root can dispatch; workflow step agents cannot |

There is no design-level role table. `fw-sub-default` deliberately measures shipped subagent defaults, including models from other providers.

An omitted Flywheel role takes the treatment's shipped default, which can select another provider's model. Each cell's `roles.json` records the resolved assignments. Claude Code's version is resolved from PATH at plan and run time; the report records the version that ran.

The installed Claude Code 2.1.310 smoke offered no Agent tool to its 28 workflow step agents. Therefore `fw-nosub` is the apples-to-apples workflow arm. Root exposure is not identical: Claude Code's root can dispatch subagents up to depth 3, while Flywheel's flag removes the root's `subagent` tool and roster too.

`disabledTools` accepts unique canonical tool names on Flywheel treatments only. It enters treatment identity and passes through the public headless flag. It filters tools and associated rosters, not whole modules. The harness checks every recorded root and descendant request after each invocation, using canonical evidence and the existing audit projection. It retains raw `tool-surfaces.jsonl` and the `disabled-tools.json` proof. A forbidden offered tool or missing request coverage fails the cell. Preflight has no model request and cannot prove exposure. `moduleSnapshot` still describes enabled modules, not the filtered tool list.

Ultracode is Claude Code's standing workflow opt-in. It is the counterpart of Flywheel's Workflows On setting. Keep Workflows On for the campaign. The campaign's first round, test1 once for each treatment, is its smoke. Verify root and workflow-agent model and effort, including Ultracode agents, each Flywheel cell's `roles.json`, and the no-subagent arm's offered-tool evidence.

Tests 1 to 3 request bug audits with explicit workflows. Tests 4 and 5 request a parallel trace and a design panel. Tests 6 to 8 omit workflow instructions to measure workflow choice. Tests 9 to 11 are small tasks that need no workflow. Refer to `bench/chat-ab/README.md` for the task definitions and isolation contract.

Run a long campaign from a dedicated detached worktree at the measured commit. This pins the harness bytes despite concurrent main-checkout edits. Keep `--results` inside that worktree. The cell sandbox denies access to other worktrees, including the main checkout; an external results path produced `EPERM ... lstat '<repo>'`. Keep the worktree until its summary is committed.

## Commands

Create the detached worktree from the measured commit, then run these commands from its root. Use a new results directory for each campaign. Plan and setup submit no task message. Run and judge spend model quota; judge with `--dry-run` first. Report is offline.

```bash
bun run bench:workflow-audit plan bench/chat-ab/examples/workflow-audit-parity.json
bun run bench:workflow-audit setup bench/chat-ab/examples/workflow-audit-parity.json --results bench/chat-ab/results/workflow-audit-parity-20261023
bun run bench:workflow-audit run bench/chat-ab/examples/workflow-audit-parity.json --results bench/chat-ab/results/workflow-audit-parity-20261023
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-nosub --b claude-code --auth-profile <profile>
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-sub-default --b claude-code --auth-profile <profile>
bun run bench:workflow-audit judge bench/chat-ab/results/workflow-audit-parity-20261023 --a fw-sub-sonnet --b claude-code --auth-profile <profile>
bun run bench:workflow-audit report bench/chat-ab/results/workflow-audit-parity-20261023
```

Add `--dry-run` to each judge command before spending quota. Judge ledgers are per ordered pair. The report renders all four treatments per test and each Flywheel arm's parity ratios and judge totals against Claude Code.

Record the campaign's measured commit, Claude Code version, report summary, judge totals, and caveats in this document in the same commit. Results folders are git-ignored. They do not replace this durable record. A treatment revision must support today's headless protocol. Strict decoding refuses older revisions at preflight; the recovered tables below are their historical record.

## How to read the results

- Speed is the completed cell's total subject wall time. A fast incomplete answer is not a successful speed gain.
- Cost is estimated API-equivalent value, not an invoice. All-attempt totals retain failed attempts. Per-test means use completed cells. Missing prices stay unavailable.
- Quality is blinded pairwise judging in both slot orders, with refutation. Only verdicts whose identities match the current artifacts and judge code count. Pending pairs, skipped pairs, and unsettled judge attempts remain visible.
- Workflows launched counts cells with at least one workflow-agent phase over cells with complete coverage. Mean workflow agents counts workflow-agent phases per covered cell, including cells with none. Flywheel workflow agents have session kind `workflow-agent`; Claude Code workflow agents have transcripts under `subagents/workflows/wf_*/`. Ordinary subagents, including those nested under workflow agents, do not count in either column. Missing transcripts, missing request evidence, or incomplete descendant discovery are unavailable and excluded from both denominators. This measures observed workflow execution, not registration alone.
- Sites named is a lexical grade, not verified bug detection. Answer tests are `not graded`. Time and cost ratios divide Flywheel's mean by Claude Code's mean. Each test has equal weight; below 1 favors Flywheel. A missing test mean makes the ratio unavailable.

No single dimension establishes parity. Small samples give directional evidence, not statistical equivalence.

## Recovered history: 2026-10-14 and 2026-10-15

The raw folders were lost when `.claude/worktrees/adhoc-bench` and `.claude/worktrees/workflow-patterns` were deleted. These are the printed tables recovered from Claude Code sessions `3edd64e3-af7d-4f07-9d52-50cd3767b1bb` and `6b11f4d2-5527-46ed-b9ca-cdd8d6825577`. They cannot be regraded or checked against raw artifacts.

Every campaign used `claude-sonnet-5-5`, medium effort, the maintainer's auth profile, and the workflow-agent role pinned to the same model. That role was then named `step-agent`. Each campaign used four repeats unless stated. Costs are estimated equivalent value; Flywheel billed $0, and Claude Code billed cost is unavailable. Sites are the lexical site-naming grade: two sites per cell, `json-parse.ts:145-175` and `openai-completions.ts:142-146`. Judge columns show Flywheel wins, Claude Code wins, and ties per repeat pair.

### Explicit workflow tests against plain Claude Code (no Ultracode)

`workflow-patterns-audit-4`, Flywheel commit `9d21fcc814c1`, 2026-10-14:

| Test | Flywheel wall / cost / sites | Claude Code wall / cost / sites |
|---|---|---|
| test1 | 100 s, $1.25, 4/8 | 81 s, $1.34, 1/8 |
| test2 | 113 s, $1.37, 1/8 | 97 s, $1.36, 1/8 |
| test3 | 338 s, $6.73, 2/8 | 389 s, $11.48, 1/8 |

`workflow-patterns-audit-5`, Flywheel commit `7bef8f74d`, 2026-10-14/15:

| Test | Flywheel | Claude Code | Judge FW/CC/tie |
|---|---|---|---|
| test1 | 99 s, $1.35, 3/8 | 76 s, $1.20, 0/8 | 2/0/2 |
| test3 | 343 s, $6.96, 3/8 | 333 s, $9.42, 2/8 | 0/4/0 |
| test4 | 84 s, $0.73 | 93 s, $0.99 | 0/4/0 |
| test5 | 136 s, $1.20 | 185 s, $1.39 | 1/2/1 |

`workflow-patterns-audit-6`, Flywheel commit `b6f383973`, 2026-10-15, is the last explicit-workflow baseline. Each arm named 5 of 16 sites over tests 1 and 3. Each arm launched a workflow in 4/4 cells of every test.

| Test | Flywheel | Claude Code | Judge FW/CC/tie |
|---|---|---|---|
| test1 | 73 s, $1.36 | 69 s, $1.34 | 0/3/1 |
| test3 | 450 s, $9.33 | 419 s, $10.10 | 3/1/0 |
| test4 | 90 s, $0.88 | 86 s, $0.97 | 1/2/1 |
| test5 | 172 s, $1.51 | 227 s, $2.03 | 1/3/0 |

The recovered account attributes part of audit-5 and audit-6's answer-test losses to a lossy one-shot handoff. That handoff shortened Flywheel's final answer and was fixed in commit `a8a17c4e8`. The lost artifacts prevent a fresh causal check.

### Discretionary and small tests against Claude Code with Ultracode

`adhoc-solo-1`, Flywheel commit `856416e53`, 2026-10-15. No arm launched a workflow: 0/4 everywhere. No judge ran.

| Test | Flywheel | Claude Code + Ultracode |
|---|---|---|
| test9 quick question | 11 s, $0.09 | 6 s, $0.14 |
| test10 one-line edit | 10 s, $0.05 | 10 s, $0.15 |
| test11 "Hi" | 7 s, $0.05 | 6 s, $0.14 |

`adhoc-answer-3` (test7) and `adhoc-full-2` (test6, test8), Flywheel commit `a8a17c4e8`, 2026-10-15, are the last discretionary baseline:

| Test | Workflow launched FW / CC | Flywheel | Claude Code + Ultracode | Judge FW/CC/tie |
|---|---|---|---|---|
| test6 bug audit | 4/4 / 4/4 | 121 s, $1.36 | 110 s, $3.16 | 1/2/0, 1 unsettled |
| test7 trace a path | 0/4 / 0/4 | 50 s, $0.29 | 53 s, $0.32 | 2/1/1 |
| test8 design panel | 0/4 / 0/4 | 97 s, $0.36 | 66 s, $0.34 | 2/2/0 |
| Total | | | | 5/5/1, 1 unsettled |

The historical conclusion is directional quality parity on tests 6 to 8, with test8's extra 31 seconds as the remaining gap. Twelve pairs do not establish statistical equivalence. The explicit-workflow baseline used plain Claude Code; do not treat it as an Ultracode comparison.

These Flywheel revisions predate headless protocol changes, including `activityStartedAt` on status patches. Today's harness decodes subject records strictly, so their preflight refuses. Current comparisons use current Flywheel against the latest Claude Code rather than restoring old revisions.

## 2026-10-23 parity run

Campaign `workflow-audit-parity-20261023` ran the canonical design at Flywheel commit `36775498e3ce` against Claude Code 2.1.310 with Ultracode, 2026-10-23 and 2026-10-24. All 176 cells completed. One `fw-nosub` attempt failed in harness setup on a full disk and was retried; no subject attempt failed. The judge compared 44 pairs for each Flywheel arm, 132 in total, on the profile's `benchmark-judge` setting, which served an OpenAI model through ChatGPT. Judge cost was about $6.50.

Model evidence: every Claude Code root and workflow agent ran `claude-sonnet-5-5`. All ran at medium effort except one workflow agent of 24 in one test4 cell, which its authored workflow ran at high effort. Every Flywheel root and every `fw-nosub` and `fw-sub-sonnet` workflow agent ran `claude-sonnet-5.5`; every resolved role in `fw-sub-sonnet`'s `roles.json` was Sonnet medium. In `fw-sub-default`, one test5 workflow assigned reviewer personas, whose agents took their shipped role defaults, `gpt-6-astra` and `gpt-6.1-sol`. In `fw-nosub` and `fw-sub-default`, a few short background requests ran the shipped `gpt-6.1-sol` default. Each `fw-nosub` cell's `disabled-tools.json` resolved every recorded root and workflow-agent request, 1 to 622 per cell, and found no offer of `subagent` in any of the 44 cells.

| Flywheel arm vs Claude Code + Ultracode | Time ratio | Cost ratio | Sites named, tests 1 to 3 and 6 | Judge FW/CC/tie |
|---|---|---|---|---|
| `fw-nosub` | 0.95 | 0.70 | 14/32 | 22/11/11 |
| `fw-sub-default` | 0.89 | 0.63 | 9/32 | 17/17/10 |
| `fw-sub-sonnet` | 0.83 | 0.61 | 11/32 | 19/13/12 |
| `claude-code` | 1.00 | 1.00 | 5/32 | |

Ratios divide Flywheel's mean by Claude Code's mean with equal weight per test; below 1 favors Flywheel. Total estimated value over 44 cells: `fw-nosub` $69.03, `fw-sub-default` $62.09, `fw-sub-sonnet` $60.25, Claude Code $98.51. Flywheel billed $0; Claude Code billed spend is unavailable.

Per-test means for the apples-to-apples arm, with the other arms' judge results:

| Test | `fw-nosub` | Claude Code + Ultracode | Workflow agents FW / CC | Judge FW/CC/tie: nosub, default, sonnet |
|---|---|---|---|---|
| test1 prepared review | 84 s, $1.29, 4/8 | 75 s, $1.45, 2/8 | 14.3 / 13.8 | 1/3/0, 1/3/0, 2/1/1 |
| test2 authored review | 134 s, $2.22, 2/8 | 96 s, $3.25, 1/8 | 21.0 / 31.5 | 4/0/0, 1/2/1, 2/1/1 |
| test3 loop and vote | 380 s, $9.34, 5/8 | 412 s, $12.94, 1/8 | 80.8 / 128.5 | 4/0/0, 3/0/1, 4/0/0 |
| test4 parallel trace | 85 s, $0.85 | 97 s, $1.03 | 6.0 / 6.0 | 3/1/0, 0/4/0, 0/3/1 |
| test5 design panel | 183 s, $1.53 | 272 s, $1.94 | 7.0 / 7.5 | 1/1/2, 1/2/1, 2/1/1 |
| test6 audit, no workflow wording | 114 s, $1.33, 3/8 | 113 s, $2.93, 1/8 | 10.8 / 27.8 | 2/1/1, 4/0/0, 2/2/0 |
| test7 trace, no workflow wording | 45 s, $0.22 | 43 s, $0.32 | 0 / 0 | 1/3/0, 2/2/0, 1/2/1 |
| test8 panel, no workflow wording | 79 s, $0.39 | 57 s, $0.34 | 0 / 0 | 2/1/1, 2/2/0, 4/0/0 |
| test9 quick question | 6.5 s, $0.03 | 6.0 s, $0.14 | 0 / 0 | 0/0/4, 0/0/4, 0/0/4 |
| test10 one-line edit | 8.1 s, $0.04 | 11.5 s, $0.16 | 0 / 0 | 1/1/2, 1/1/2, 1/0/3 |
| test11 "Hi" | 5.5 s, $0.03 | 5.9 s, $0.14 | 0 / 0 | 3/0/1, 2/1/1, 1/3/0 |

Workflow choice matched Claude Code: both launched a workflow in every explicit test and in no test7 to test11 cell. On test6, Claude Code launched in 4/4 cells and Flywheel in 3/4, 2/4, and 3/4.

Against the last October 15 baselines, no comparative regression appears:

- Tests 6 to 8 against Ultracode: judge totals moved from 5/5/1 with one unsettled pair to 5/5/2 for `fw-nosub`, 8/4/0 for `fw-sub-default`, and 7/4/1 for `fw-sub-sonnet`. The test8 time gap narrowed from 31 s to 23 s for `fw-nosub` and 16 s for `fw-sub-sonnet`; test8 remains Flywheel's slowest relative result.
- Tests 9 to 11: Flywheel took 5.5 to 8.6 s against 6.0 to 11.5 s, within 0.5 s or faster on every test, and cost a fifth to a third of Claude Code's value. On October 15 it took 7 to 11 s against 6 to 10 s.
- Tests 1, 3, 4, and 5: the comparator changed from plain Claude Code to Claude Code with Ultracode, so these are not like-for-like. `fw-nosub` won test3 4/0/0 (audit-6: 3/1/0, audit-5: 0/4/0) and test4 3/1/0 (audit-6: 1/2/1). It still loses test1 judging, 1/3/0, as in audit-6, 0/3/1.

Caveats:

- Four repeats per test give directional evidence, not statistical equivalence. Sites named is a lexical grade.
- `fw-nosub` removes `subagent` from Flywheel's root as well as its workflow agents, while Claude Code's root keeps its Agent tool. Its comparison is apples to apples for workflow agents only.
- Test7 is the one answer test where every Flywheel arm lost judging or tied it: 4 wins against 7 losses across arms. Test4 split by arm: `fw-nosub` won 3/1/0, while both subagent arms lost.
- Flywheel's cost ratio partly reflects fewer workflow agents on tests 2, 3, and 6. Claude Code ran about 1.5 to 2.6 times as many on those tests.
