# reviewer-code-elegance benchmark results

This page is generated from the record files in `bench/ab-persona/records/reviewer-code-elegance/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: reviewer-elegance. Mode: reviewer. Corpus: 12 tasks. Records: 2 campaigns, 264 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role reviewer-elegance, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by claude-opus-5.5:xhigh

Judge: claude-opus-5.5:xhigh (other judges in these records: gpt-6.1-sol:xhigh 384 scores)
Corpora: reviewer-code-elegance (12 tasks), reviewer-plan-elegance (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-elegance cec5130f (216 cells), reviewer-code-elegance 73caf06c (48 cells), reviewer-plan-elegance 6ed0c9ee (40 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 2.43. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.
Confidence: each 90% interval spans the 5th to the 95th percentile over 1000 seeded resamples, which draw tasks with replacement and then each setting's repeats of each drawn task with replacement, and score every setting again. Beats next is the share of resamples in which a setting outscores the setting on the next row.

| Setting | Family | Tier | recall % | Quality 90% | false P1/P2 per review | Cost/cell | Median latency | Score | Score 90% | Beats next | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 100.0 to 100.0 | 1.83 | $0.195 | 45s | 86.8 | 85.3 to 90.9 | 82% | pass | 68 |
| gpt-6.1-sol@medium | openai | mid | 96.4 | 90.6 to 100.0 | 2.14 | $0.076 | 76s | 83.4 | 78.8 to 88.3 | - | pass | 68 |

Incomplete (cells to run next):
- claude-fable-5.2@low: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6-astra@medium: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-sol@high: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-sol@xhigh: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@high: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@medium: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@xhigh: reviewer-plan-elegance: 0 of 10 tasks

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| reviewer-plan-elegance | 2026-11-14T06-37-02-914Z | 80 | not scored by claude-opus-5.5:xhigh (`bun bench/ab-persona/bench.ts --rejudge reviewer-plan-elegance --judge claude-opus-5.5:xhigh`) |

Policy:

```
reviewer-elegance (ROLE_MODEL_DEFAULTS entry: reviewer-elegance)
  named: anthropic claude-opus-5.5 medium (no quality lead holds in 90% of resamples; the top scorer of the settings that claude-opus-5.5@medium does not outscore on quality in 90% of resamples: claude-opus-5.5@medium, gpt-6.1-sol@medium)
  1. anthropic claude-opus-5.5 medium
  2. openai gpt-6.1-sol medium
  fallback: mid, medium
  evidence: reviewer-code-elegance-2026-11-11T21-48-22-147Z, reviewer-code-elegance-2026-11-12T00-44-54-328Z, reviewer-plan-elegance-2026-11-13T14-48-59-768Z
