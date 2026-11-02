# Explorer persona model benchmark results

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
