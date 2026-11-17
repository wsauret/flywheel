# Explorer persona model benchmark results

## 2026-11-13 hard-question mini sweep

Runs: `explorer-2026-11-13T21-20-04-158Z` (OpenAI settings) and `explorer-2026-11-13T21-20-06-290Z` (Anthropic settings), run in parallel on the Personal profile. Twelve hard tracing questions with answer keys, one repeat each: the three kept questions in `bench/tasks/explorer/` and nine drafts from the second pilot, restored as temporary task folders pinned to `74d097f9c`. The drafts `compaction-during-capacity-wait` and `hosted-task-model-access-change` were left out because their answer keys were defective. The answer-key judge was gpt-6.1-sol at xhigh effort. Every candidate and the judge ran on subscriptions; billed spend was $0. Estimated list-price spend was about $11.76 (a lower bound, because nine runs were partly unpriced) for the 96 agent runs and about $3.65 for judging.

Fact recall is the share of answer-key facts that the judge found in the answer. Trap rate is the share of questions on which the explorer asserted a planted wrong answer. Quality is fact recall minus trap rate, in points, so a false alarm counts against the setting. Valid citations is the mechanical check that a cited `path:line` exists at the pin. Cost is the mean estimated list price per question. Latency is the median wall time per question.

| Setting | Tier | Fact recall | Trap rate | Quality | Valid citations | Cost per question | Median latency |
|---|---|---:|---:|---:|---:|---:|---:|
| gpt-6.1-sol low | mid | 61/70 (87.1%) | 0/12 (0.0%) | 87.1 | 349/349 (100%) | $0.183 (lower bound, 2 runs partly unpriced) | 84 s |
| claude-sonnet-5.5 medium | mid | 60/70 (85.7%) | 1/12 (8.3%) | 77.4 | 311/375 (82.9%) | $0.243 | 49 s |
| claude-sonnet-5.5 low | mid | 54/70 (77.1%) | 0/12 (0.0%) | 77.1 | 248/308 (80.5%) | $0.185 | 39 s |
| gpt-6.1-sol medium | mid | 57/70 (81.4%) | 1/12 (8.3%) | 73.1 | 370/377 (98.1%) | $0.217 (lower bound, 5 runs partly unpriced) | 110 s |
| gpt-6-luna xhigh | cheap | 51/70 (72.9%) | 0/12 (0.0%) | 72.9 | 198/203 (97.5%) | $0.029 | 306 s |
| gpt-6-luna high (previous OpenAI default) | cheap | 50/70 (71.4%) | 0/12 (0.0%) | 71.4 | 162/167 (97.0%) | $0.010 (lower bound, 2 runs partly unpriced) | 83 s |
| claude-haiku-5.5 medium | cheap | 56/70 (80.0%) | 2/12 (16.7%) | 63.3 | 347/395 (87.8%) | $0.047 | 105 s |
| claude-haiku-5.5 high (previous Anthropic default) | cheap | 57/70 (81.4%) | 3/12 (25.0%) | 56.4 | 478/524 (91.2%) | $0.067 | 163 s |

Reference only, from the earlier pilots on the same twelve questions (`explorer-2026-11-13T15-02-17-783Z` and `explorer-2026-11-13T16-36-24-333Z`): claude-opus-5.5 medium recalled 59/70 (84.3%) with a trap rate of 1/12, quality 76.0, at $0.770 and 78 s.

### Composite score

Each axis is min-max scaled to 0..1 across the eight sweep settings. Quality: higher is better, range 56.4 to 87.1. Cost: lower is better, scaled on the natural log of cost per question, range $0.010 to $0.243. Latency: lower is better, range 39 s to 306 s. Composite = 0.6 x quality + 0.2 x cost + 0.2 x latency.

| Setting | Quality scaled | Cost scaled (log) | Latency scaled | Composite |
|---|---:|---:|---:|---:|
| gpt-6.1-sol low | 1.000 | 0.087 | 0.831 | 0.784 |
| gpt-6-luna high | 0.488 | 1.000 | 0.835 | 0.660 |
| claude-sonnet-5.5 low | 0.674 | 0.085 | 1.000 | 0.622 |
| claude-sonnet-5.5 medium | 0.682 | 0.000 | 0.963 | 0.602 |
| gpt-6.1-sol medium | 0.543 | 0.035 | 0.734 | 0.479 |
| gpt-6-luna xhigh | 0.535 | 0.666 | 0.000 | 0.454 |
| claude-haiku-5.5 medium | 0.225 | 0.514 | 0.753 | 0.388 |
| claude-haiku-5.5 high | 0.000 | 0.400 | 0.536 | 0.187 |