```

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: claude-opus-5.5:xhigh 304 scores)
Corpora: reviewer-code-elegance (12 tasks), reviewer-plan-elegance (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-elegance cec5130f (216 cells), reviewer-code-elegance 73caf06c (48 cells), reviewer-plan-elegance 6ed0c9ee (120 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 2.46. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.
Confidence: each 90% interval spans the 5th to the 95th percentile over 1000 seeded resamples, which draw tasks with replacement and then each setting's repeats of each drawn task with replacement, and score every setting again. Beats next is the share of resamples in which a setting outscores the setting on the next row.

| Setting | Family | Tier | recall % | Quality 90% | false P1/P2 per review | Cost/cell | Median latency | Score | Score 90% | Beats next | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 100.0 to 100.0 | 1.86 | $0.195 | 45s | 86.6 | 85.2 to 88.6 | 80% | pass | 68 |
| gpt-6.1-sol@medium | openai | mid | 96.4 | 90.9 to 100.0 | 2.14 | $0.076 | 76s | 83.4 | 78.4 to 88.0 | 76% | pass | 68 |
| claude-fable-5.2@low | anthropic | powerful | 100.0 | 100.0 to 100.0 | 2.19 | $0.411 | 51s | 81.2 | 79.4 to 83.7 | 63% | pass | 44 |
| gpt-6.1-sol@high | openai | mid | 96.4 | 90.9 to 100.0 | 2.36 | $0.097 | 117s | 79.4 | 73.4 to 85.4 | 92% | pass | 44 |
| gpt-6-astra@medium | openai | powerful | 96.4 | 90.9 to 100.0 | 2.17 | $0.344 | 66s | 77.4 | 72.2 to 82.2 | 94% | pass | 44 |
| gpt-6.1-sol@xhigh | openai | mid | 96.4 | 90.9 to 100.0 | 2.45 | $0.130 | 200s | 75.4 | 69.5 to 81.1 | - | pass | 44 |

Incomplete (cells to run next):
- gpt-6.1-terra@high: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@medium: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@xhigh: reviewer-plan-elegance: 0 of 10 tasks

Policy:

```
reviewer-elegance (ROLE_MODEL_DEFAULTS entry: reviewer-elegance)
  named: anthropic claude-opus-5.5 medium (no quality lead holds in 90% of resamples; the top scorer of the settings that claude-opus-5.5@medium does not outscore on quality in 90% of resamples: claude-opus-5.5@medium, gpt-6.1-sol@medium, claude-fable-5.2@low, gpt-6.1-sol@high, gpt-6-astra@medium, gpt-6.1-sol@xhigh)
  1. anthropic claude-opus-5.5 medium
  2. openai gpt-6.1-sol medium
  fallback: mid, medium
  evidence: reviewer-code-elegance-2026-11-11T21-48-22-147Z, reviewer-code-elegance-2026-11-12T00-44-54-328Z, reviewer-plan-elegance-2026-11-13T14-48-59-768Z, reviewer-plan-elegance-2026-11-14T06-37-02-914Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by claude-opus-5.5:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh |
|---|---|---|---|---|---|---|---|---|---|
| elegance-alert-fallback | 2/2+2 2/2+3 | 2/2+1 2/2 2/2+3 2/2+2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 2/2+2 2/2+1 | 2/2+1 2/2+1 | 2/2+5 1/2+4 | 2/2+3 2/2+3 | 2/2+5 2/2+4 |
| elegance-api-session | 2/2+3 2/2+5 | 2/2+3 2/2+1 2/2+4 2/2+2 | 2/2+4 2/2+4 | 2/2+5 2/2+4 | 2/2+5 2/2+3 2/2+4 2/2+4 | 2/2+3 2/2+7 | 2/2+5 2/2+5 | 2/2+3 2/2+5 | 2/2+6 2/2+6 |
| elegance-clearing-export | 2/2+2 2/2+2 | 2/2+2 2/2+2 2/2+3 2/2+3 | 1/2+2 1/2+2 | 1/2+3 1/2+3 | 1/2+2 1/2+1 1/2+2 1/2+2 | 1/2+2 1/2+2 | 0/2+3 0/2+2 | 0/2+3 0/2+2 | 0/2+3 0/2+2 |
| elegance-directory-pagination | 0/0+2 0/0+2 | 0/0+1 0/0+1 0/0+1 0/0+2 | 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+1 0/0+2 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+2 0/0+3 | 0/0+2 0/0+2 |
| elegance-flag-gate | 1/1+2 1/1 | 1/1+1 1/1+2 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 1/1+1 1/1+1 | 1/1 1/1+1 | 0/1+1 0/1+1 | 1/1+1 1/1+1 | 1/1+1 0/1+2 |
| elegance-invoice-import | 2/2+3 2/2+4 | 2/2+2 2/2+3 2/2+3 2/2+2 | 2/2+3 2/2+2 | 2/2+5 2/2+6 | 2/2+3 2/2+2 2/2+3 2/2+4 | 2/2+5 2/2+5 | 1/2+4 1/2+3 | 2/2+4 1/2+5 | 1/2+5 1/2+3 |
| elegance-order-payment-status | 1/1+2 1/1+2 | 1/1+2 1/1+2 1/1+2 1/1+2 | 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+1 1/1+2 1/1+2 1/1+2 | 1/1+2 1/1+1 | 1/1+2 1/1+1 | 1/1+2 1/1+1 | 1/1+2 1/1+2 |
| elegance-retry-transport | 0/0+3 0/0+3 | 0/0+1 0/0+1 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+1 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+3 0/0+4 | 0/0+3 0/0+3 | 0/0+3 0/0+3 | 0/0+4 0/0+5 |
| elegance-shipping-quotes | 2/2+4 2/2+2 | 2/2+1 2/2+1 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 2/2+1 2/2+1 | 2/2+1 2/2+1 | 1/2+1 1/2+1 | 1/2+1 1/2+1 | 1/2+1 2/2+1 |
| elegance-task-board | 2/2+2 2/2+2 | 2/2+3 2/2+1 2/2+2 2/2+3 | 2/2+2 2/2+2 | 2/2+2 2/2+3 | 2/2+2 2/2+2 2/2+2 2/2+2 | 2/2+2 2/2+2 | 1/2+4 2/2+5 | 1/2+4 2/2+4 | 2/2+4 1/2+4 |
| elegance-tracking-protocol | 0/0+1 0/0 | 0/0+1 0/0+2 0/0+2 0/0+1 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0+1 0/0+1 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | 0/0+1 0/0+1 |
| elegance-user-settings | 0/0+3 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 |

