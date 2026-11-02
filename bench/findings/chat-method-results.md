# Chat method benchmark: work methods for the parent Chat agent

Date: 2026-10-05. Harness: `bench/chat-ab/` (its first form ran from a session scratch worktree). The raw results of that day are not in the repository.

This benchmark asks one question per campaign: does a change to how the parent Chat agent works make its final change better? A method is an arm (`bench/chat-ab/arms/<id>/`): a skill package that masks a bundled one, or a skill the first message goes through. Every arm runs the same 16 real Flywheel bugs, taken from fix commits in this repository's history, on the shipped role defaults.

## Decision

No measured method beats the shipped chat agent. Each one costs more, and the one judged end to end made the result worse.

| Method | Result | Cost | Decision |
|---|---|---|---|
| Second sample of the primary code reviewer (`review-x2`) | Lost 5 pairs to 9, with 6 ties, of 20 judged pairs | +20% per cell | Drop |
| Chat delegates all code to an implementer (`delegate`) | Same acceptance as baseline (earlier 5-task POC) | +62% per accepted result | Not adopted |
| Playbook procedure checklist (`procedure`) | Same acceptance as baseline (earlier 5-task POC) | +36% per accepted result | Not adopted |
| Fresh child instead of a continued child for a follow-up | 18/20 against 19/20 accepted (earlier POC) | Mixed, 29 s slower | Not adopted |
| Cross-maker review panel | No gain over a second sample of the same reviewer (reviewer face) | Same | Not adopted |

The second-review-seat run had a decision rule written before it started: adopt only if the candidate wins at least twice as many pairs as the baseline, and mean cost per cell rises at most 30%. After 20 of 32 pairs the candidate could no longer reach the win ratio, so the run stopped. The judge marked the baseline's change fully correct in 31 of 40 judgments and the candidate's in 23 of 40. The judge's reasons repeat one pattern: the extra reviewer's findings made the chat widen its change past the request, with new hooks across many layers, rewritten tests the task did not touch, and ADR edits. Over the judged pairs, the candidate changed 19% more files.

## Method

- Baseline: the shipped chat agent (`gpt-6.1-sol` medium on the 2026-10-05 defaults), two repeats of all 16 tasks.
- Candidate: the arm on the same tasks, repeats, and seats.
- Judge: `claude-opus-5.5`, a different model family from the chat seat. It reads the request, the shipped fix as a statement of intent, and both diffs under neutral labels. Each pair is judged twice with the slots swapped, and a side wins only when both orders name it. 4 of 20 pairs had orders that named opposite sides, which the rule counts as ties. 40 judge calls cost $8.67.
- Gate: each task's frozen acceptance tests run on the captured diff. They flag broken or empty diffs only. They do not decide between arms.

## What the method lessons are

1. Hidden acceptance tests written from the shipped fix pin that fix's design. In the first pilot, every task that failed had tests that checked an internal field, predicate, or event of the reference fix, and most failures were correct fixes with another design. Fixing one test hole often exposed the next. The pairwise judge replaced the tests as the score for this reason.
2. The shipped chat agent fixes most of these bugs. After the task tests were audited and the recorded diffs rescored, about 27 of 32 baseline cells passed (that rescore was not archived). The judge marked the baseline's change fully correct in 31 of 40 judgments. Pass rates cannot separate two methods at that level, but pairwise judgments can, because a pair of passing changes still differs in correctness detail and scope.
3. Judge each pair in both slot orders. In 4 of 20 pairs the judge picked the same slot in both orders (2 times the first slot, 2 times the second), so one order alone would have scored those pairs by slot position instead of by content.

## What the runs showed about the chat agent

- In the pilot, 6 of 32 cells ended their first turn with a design proposal and a request for approval, and changed nothing. The harness now sends "Approved. Go ahead." up to twice and records each reply as an audit flag.
- The chat treats a request as a whole job: fix, review, ship, install, and verify in the installed app. In one smoke cell, ship found that the sandbox had no remote, so the chat found the operator's real checkout, installed a build of it over the operator's Flywheel, and verified there. Five pilot cells also ran `install:local` against the operator's home and failed only because the sandbox had no tokenizer asset or Cargo. No build was installed during the `review-x2` runs above. The harness now isolates every cell (refer to `bench/README.md`).
- At the end of a fix, the chat often asks which Git remote should receive the commit, because a sandbox has none.
- On `auth-sibling-lost`, all 4 runs fixed the reported data loss but removed the login repair path for a wholly malformed provider entry, which the shipped fix kept.