Example: gpt-6.1-sol low = 0.6 x (87.1 - 56.4) / (87.1 - 56.4) + 0.2 x (ln 0.243 - ln 0.183) / (ln 0.243 - ln 0.010) + 0.2 x (306 - 84) / (306 - 39) = 0.600 + 0.017 + 0.166 = 0.784.

### Findings

1. The best OpenAI setting is gpt-6.1-sol at low effort (composite 0.784, the top of the sweep). It had the highest recall, asserted no trap, and every citation was valid. Its cost is a lower bound, but at the highest observed cost ($0.243) its composite would still be 0.766, the top score.
2. The best Anthropic setting is claude-sonnet-5.5 at low effort (composite 0.622). Sonnet medium recalled 8.6 points more but asserted one trap, so its quality is almost the same (77.4 against 77.1), and it costs 31% more. The two differ by 0.020, which one asserted trap decides.
3. The order puts OpenAI first, because the top OpenAI setting (0.784) scores higher than the top Anthropic setting (0.622).
4. The previous Anthropic default, haiku high, asserted a planted wrong answer on 3 of 12 questions and has the lowest composite (0.187). The previous OpenAI default, luna high, is the cheapest setting and asserted no trap, but it missed 29% of the facts (composite 0.660).
5. More effort did not help: luna xhigh cost about three times as much as luna high and took nearly four times as long for 1.5 more points of quality, and sol medium scored lower quality than sol low.
6. Only sol low is within 0.05 of the top composite (0.734 or more). Its tier is mid, so the fallback tier is mid, and its effort is low, so the fallback effort is low.
7. Blind pairwise judging, a secondary score, disagrees within the Anthropic settings. Of 36 pairs each, haiku high won 33, haiku medium 25, sonnet medium 11, and sonnet low 3. Among the OpenAI settings, sol low and sol medium won 28 each, luna xhigh 13, and luna high 1 (two of the 72 OpenAI pairs produced no verdict). The pairwise judge rewards fuller answers and does not check the answer key, so it does not see haiku's asserted traps. The composite follows the answer key.
8. Pooling the pilot cells of luna high and haiku high on the same questions does not change any choice: sol low 0.784, sonnet low 0.626, the same single best performer. The tables above are not pooled, because the pilots ran from a different source revision and pooling gives two settings twice the samples of the others.

### Decision

Proposed explorer preferences, in order: gpt-6.1-sol low (OpenAI, composite 0.784), then claude-sonnet-5.5 low (Anthropic, composite 0.622), then the mid tier at low effort. Changing the coded defaults waits for the separate unit that makes the preference order per role.

### Caveats

One repeat per cell, so a difference of two or three facts (three to four points of recall), or one asserted trap (8.3 points of quality), is within noise. The cost of three settings is a lower bound because some attempts reported incomplete usage. The judge is one model. All questions trace this repository.

## 2026-09-21 expanded matrix

Run: `explorer-2026-09-21T19-55-44-726Z`. Seven variants, the same three read-only research tasks, 2 repeats each, and blinded round-robin judging by gpt-5.6-sol.

| Variant | Quality | Avg cost per run | Avg latency |
|---|---:|---:|---:|
| luna/xhigh | 30-6 | $0.104 | 230s |
| grok-4.7/high | 29-7 | $1.714 | 229s |
| luna/high | 22-14 | $0.070 | 157s |
| deepseek-v4.1-flash/max | 17-19 | $0.027 | 102s |
| sol/low | 15-21 | $0.402 | 110s |
| deepseek-v4.1-flash/high | 10-26 | $0.035 | 123s |
| glm-5.3-flash/max | 3-33 | $0.060 | 155s |

### Findings

1. luna/xhigh and grok-4.7/high were the quality leaders. luna/xhigh delivered equivalent directional quality at about one sixteenth of Grok's estimated-equivalent cost.
2. luna/high remained the cost-first balance. It ranked third while reducing average latency by 32% and average cost by 33% relative to luna/xhigh.
3. deepseek-v4.1-flash/max was the strongest low-cost fallback. It cost 61% less and ran 35% faster than luna/high, with lower but still competitive quality.
4. sol/low cost nearly six times more than luna/high while winning fewer comparisons. glm-5.3-flash/max and deepseek-v4.1-flash/high did not justify a default position.

### Decision

Explorer keeps gpt-5.6-luna at high effort as its cost-first primary. When Luna is unavailable, it uses DeepSeek V4.1 Flash at max effort before the generic cheap-tier, high-effort fallback. luna/xhigh remains the quality-first manual choice.

### Caveats

