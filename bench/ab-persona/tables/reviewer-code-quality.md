# reviewer-code-quality benchmark results

This page is generated from the record files in `bench/ab-persona/records/reviewer-code-quality/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: reviewer-quality. Mode: reviewer. Corpus: 31 tasks. Records: 5 campaigns, 662 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role reviewer-quality, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: claude-opus-5.5:xhigh 618 scores)
Corpora: reviewer-code-quality (31 tasks), reviewer-plan-quality (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-quality 335687bc (652 cells), reviewer-plan-quality a89b31cc (60 cells)
Filters: recall % >= 83.8, false P1/P2 per review <= 1.99. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.
Confidence: each 90% interval spans the 5th to the 95th percentile over 1000 seeded resamples, which draw tasks with replacement and then each setting's repeats of each drawn task with replacement, and score every setting again. Beats next is the share of resamples in which a setting outscores the setting on the next row.

| Setting | Family | Tier | recall % | Quality 90% | false P1/P2 per review | Cost/cell | Median latency | Score | Score 90% | Beats next | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-sol@high | openai | mid | 92.3 | 88.1 to 96.0 | 1.39 | $0.216 | 148s | 83.1 | 79.0 to 87.0 | 96% | pass | 82 |
| gpt-6.1-sol@xhigh | openai | mid | 93.8 | 89.5 to 96.9 | 1.50 | $0.309 | 296s | 79.4 | 75.7 to 83.0 | 63% | pass | 82 |
| claude-opus-5.5@medium | anthropic | powerful | 89.4 | 83.7 to 94.0 | 1.46 | $0.542 | 88s | 78.1 | 73.1 to 82.5 | - | pass | 82 |

Incomplete (cells to run next):
- claude-fable-5.2@low: reviewer-plan-quality: 0 of 10 tasks
- claude-opus-5.5@low: reviewer-plan-quality: 0 of 10 tasks
- claude-sonnet-5.5@high: reviewer-plan-quality: 0 of 10 tasks
- claude-sonnet-5.5@low: reviewer-plan-quality: 0 of 10 tasks
- claude-sonnet-5.5@medium: reviewer-plan-quality: 0 of 10 tasks
- deepseek-v4.1-flash-1017@high: reviewer-code-quality: 20 of 31 tasks; reviewer-plan-quality: 0 of 10 tasks
- deepseek-v4.1-flash-1017@max: reviewer-code-quality: 13 of 31 tasks; reviewer-plan-quality: 0 of 10 tasks
- gpt-6-astra@low: reviewer-plan-quality: 0 of 10 tasks
- gpt-6.1-sol@medium: reviewer-plan-quality: 0 of 10 tasks
- gpt-6.1-terra@high: reviewer-plan-quality: 0 of 10 tasks
- gpt-6.1-terra@medium: reviewer-plan-quality: 0 of 10 tasks
- gpt-6.1-terra@xhigh: reviewer-plan-quality: 0 of 10 tasks
- grok-4.5@medium: reviewer-code-quality: 1 of 31 tasks; reviewer-plan-quality: 0 of 10 tasks

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| reviewer-code-quality | 2026-11-11T01-03-13-088Z | 10 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge reviewer-code-quality --judge gpt-6.1-sol:xhigh`) |

Policy:

```
reviewer-quality (ROLE_MODEL_DEFAULTS entry: reviewer-quality)
  named: openai gpt-6.1-sol high (no quality lead holds in 90% of resamples; the top scorer of the settings that gpt-6.1-sol@xhigh does not outscore on quality in 90% of resamples: gpt-6.1-sol@high, gpt-6.1-sol@xhigh, claude-opus-5.5@medium)
  1. openai gpt-6.1-sol high
  2. anthropic claude-opus-5.5 medium
  fallback: mid, xhigh
  evidence: reviewer-code-quality-2026-11-11T01-03-13-088Z, reviewer-code-quality-2026-11-11T01-04-30-041Z, reviewer-code-quality-2026-11-11T05-15-25-509Z, reviewer-code-quality-2026-11-11T06-50-30-346Z, reviewer-code-quality-2026-11-11T15-32-09-950Z, reviewer-plan-quality-2026-11-14T06-37-01-303Z
```

### Judged by claude-opus-5.5:xhigh