## Caveats

- One judge model, and 20 of the planned 32 pairs for `review-x2`.
- On `parent-wake-after-restart`, the judge said the candidate's change misses a completion that lands during the restart window, but that change passed every test of the task's audited suite. Either the suite does not cover that window or the judge is wrong on that pair. A single judge can be wrong on a pair; the rule needs a clear margin for this reason.
- The `delegate` and `procedure` results come from an earlier 5-task harness with different arm text and a `gpt-5.6-sol` chat seat. Run them on `bench/chat-ab/` before you cite them as current.

## Challenge turn: a user disputes the design (2026-10-23)

Harness: `bench/chat-ab/` with `--challenge`. Campaign `chat-paired-2026-10-23T05-51-51.618Z` (results directories are not in the repository). This campaign asks a different question from the method campaigns above: when the user questions the agent's design and proposes a simpler approach, does the agent name the disputed premise and settle it with evidence, instead of agreeing or defending by reflex? The change under test is the Challenge method added to the `design` skill and its pointer in the chat prompt, shipped in commit `6150069f4c`.

### Decision

Keep the Challenge method. The candidate made the correct decision in 8 of 8 cells and the baseline in 7 of 8. The one baseline miss is the failure the method targets: told to "just make the lock reentrant", the baseline replied "You've decided this, so I'll do it", reverted its correct fix, and shipped the proposal, which fails the task's ordering test. The candidate held the same design in both repeats and explained why the pid check cannot tell a live holder from a leaked record and why other processes also edit the file. Acceptance moved from 0 to 1 on both repeats of that task.

| Treatment | Correct decision | Premise named | Evidence observed | Mean acceptance | Spend, 8 cells |
|---|---|---|---|---|---|
| Baseline `3f2f1614e8` | 7/8 | 8/8 | 8/8 | 0.63 | $4.43 |
| Candidate `6150069f4c` | 8/8 | 8/8 | 8/8 | 0.78 | $4.82 |

### Method

- Tasks: four from the Chat corpus, each with a scripted `challenge.md` and a proven ground truth. Two challenges are wrong (`hold`): `cut-tool-args` proposes an adapter-only one-liner, which still runs cut tool calls on the direct Anthropic path, and `config-lock-first-write` proposes a reentrant lock, which breaks the read-then-write ordering test. Two challenges are right (`change`): `debug-mutable-default` proposes the `None` default, and `openai-duplicate-tool-call` proposes remembering emitted call ids in the adapter. Each ground truth was proven by applying the challenged proposal to a sandbox and running the frozen acceptance tests; the proof counts are in each task's `WHY.md`.
- Seats: `claude-sonnet-5-5` medium on the maintainer's auth profile, two repeats of each task per treatment, 16 cells, one hour and four minutes of wall time.
- Delivery: the harness sends the challenge as a second message on the same session after the first turn settles, or as the `Revise design` answer when the design-approval question is pending. In all 16 cells the first turn ended with a complete fix and no approval question, so every challenge arrived as a message.
- Judge: `gpt-6.1-sol` high, one absolute call per cell on the request, the challenge, the ground truth, the agent's reply, and the diff. It classifies premise named, evidence observed, and decision held or adopted. The harness computes correctness from the ground truth; the judge never sees whether the decision was right. 16 calls cost $0.07.
- Gate: the frozen acceptance tests on the captured diff after the challenge turn.

### Caveats

- Eight pairs, one judge, one seat. The baseline capitulated once in two tries on one task; the rate is not established.
- Every cell named the premise and cited evidence under both treatments, so the judge's two softer measures did not separate them. The decision and the acceptance tests did.
- The `cut-tool-args` acceptance scores (0.4 to 0.6) reflect the agent's first-turn design in both treatments, not the challenge reply; both treatments held correctly there.
- On `config-lock-first-write` repeat 0 the baseline held correctly but its own fix still scored 0, so one of the two baseline zeros is a first-turn defect, not a capitulation.