Two repeats per cell is directional. The generated report's raw loss column counted every non-winning variant as a loser even when it was not in the judged pair; the quality values above retain the report's valid win counts and recompute each loss from the 36 comparisons in which that variant participated. One candidate attempt failed and succeeded on resume. The judge was a single model, and provider load and cache state can affect cost and latency.

## 2026-08-21 rerun (post-luna-optimization)

Run: `explorer-2026-08-21T05-28-01-462Z`. Three variants, same three read-only research tasks as the July matrix (session disposal, model/effort resolution, streaming output), 2 repeats each, full round-robin blinded pairwise judging by gpt-5.6-sol (18 verdicts per variant).

| Variant | Quality (W-L of 18) | Avg cost per run | Avg latency | Avg tokens per run |
|---|---:|---:|---:|---:|
| luna/xhigh | 9-9 | $0.097 | 111s | 8.3k |
| luna/high | 7-11 | $0.061 | 65s | 5.1k |
| terra/medium | 2-16 | $0.301 | 58s | 3.4k |

### Findings

1. The July result inverted. terra/medium, the incumbent, lost 2-16. Judge rationales repeatedly cite miscitations, weaker grounding, and omitted layers (transport, recovery, wire mappings), not just verbosity tradeoffs.
2. The luna optimizations landed: luna/high fell from $0.19 to $0.06 per run and its former token bloat is gone. Higher effort no longer multiplies work destructively; xhigh's extra depth now wins verdicts instead of losing them to bloat.
3. terra/medium is now the most expensive seat of the three at $0.30 per run.
4. luna/xhigh is the quality leader but takes 1.7x luna/high's latency, and explorers gate the parent step's research phase.

### Decision

Explorer moves to gpt-5.6-luna effort high as a cost-first default. luna/xhigh is the swap-back choice when research depth outranks latency and cost. claude-sonnet-4-6/medium stays the Anthropic fallback (not re-tested).

### Caveats

Two repeats per cell is directional. The two luna seats split 3-3 on two of three tasks; the gap between them is within noise, while terra's 2-16 is not. Single judge model (sol); relative pair quality only.

## 2026-07-23 matrix (historical)

Date: 2026-07-23. Runs: `2026-07-23T19-07-29-881Z` (terra/medium vs luna/xhigh), `2026-07-23T19-20-01-665Z` (terra/low vs luna/high), with cross-pair quality verdicts from a separate cross-judging of these two runs.

### Setup

Four variants of the `explorer` subagent persona ran the same three read-only research questions against this repository, 2 repeats each (6 runs per variant): session disposal ordering, workflow model/effort resolution, and TUI streaming-output rendering. Cost comes from `model.turn.completed.data.total_cost_usd` via the production subagent stats stream. Latency is wall clock from `runner.send()` to `runner.done`. Quality is blind randomized pairwise judging (judge: the resolved `reviewer` role, gpt-5.6-sol medium) on factual grounding with file:line citations, completeness, and concision. The two in-run pairs plus four cross-run pairs give a full round-robin: each variant was judged 18 times (6 against each other variant).

### Results

| Variant | Quality (W-L of 18) | Avg cost per run | Avg latency | Avg tokens per run |
|---|---:|---:|---:|---:|
| luna/xhigh | 11-7 | $0.32 | 82s | 139k |
| terra/medium | 10-8 | $0.21 | 27s | 53k |
| luna/high | 10-8 | $0.19 | 52s | 97k |
| terra/low | 5-13 | $0.17 | 19s | 44k |

### Conclusions

1. Quality is statistically flat across terra/medium, luna/high, and luna/xhigh at this sample size. Verdict rationales trade completeness against focus rather than showing a systematic depth gap.
2. terra/low is clearly worse (5-13). Low effort visibly cuts research depth. Do not run explorer-class research at low effort.
3. Higher effort on luna multiplies work, not just thinking: xhigh used 2.6x the tokens of terra/medium, erasing luna's 2.5x per-token price advantage and adding cost on net.
4. Winner: terra/medium. Top-tier quality, fastest of the top tier by 2-3x, within cents of the cheapest quality-equivalent option. Latency matters doubly for explorers because they gate the parent step's research phase.
5. luna/high is the fallback: equivalent quality, marginally cheaper, 2x the latency.

### Decision

Explorer stayed at gpt-5.6-terra effort medium (`[roles.explorer]`) until the 2026-08-21 rerun above. Analyzer kept the same setting pending its own benchmark and was later retired.

### Caveats

Two repeats per cell is directional, not conclusive. The judge is a single model (sol/medium) and measures relative pair quality, not absolute correctness. Latency includes tool execution and provider load variance. All tasks target this repository; generalization to other codebases is assumed, not measured.