Judge: claude-opus-5.5:xhigh (other judges in these records: gpt-6.1-sol:xhigh 712 scores)
Corpora: reviewer-code-quality (31 tasks)
Persona guidance: reviewer-code-quality 335687bc (618 cells)
Filters: recall % >= 78.5, false P1/P2 per review <= 1.31. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.
Confidence: each 90% interval spans the 5th to the 95th percentile over 1000 seeded resamples, which draw tasks with replacement and then each setting's repeats of each drawn task with replacement, and score every setting again. Beats next is the share of resamples in which a setting outscores the setting on the next row.

| Setting | Family | Tier | recall % | Quality 90% | false P1/P2 per review | Cost/cell | Median latency | Score | Score 90% | Beats next | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-terra@high | openai | cheap | 81.6 | 70.9 to 89.8 | 1.57 | >= $0.082 (1 of 61 cells partly unpriced) | 55s | 83.3 | 69.6 to 90.1 | 77% | false | 61 |
| gpt-6.1-terra@xhigh | openai | cheap | 84.6 | 76.1 to 91.3 | 1.95 | >= $0.126 (5 of 62 cells partly unpriced) | 115s | 79.5 | 67.6 to 86.9 | 63% | false | 62 |
| gpt-6.1-sol@high | openai | mid | 84.6 | 75.0 to 91.7 | 1.08 | $0.325 | 167s | 78.1 | 65.0 to 83.9 | 50% | pass | 62 |
| gpt-6.1-terra@medium | openai | cheap | 73.8 | 61.4 to 83.0 | 1.31 | >= $0.072 (5 of 61 cells partly unpriced) | 49s | 78.0 | 64.6 to 85.0 | 59% | quality | 61 |
| gpt-6.1-sol@xhigh | openai | mid | 88.5 | 80.6 to 94.4 | 1.21 | $0.474 | 342s | 76.6 | 63.1 to 83.9 | 60% | pass | 62 |
| gpt-6.1-sol@medium | openai | mid | 76.9 | 65.0 to 86.5 | 0.87 | $0.227 | 102s | 75.1 | 60.1 to 82.0 | 77% | quality | 62 |
| claude-fable-5.2@low | anthropic | powerful | 82.7 | 71.4 to 91.2 | 1.42 | $1.430 | 111s | 69.8 | 55.9 to 76.8 | 61% | false | 31 |
| claude-opus-5.5@medium | anthropic | powerful | 78.8 | 65.8 to 89.1 | 1.27 | $0.884 | 129s | 68.1 | 53.8 to 76.6 | 81% | pass | 62 |
| claude-sonnet-5.5@low | anthropic | mid | 57.7 | 39.2 to 72.7 | 0.71 | $0.183 | 28s | 63.2 | 44.9 to 74.4 | 51% | quality | 31 |
| claude-sonnet-5.5@high | anthropic | mid | 69.2 | 52.7 to 81.8 | 1.10 | $0.478 | 109s | 62.8 | 45.6 to 73.7 | 62% | quality | 31 |
| claude-opus-5.5@low | anthropic | powerful | 59.6 | 41.3 to 73.2 | 0.74 | $0.340 | 36s | 61.2 | 43.7 to 71.1 | 57% | quality | 31 |
| gpt-6-astra@low | openai | powerful | 69.2 | 55.6 to 80.0 | 1.06 | $1.011 | 93s | 60.4 | 45.9 to 68.2 | 57% | quality | 31 |
| claude-sonnet-5.5@medium | anthropic | mid | 55.8 | 36.6 to 70.8 | 0.81 | $0.206 | 36s | 59.2 | 40.1 to 71.6 | - | quality | 31 |

A lower-bound cost enters the score as its bound, which can only flatter that setting.

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| reviewer-code-quality | 2026-11-11T01-03-13-088Z | 44 | not scored by claude-opus-5.5:xhigh (`bun bench/ab-persona/bench.ts --rejudge reviewer-code-quality --judge claude-opus-5.5:xhigh`) |
| reviewer-plan-quality | 2026-11-14T06-37-01-303Z | 60 | not scored by claude-opus-5.5:xhigh (`bun bench/ab-persona/bench.ts --rejudge reviewer-plan-quality --judge claude-opus-5.5:xhigh`) |

Policy:

```
reviewer-quality (ROLE_MODEL_DEFAULTS entry: reviewer-quality)
  named: openai gpt-6.1-sol high (no quality lead holds in 90% of resamples; the top scorer of the settings that gpt-6.1-sol@xhigh does not outscore on quality in 90% of resamples: gpt-6.1-sol@high, gpt-6.1-sol@xhigh)
  1. openai gpt-6.1-sol high
  2. anthropic claude-opus-5.5 medium
  fallback: mid, xhigh
  evidence: reviewer-code-quality-2026-11-11T01-03-13-088Z, reviewer-code-quality-2026-11-11T01-04-30-041Z, reviewer-code-quality-2026-11-11T05-15-25-509Z, reviewer-code-quality-2026-11-11T06-50-30-346Z, reviewer-code-quality-2026-11-11T15-32-09-950Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by gpt-6.1-sol:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@low | claude-opus-5.5@medium | claude-sonnet-5.5@high | claude-sonnet-5.5@low | claude-sonnet-5.5@medium | deepseek-v4.1-flash-1017@high | deepseek-v4.1-flash-1017@max | gpt-6-astra@low | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh | grok-4.5@medium |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| billing-ledger | 5/5+8 | 5/5+4 | 5/5+5 5/5+3 | 5/5+5 | 5/5+6 | 5/5+4 | 5/5+5 | 5/5+5 | 5/5+4 | 5/5+5 5/5+4 | 5/5+4 5/5+2 | 5/5+3 5/5+3 | 5/5+5 5/5+6 | 5/5+4 5/5+5 | 4/5+6 5/5+7 | 5/5+5 |
| cache-pagination | 5/5+6 | 5/5+7 | 5/5+8 5/5+8 | 5/5+7 | 5/5+6 | 5/5+8 | 4/5+7 | 5/5+7 | 5/5+8 | 5/5+9 5/5+8 | 5/5+9 5/5+8 | 5/5+9 5/5+7 | 5/5+7 5/5+7 | 5/5+7 5/5+7 | 5/5+9 5/5+9 | - |
| fabricated-pins-plan | 5/5+3 | 4/5 | 5/5+2 5/5+4 | 5/5+1 | 4/5+2 | 4/5+3 | 5/5+4 | 5/5 | 4/5+3 | 4/5+2 4/5+2 | 4/5+1 4/5+2 | 4/5+2 4/5+3 | 5/5+3 5/5+3 | 4/5+2 4/5+2 | 5/5+4 3/5+4 | - |
| masked-registration | 2/2 | 2/2 | 2/2 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2+1 | 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | - |
| review-0ac0d7d90ba5 | 2/3 | 0/3 | 1/3 1/3 | 0/3 | 1/3 | 1/3 | 0/3+1 | 1/3 | 1/3 | 2/3 2/3 | 1/3 1/3 | 3/3 2/3 | 2/3 2/3 | 2/3 2/3 | 2/3 2/3 | - |
| review-0da3b2c9af18 | 1/1 | 0/1 | 1/1 0/1 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1+1 | 0/1 | 0/1 0/1 | 0/1 0/1 | 0/1+1 0/1 | 0/1+1 | 0/1+1 | 1/1+1 0/1+1 | - |
| review-0e5bb852bd7e | 1/1 | 0/1 | 1/1 1/1 | 1/1+1 | 1/1 | 1/1 | 1/1+1 | 1/1 | 0/1 | 1/1+1 0/1 | 0/1 0/1 | 1/1 1/1+1 | 0/1+2 1/1+2 | 1/1+2 0/1+2 | 1/1+2 1/1+1 | - |
| review-14cdb3f74882 | 2/2+3 | 1/2+1 | 1/2+2 1/2+1 | 1/2+2 | 1/2+1 | 1/2+1 | 1/2+2 | 1/2+2 | 2/2+2 | 2/2+2 2/2+2 | 2/2+1 2/2+2 | 2/2+2 2/2+2 | 2/2+3 1/2+4 | 1/2+2 1/2+4 | 2/2+1 2/2+3 | - |
| review-1a19de9bb1b3 | 0/1 | 1/1 | 1/1 0/1+1 | 0/1+1 | 0/1+1 | 0/1 | 0/1+2 | 1/1+1 | 0/1+2 | 0/1+1 0/1 | 0/1 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+2 | 0/1+2 0/1+2 | 1/1+3 0/1+2 | - |
| review-1d58fd43e2cf | 1/1 | 1/1+1 | 1/1+1 1/1 | 0/1+1 | 1/1+1 | 0/1+2 | 0/1+1 | 0/1 | 0/1+1 | 0/1 0/1+1 | 0/1 0/1+1 | 1/1+1 1/1+1 | 0/1+1 1/1 | 0/1 0/1+1 | 1/1+2 1/1+1 | - |
| review-1ff708943813 | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | - |
| review-53fdbaffac0d | 2/2+1 | 1/2 | 1/2 2/2 | 2/2+1 | 1/2 | 1/2+1 | 2/2 | 2/2+1 | 1/2+1 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2 2/2 | 2/2+2 2/2+2 | - |
| review-5504731a9bea | 0/1+1 | 0/1 | 0/1+1 0/1+1 | 0/1+1 | 0/1 | 0/1+1 | 0/1+1 | 1/1+1 | 0/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 1/1 1/1+1 | 1/1+1 1/1+1 | - |
| review-6072ce4e155e | 1/1 | 1/1 | 1/1 1/1+2 | 1/1 | 1/1 | 1/1 | 1/1+1 | ? | 1/1 | 1/1 1/1 | 1/1+1 1/1 | 1/1+1 1/1 | 1/1 1/1+1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-6d052e62ac32 | 1/1 | 0/1+1 | 1/1 1/1 | 1/1 | 0/1 | 0/1 | 0/1 | ? | 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 0/1 0/1+1 | 1/1+1 1/1+1 | - |
| review-783f4ceebae1 | 1/3+2 | 1/3+1 | 2/3+1 1/3+1 | 1/3+1 | 1/3 | 0/3 | 2/3+2 | ? | 2/3 | 3/3+1 3/3+2 | 3/3+3 3/3+1 | 3/3+3 3/3+2 | 3/3+1 3/3+1 | 2/3+2 2/3+1 | 2/3+2 2/3+3 | - |
| review-81e9ecba8a26 | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | 0/0+1 | ? | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0 0/0 | - |
| review-8ce5ee0b193c | 0/1 | 0/1 | 1/1 0/1+2 | 0/1 | 0/1 | 0/1 | 0/1 | ? | 0/1 | 0/1+1 0/1 | 0/1+1 0/1 | 0/1+1 0/1 | 0/1+1 0/1+2 | 0/1+1 0/1+1 | 0/1+1 0/1+1 | - |
| review-8d7e8ba24bc2 | 1/1+2 | 0/1 | 1/1+1 0/1+1 | 1/1+1 | 0/1 | 0/1+1 | 0/1+1 | - | 1/1+1 | 1/1+1 1/1+1 | 0/1+1 0/1+1 | 0/1+1 1/1+1 | 0/1+2 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+2 | - |
| review-9224c8d4b7f1 | 1/1+4 | 1/1 | 1/1+3 1/1+3 | 1/1+2 | 1/1 | 1/1 | 1/1+5 | - | 1/1 | 1/1 1/1+1 | 1/1 1/1 | 1/1+1 1/1+2 | 1/1+2 1/1+1 | 1/1 1/1+1 | 1/1+2 1/1+3 | - |
| review-959e50f39502 | 1/1 | 0/1 | 1/1 1/1 | 1/1 | 0/1 | 0/1 | ? | - | 0/1 | 1/1 0/1 | 1/1 0/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-aee2f3110fcb | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | - | 0/0+1 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | - |
| review-b7003657d8b2 | 0/1 | 1/1+1 | 1/1+2 0/1+2 | 1/1 | 0/1 | 1/1 | ? | - | 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-c6edb985e72a | 0/0+1 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+2 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | - |
| review-ca61ba986717 | 0/0+1 | 0/0 | 0/0+1 0/0+1 | 0/0+1 | 0/0 | 0/0 | ? | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0+1 | 0/0+1 0/0+1 | 0/0+1 0/0+2 | - |
| review-d063757f80a8 | 1/1 | 0/1 | 1/1 0/1 | 0/1 | 0/1 | 0/1 | - | - | 1/1 | 1/1 1/1 | 1/1+1 1/1 | 1/1 1/1 | 1/1+2 1/1+1 | 1/1+1 1/1+2 | 1/1+2 1/1+2 | - |
| review-d3b56fe648a6 | 1/2+3 | 0/2+1 | 2/2+2 1/2+3 | 1/2+2 | 1/2 | 1/2+1 | - | - | 1/2+1 | 1/2+2 2/2+2 | 1/2 0/2+1 | 1/2+3 2/2+1 | 0/2+2 2/2+2 | 1/2 1/2 | 2/2+2 2/2+2 | - |
| review-d9cfc3be3403 | 1/1+1 | 0/1 | 1/1+3 1/1+2 | 0/1+1 | 1/1+1 | 0/1+1 | - | - | 0/1+2 | 1/1+3 1/1+2 | 0/1+2 0/1+2 | 1/1+2 0/1+3 | 0/1+1 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+1 | - |
| review-e900aa45096b | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | - | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0 0/0 | 0/0+1 0/0 | - |
| review-ff32ee67d96a | 3/4+1 | 2/4 | 2/4 3/4 | 2/4 | 2/4 | 2/4 | - | - | 2/4+1 | 3/4+1 4/4+1 | 4/4 3/4 | 4/4 3/4+1 | 3/4+1 4/4+1 | 3/4+1 2/4+1 | 4/4+2 4/4+1 | - |
| sync-scheduler | 5/5+7 | 4/5+6 | 5/5+6 5/5+6 | 5/5+6 | 5/5+4 | 5/5+4 | - | - | 5/5+6 | 5/5+6 5/5+6 | 5/5+4 5/5+5 | 5/5+6 5/5+6 | 5/5+5 5/5+6 | 5/5+7 5/5+6 | 5/5+6 5/5+6 | - |

### Scored by claude-opus-5.5:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@low | claude-opus-5.5@medium | claude-sonnet-5.5@high | claude-sonnet-5.5@low | claude-sonnet-5.5@medium | deepseek-v4.1-flash-1017@high | deepseek-v4.1-flash-1017@max | gpt-6-astra@low | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh | grok-4.5@medium |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| billing-ledger | 5/5+8 | 5/5+4 | 5/5+5 5/5+3 | 5/5+5 | 5/5+6 | 5/5+4 | ? | ? | 5/5+4 | 5/5+5 5/5+4 | 5/5+4 5/5+2 | 5/5+3 5/5+3 | 5/5+5 5/5+6 | 5/5+4 5/5+5 | 4/5+6 4/5+7 | ? |
| cache-pagination | 5/5+6 | 5/5+7 | 5/5+8 5/5+8 | 5/5+7 | 5/5+6 | 5/5+8 | ? | ? | 5/5+8 | 5/5+9 5/5+8 | 5/5+9 5/5+8 | 5/5+9 5/5+7 | 5/5+7 5/5+7 | 5/5+7 5/5+7 | 5/5+9 5/5+9 | - |
| fabricated-pins-plan | 5/5+3 | 4/5 | 5/5+2 5/5+4 | 5/5+1 | 4/5+2 | 4/5+2 | ? | ? | 4/5+3 | 4/5+2 4/5+2 | 4/5+1 4/5+2 | 4/5+2 4/5+3 | 4/5+3 4/5+3 | 4/5+2 4/5+2 | 4/5+4 4/5+4 | - |
| masked-registration | 2/2 | 2/2 | 2/2 2/2 | 2/2 | 2/2 | 2/2 | ? | ? | 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | - |
| review-0ac0d7d90ba5 | 2/3 | 0/3 | 1/3 0/3 | 0/3 | 0/3 | 0/3 | ? | ? | 1/3 | 2/3 2/3 | 1/3 1/3 | 3/3 2/3 | 2/3 2/3 | 2/3 2/3 | 2/3 2/3 | - |
| review-0da3b2c9af18 | 1/1 | 0/1 | 1/1 0/1 | 0/1 | 0/1 | 0/1 | ? | ? | 0/1 | 0/1 0/1 | 0/1 0/1 | 0/1+1 0/1 | 0/1+1 | 0/1+1 | 1/1+1 0/1+1 | - |
| review-0e5bb852bd7e | 1/1 | 0/1 | 1/1 1/1 | 1/1+1 | 1/1 | 1/1 | ? | ? | 0/1 | 1/1+1 0/1 | 0/1 0/1 | 1/1 1/1+1 | 0/1+2 1/1+2 | 1/1+2 0/1+2 | 1/1+2 1/1+1 | - |
| review-14cdb3f74882 | 2/2+3 | 1/2+1 | 1/2+2 1/2+1 | 1/2+2 | 1/2+1 | 1/2+1 | ? | ? | 2/2+2 | 2/2+2 2/2+2 | 2/2+1 2/2+2 | 2/2+2 2/2+2 | 2/2+3 1/2+4 | 1/2+2 1/2+4 | 2/2+1 2/2+3 | - |
| review-1a19de9bb1b3 | 0/1 | 1/1 | 1/1 0/1+1 | 0/1+1 | 0/1+1 | 0/1 | ? | ? | 0/1+2 | 0/1+1 0/1 | 0/1 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+2 | 0/1+2 0/1+2 | 1/1+3 0/1+2 | - |
| review-1d58fd43e2cf | 1/1 | 1/1+1 | 1/1+1 1/1 | 0/1+1 | 1/1+1 | 0/1+2 | ? | ? | 0/1+1 | 0/1 0/1+1 | 0/1 0/1+1 | 1/1+1 1/1+1 | 0/1+1 1/1 | 0/1 0/1+1 | 1/1+2 1/1+1 | - |
| review-1ff708943813 | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | ? | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | - |
| review-53fdbaffac0d | 2/2+1 | 1/2 | 1/2 2/2 | 2/2+1 | 1/2 | 0/2+1 | ? | ? | 1/2+1 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2 2/2 | 2/2+2 2/2+2 | - |
| review-5504731a9bea | 0/1+1 | 0/1 | 0/1+1 0/1+1 | 0/1+1 | 0/1 | 0/1+1 | ? | ? | 0/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1 | 1/1 1/1+1 | 1/1+1 1/1+1 | - |
| review-6072ce4e155e | 1/1 | 1/1 | 1/1 1/1+2 | 1/1 | 1/1 | 1/1 | ? | ? | 1/1 | 1/1 1/1 | 1/1+1 1/1 | 1/1+1 1/1 | 1/1 1/1+1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-6d052e62ac32 | 1/1 | 0/1+1 | 1/1 1/1 | 1/1 | 0/1 | 0/1 | ? | ? | 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 0/1 0/1+1 | 1/1+1 1/1+1 | - |
| review-783f4ceebae1 | 1/3+2 | 1/3+1 | 2/3+1 1/3+1 | 1/3+1 | 1/3 | 0/3 | ? | ? | 2/3 | 3/3+1 3/3+2 | 3/3+3 3/3+1 | 3/3+3 3/3+2 | 3/3+1 3/3+1 | 2/3+2 2/3+1 | 2/3+2 2/3+3 | - |
| review-81e9ecba8a26 | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | ? | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0 0/0 | - |
| review-8ce5ee0b193c | 0/1 | 0/1 | 1/1 0/1+2 | 0/1 | 0/1 | 0/1 | ? | ? | 0/1 | 0/1+1 0/1 | 0/1+1 0/1 | 0/1+1 0/1 | 0/1+1 0/1+2 | 0/1+1 0/1+1 | 0/1+1 0/1+1 | - |
| review-8d7e8ba24bc2 | 1/1+2 | 0/1 | 1/1+1 0/1+1 | 1/1+1 | 0/1 | 0/1+1 | ? | - | 1/1+1 | 1/1+1 1/1+1 | 1/1+1 0/1+1 | 1/1+1 1/1+1 | 0/1+3 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+2 | - |
| review-9224c8d4b7f1 | 1/1+4 | 1/1 | 1/1+3 1/1+3 | 1/1+2 | 1/1 | 1/1 | ? | - | 1/1 | 1/1 1/1+1 | 1/1 1/1 | 1/1+1 1/1+2 | 1/1+2 1/1+1 | 1/1 1/1+1 | 1/1+2 1/1+3 | - |
| review-959e50f39502 | 1/1 | 0/1 | 1/1 1/1 | 1/1 | 0/1 | 0/1 | ? | - | 0/1 | 1/1 0/1 | 1/1 0/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-aee2f3110fcb | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | - | 0/0+1 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | - |
| review-b7003657d8b2 | 0/1 | 1/1+1 | 1/1+2 1/1+2 | 1/1 | 0/1 | 1/1 | ? | - | 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | - |
| review-c6edb985e72a | 0/0+1 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | ? | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+2 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | - |
| review-ca61ba986717 | 0/0+1 | 0/0 | 0/0+1 0/0+1 | 0/0+1 | 0/0 | 0/0 | ? | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0+1 | 0/0+1 0/0+1 | 0/0+1 0/0 | - |
| review-d063757f80a8 | 1/1 | 0/1 | 1/1 0/1 | 0/1 | 0/1 | 0/1 | - | - | 1/1 | 1/1 1/1 | 1/1+1 1/1 | 1/1 1/1 | 1/1+2 1/1+1 | 1/1+1 1/1+2 | 1/1+2 1/1+2 | - |
| review-d3b56fe648a6 | 1/2+3 | 0/2+1 | 2/2+2 1/2+3 | 1/2+2 | 0/2 | 1/2+1 | - | - | 1/2+1 | 1/2+2 2/2+2 | 1/2 0/2+1 | 1/2+3 2/2+1 | 0/2+2 2/2+2 | 1/2 1/2 | 2/2+2 2/2+2 | - |
| review-d9cfc3be3403 | 1/1+1 | 0/1 | 1/1+3 1/1+2 | 0/1+1 | 1/1+1 | 0/1 | - | - | 0/1+2 | 1/1+3 1/1+2 | 0/1+2 0/1+2 | 1/1+2 0/1+3 | 0/1+1 0/1+1 | 0/1+1 0/1+1 | 0/1+2 0/1+1 | - |
| review-e900aa45096b | 0/0 | 0/0 | 0/0 0/0 | 0/0 | 0/0 | 0/0 | - | - | 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0 0/0 | 0/0+1 0/0 | - |
| review-ff32ee67d96a | 3/4+1 | 2/4 | 2/4 3/4 | 2/4 | 1/4 | 2/4 | - | - | 2/4+1 | 3/4+1 4/4+1 | 4/4 3/4 | 4/4 3/4+1 | 3/4+1 4/4+1 | 3/4+1 2/4+1 | 4/4+2 4/4+1 | - |
| sync-scheduler | 5/5+7 | 5/5+6 | 5/5+6 5/5+6 | 5/5+6 | 5/5+4 | 5/5+4 | - | - | 5/5+6 | 5/5+6 5/5+6 | 5/5+4 5/5+5 | 5/5+6 5/5+6 | 5/5+5 5/5+6 | 5/5+7 5/5+6 | 5/5+6 5/5+6 | - |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | recall % (gpt-6.1-sol:xhigh) | false P1/P2 per review (gpt-6.1-sol:xhigh) | recall % (claude-opus-5.5:xhigh) | false P1/P2 per review (claude-opus-5.5:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 31 | 82.7 | 1.42 | 82.7 | 1.42 | 0 | $44.341 | 17607237 | 111s | claude_agent_sdk |
| claude-opus-5.5@low | 31 | 57.7 | 0.74 | 59.6 | 0.74 | 0 | $10.529 | 8540542 | 36s | claude_agent_sdk |
| claude-opus-5.5@medium | 62 | 78.8 | 1.27 | 78.8 | 1.27 | 0 | $54.787 | 74493695 | 129s | claude_agent_sdk |
| claude-sonnet-5.5@high | 31 | 69.2 | 1.10 | 69.2 | 1.10 | 0 | $14.815 | 39767965 | 109s | claude_agent_sdk |
| claude-sonnet-5.5@low | 31 | 63.5 | 0.71 | 57.7 | 0.71 | 0 | $5.686 | 9578019 | 28s | claude_agent_sdk |
| claude-sonnet-5.5@medium | 31 | 59.6 | 0.87 | 55.8 | 0.81 | 0 | $6.392 | 13550457 | 36s | claude_agent_sdk |
| deepseek-v4.1-flash-1017@high | 25 | 64.9 | 1.70 | n/a | n/a | 0 | $1.330 | 70259961 | 551s | deepseek, opencode_go |
| deepseek-v4.1-flash-1017@max | 18 | 82.8 | 1.46 | n/a | n/a | 0 | $1.593 | 68957423 | 837s | deepseek, opencode_go |
| gpt-6-astra@low | 31 | 69.2 | 1.06 | 69.2 | 1.06 | 0 | $31.340 | 11504281 | 93s | chatgpt |
| gpt-6.1-sol@high | 62 | 84.6 | 1.08 | 84.6 | 1.08 | 0 | $20.139 | 53997926 | 167s | chatgpt |
| gpt-6.1-sol@medium | 62 | 76.0 | 0.87 | 76.9 | 0.87 | 0 | $14.098 | 36088133 | 102s | chatgpt |
| gpt-6.1-sol@xhigh | 62 | 87.5 | 1.21 | 88.5 | 1.21 | 0 | $29.397 | 81960396 | 342s | chatgpt |
| gpt-6.1-terra@high | 61 | 83.5 | 1.57 | 81.6 | 1.57 | 0 | >= $4.986 (1 cell partly unpriced) | >= 21132828 | 55s | chatgpt |
| gpt-6.1-terra@medium | 61 | 73.8 | 1.31 | 73.8 | 1.31 | 0 | >= $4.368 (5 cells partly unpriced) | >= 16270320 | 49s | chatgpt |
| gpt-6.1-terra@xhigh | 62 | 85.6 | 1.98 | 84.6 | 1.95 | 0 | >= $7.817 (5 cells partly unpriced) | >= 43198882 | 115s | chatgpt |
| grok-4.5@medium | 1 | 100.0 | 5.00 | n/a | n/a | 0 | $0.150 | 146978 | 244s | supergrok |

## Coverage

Corpus tasks that a setting has no current cell of:

- deepseek-v4.1-flash-1017@high: review-d063757f80a8, review-d3b56fe648a6, review-d9cfc3be3403, review-e900aa45096b, review-ff32ee67d96a, sync-scheduler
- deepseek-v4.1-flash-1017@max: review-8d7e8ba24bc2, review-9224c8d4b7f1, review-959e50f39502, review-aee2f3110fcb, review-b7003657d8b2, review-c6edb985e72a, review-ca61ba986717, review-d063757f80a8, review-d3b56fe648a6, review-d9cfc3be3403, review-e900aa45096b, review-ff32ee67d96a, sync-scheduler
- grok-4.5@medium: cache-pagination, fabricated-pins-plan, masked-registration, review-0ac0d7d90ba5, review-0da3b2c9af18, review-0e5bb852bd7e, review-14cdb3f74882, review-1a19de9bb1b3, review-1d58fd43e2cf, review-1ff708943813, review-53fdbaffac0d, review-5504731a9bea, review-6072ce4e155e, review-6d052e62ac32, review-783f4ceebae1, review-81e9ecba8a26, review-8ce5ee0b193c, review-8d7e8ba24bc2, review-9224c8d4b7f1, review-959e50f39502, review-aee2f3110fcb, review-b7003657d8b2, review-c6edb985e72a, review-ca61ba986717, review-d063757f80a8, review-d3b56fe648a6, review-d9cfc3be3403, review-e900aa45096b, review-ff32ee67d96a, sync-scheduler

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-11T01-03-13-088Z | deepseek-v4.1-flash-1017@high, deepseek-v4.1-flash-1017@max, gpt-6-astra@low, gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh, gpt-6.1-terra@high, gpt-6.1-terra@medium, gpt-6.1-terra@xhigh, grok-4.5@medium | gpt-6.1-sol:xhigh | 259 | 464 | 0 | 0 | not recorded |
| 2026-11-11T01-04-30-041Z | claude-opus-5.5@low, claude-opus-5.5@medium, claude-sonnet-5.5@high, claude-sonnet-5.5@low, claude-sonnet-5.5@medium | gpt-6.1-sol:xhigh | 155 | 310 | 0 | 0 | not recorded |
| 2026-11-11T05-15-25-509Z | claude-fable-5.2@low | gpt-6.1-sol:xhigh | 31 | 62 | 0 | 0 | not recorded |
| 2026-11-11T06-50-30-346Z | claude-opus-5.5@medium | gpt-6.1-sol:xhigh | 31 | 62 | 0 | 0 | not recorded |
| 2026-11-11T15-32-09-950Z | gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh, gpt-6.1-terra@high, gpt-6.1-terra@medium, gpt-6.1-terra@xhigh | gpt-6.1-sol:xhigh | 186 | 372 | 0 | 0 | not recorded |