### Scored by gpt-6.1-sol:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh |
|---|---|---|---|---|---|---|---|---|---|
| elegance-alert-fallback | 2/2+2 2/2+3 | 2/2+1 2/2 2/2+3 2/2+2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 2/2+2 2/2+1 | 2/2+1 2/2+1 | 2/2+5 0/2+4 | 2/2+3 1/2+3 | 2/2+5 2/2+4 |
| elegance-api-session | 2/2+3 2/2+5 | 2/2+3 2/2+1 2/2+4 2/2+2 | 2/2+4 2/2+4 | 2/2+5 2/2+4 | 2/2+5 2/2+3 2/2+4 2/2+4 | 2/2+5 2/2+7 | 2/2+5 2/2+5 | 2/2+3 2/2+5 | 2/2+6 2/2+6 |
| elegance-clearing-export | 2/2+2 2/2+2 | 2/2+2 2/2+2 2/2+3 2/2+3 | 1/2+2 1/2+2 | 1/2+3 1/2+3 | 1/2+2 1/2+1 1/2+2 1/2+2 | 1/2+2 1/2+2 | 0/2+3 0/2+2 | 0/2+3 0/2+2 | 0/2+3 0/2+2 |
| elegance-directory-pagination | 0/0+2 0/0+2 | 0/0+1 0/0+1 0/0+1 0/0+2 | 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+1 0/0+2 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+2 0/0+3 | 0/0+2 0/0+2 |
| elegance-flag-gate | 1/1+2 1/1 | 1/1+1 1/1+2 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 1/1+1 1/1+1 | 1/1 1/1+1 | 0/1+1 0/1+1 | 1/1+1 1/1+1 | 1/1+1 0/1+2 |
| elegance-invoice-import | 2/2+3 2/2+4 | 2/2+2 2/2+3 2/2+3 2/2+2 | 2/2+3 2/2+2 | 2/2+5 2/2+6 | 2/2+3 2/2+2 2/2+3 2/2+4 | 2/2+5 2/2+5 | 1/2+4 1/2+3 | 2/2+4 1/2+5 | 0/2+6 1/2+3 |
| elegance-order-payment-status | 1/1+2 1/1+2 | 1/1+2 1/1+2 1/1+2 1/1+2 | 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+1 1/1+2 1/1+2 1/1+2 | 1/1+2 1/1+1 | 1/1+2 1/1+1 | 1/1+2 1/1+1 | 1/1+2 1/1+2 |
| elegance-retry-transport | 0/0+3 0/0+3 | 0/0+1 0/0+1 0/0+1 0/0+1 | 0/0+2 0/0+2 | 0/0+1 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+3 0/0+4 | 0/0+3 0/0+3 | 0/0+3 0/0+3 | 0/0+4 0/0+5 |
| elegance-shipping-quotes | 2/2+4 2/2+2 | 2/2+1 2/2+1 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 2/2+1 2/2+1 | 2/2+1 2/2+1 | 1/2+1 1/2+1 | 1/2+1 1/2+1 | 1/2+1 1/2+1 |
| elegance-task-board | 2/2+2 2/2+2 | 2/2+3 2/2+1 2/2+2 2/2+3 | 2/2+2 2/2+2 | 2/2+2 2/2+3 | 2/2+2 2/2+2 2/2+2 2/2+2 | 2/2+2 2/2+2 | 1/2+4 2/2+5 | 1/2+4 2/2+4 | 2/2+4 1/2+4 |
| elegance-tracking-protocol | 0/0+1 0/0 | 0/0+1 0/0+2 0/0+2 0/0+1 | 0/0+1 0/0+1 | 0/0 0/0+1 | 0/0+1 0/0+1 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0+2 0/0+1 | 0/0+1 0/0+1 |
| elegance-user-settings | 0/0+3 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 | 0/0+2 0/0+2 |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | recall % (claude-opus-5.5:xhigh) | false P1/P2 per review (claude-opus-5.5:xhigh) | recall % (gpt-6.1-sol:xhigh) | false P1/P2 per review (gpt-6.1-sol:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 24 | 100.0 | 2.33 | 100.0 | 2.33 | 0 | $9.467 | 2347849 | 49s | claude_agent_sdk |
| claude-opus-5.5@medium | 48 | 100.0 | 1.81 | 100.0 | 1.81 | 0 | $8.675 | 4516279 | 40s | claude_agent_sdk |
| gpt-6-astra@medium | 24 | 92.9 | 1.79 | 92.9 | 1.79 | 0 | $7.027 | 1977607 | 42s | chatgpt |
| gpt-6.1-sol@high | 24 | 92.9 | 2.13 | 92.9 | 2.13 | 0 | $1.956 | 2732728 | 70s | chatgpt |
| gpt-6.1-sol@medium | 48 | 92.9 | 1.83 | 92.9 | 1.83 | 0 | $3.215 | 4993954 | 46s | chatgpt |
| gpt-6.1-sol@xhigh | 24 | 92.9 | 2.13 | 92.9 | 2.21 | 0 | $2.447 | 3391250 | 91s | chatgpt |
| gpt-6.1-terra@high | 24 | 57.1 | 2.63 | 53.6 | 2.63 | 0 | $0.471 | 1775069 | 25s | chatgpt |
| gpt-6.1-terra@medium | 24 | 71.4 | 2.54 | 67.9 | 2.54 | 0 | $0.479 | 1791746 | 21s | chatgpt |
| gpt-6.1-terra@xhigh | 24 | 67.9 | 2.92 | 60.7 | 2.96 | 0 | $0.703 | 2514331 | 43s | chatgpt |

## Coverage

Corpus tasks that a setting has no current cell of:

- None: every setting has a current cell of every corpus task.

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-11T21-48-22-147Z | claude-fable-5.2@low, claude-opus-5.5@medium, gpt-6-astra@medium, gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh, gpt-6.1-terra@high, gpt-6.1-terra@medium, gpt-6.1-terra@xhigh | gpt-6.1-sol:xhigh | 216 | 432 | 0 | 0 | not recorded |
| 2026-11-12T00-44-54-328Z | claude-opus-5.5@medium, gpt-6.1-sol@medium | gpt-6.1-sol:xhigh | 48 | 96 | 0 | 0 | not recorded |
