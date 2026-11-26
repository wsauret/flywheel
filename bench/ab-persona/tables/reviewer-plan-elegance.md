# reviewer-plan-elegance benchmark results

This page is generated from the record files in `bench/ab-persona/records/reviewer-plan-elegance/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: reviewer-elegance. Mode: reviewer. Corpus: 10 tasks. Records: 2 campaigns, 120 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role reviewer-elegance, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: claude-opus-5.5:xhigh 304 scores)
Corpora: reviewer-code-elegance (12 tasks), reviewer-plan-elegance (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-elegance cec5130f (216 cells), reviewer-code-elegance 73caf06c (48 cells), reviewer-plan-elegance 6ed0c9ee (120 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 2.46. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | recall % | false P1/P2 per review | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 1.86 | $0.195 | 45s | 86.6 | pass | 68 |
| gpt-6.1-sol@medium | openai | mid | 96.4 | 2.14 | $0.076 | 76s | 83.4 | pass | 68 |
| claude-fable-5.2@low | anthropic | powerful | 100.0 | 2.19 | $0.411 | 51s | 81.2 | pass | 44 |
| gpt-6.1-sol@high | openai | mid | 96.4 | 2.36 | $0.097 | 117s | 79.4 | pass | 44 |
| gpt-6-astra@medium | openai | powerful | 96.4 | 2.17 | $0.344 | 66s | 77.4 | pass | 44 |
| gpt-6.1-sol@xhigh | openai | mid | 96.4 | 2.45 | $0.130 | 200s | 75.4 | pass | 44 |

Incomplete (cells to run next):
- gpt-6.1-terra@high: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@medium: reviewer-plan-elegance: 0 of 10 tasks
- gpt-6.1-terra@xhigh: reviewer-plan-elegance: 0 of 10 tasks

Policy:

```
reviewer-elegance (ROLE_MODEL_DEFAULTS entry: reviewer-elegance)
  1. anthropic claude-opus-5.5 medium
  2. openai gpt-6.1-sol medium
  fallback: mid, medium
  evidence: reviewer-code-elegance-2026-11-11T21-48-22-147Z, reviewer-code-elegance-2026-11-12T00-44-54-328Z, reviewer-plan-elegance-2026-11-13T14-48-59-768Z, reviewer-plan-elegance-2026-11-14T06-37-02-914Z
```

### Judged by claude-opus-5.5:xhigh

Judge: claude-opus-5.5:xhigh (other judges in these records: gpt-6.1-sol:xhigh 384 scores)
Corpora: reviewer-code-elegance (12 tasks), reviewer-plan-elegance (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-elegance cec5130f (216 cells), reviewer-code-elegance 73caf06c (48 cells), reviewer-plan-elegance 6ed0c9ee (40 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 2.43. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | recall % | false P1/P2 per review | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 1.83 | $0.195 | 45s | 86.8 | pass | 68 |
| gpt-6.1-sol@medium | openai | mid | 96.4 | 2.14 | $0.076 | 76s | 83.4 | pass | 68 |

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
  1. anthropic claude-opus-5.5 medium
  2. openai gpt-6.1-sol medium
  fallback: mid, medium
  evidence: reviewer-code-elegance-2026-11-11T21-48-22-147Z, reviewer-code-elegance-2026-11-12T00-44-54-328Z, reviewer-plan-elegance-2026-11-13T14-48-59-768Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by gpt-6.1-sol:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh |
|---|---|---|---|---|---|---|
| plan-elegance-audit-sinks | 0/0+1 0/0+2 | 0/0+1 0/0+2 | 0/0+4 0/0+3 | 0/0+3 0/0+5 | 0/0+4 0/0+3 | 0/0+5 0/0+5 |
| plan-elegance-loyalty-tier | 2/2+1 2/2+1 | 2/2+2 2/2+1 | 2/2+1 2/2+3 | 2/2+1 2/2+1 | 2/2+2 2/2+2 | 2/2+1 2/2+1 |
| plan-elegance-money-format | 0/0+3 0/0+3 | 0/0+4 0/0+2 | 0/0+3 0/0+3 | 0/0+5 0/0+5 | 0/0+3 0/0+3 | 0/0+4 0/0+4 |
| plan-elegance-quiet-hours | 2/2+2 2/2+3 | 2/2+3 2/2+4 | 2/2+3 2/2+5 | 2/2+5 2/2+4 | 2/2+4 2/2+3 | 2/2+6 2/2+4 |
| plan-elegance-reorder-report | 2/2+1 2/2+1 | 2/2 2/2+2 | 2/2+2 2/2+1 | 2/2 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2 |
| plan-elegance-sales-export | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 |
| plan-elegance-session-expiry | 0/0+3 0/0+4 | 0/0+3 0/0+4 | 0/0+3 0/0+3 | 0/0+3 0/0+3 | 0/0+4 0/0+3 | 0/0+3 0/0+3 |
| plan-elegance-tag-search | 1/1+3 1/1+3 | 1/1+2 1/1+2 | 1/1+1 1/1+3 | 1/1+1 1/1+3 | 1/1+2 1/1+2 | 1/1+2 1/1+4 |
| plan-elegance-webhook-retry | 1/1+2 1/1+2 | 1/1+2 1/1+1 | 1/1+4 1/1+3 | 1/1+3 1/1+4 | 1/1+3 1/1+3 | 1/1+2 1/1+3 |
| plan-elegance-weekend-surcharge | 1/1+2 1/1+2 | 1/1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 |

### Scored by claude-opus-5.5:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh |
|---|---|---|---|---|---|---|
| plan-elegance-audit-sinks | ? ? | 0/0+1 0/0+2 | ? ? | ? ? | 0/0+4 0/0+3 | ? ? |
| plan-elegance-loyalty-tier | ? ? | 2/2+1 2/2+1 | ? ? | ? ? | 2/2+2 2/2+2 | ? ? |
| plan-elegance-money-format | ? ? | 0/0+4 0/0+2 | ? ? | ? ? | 0/0+3 0/0+3 | ? ? |
| plan-elegance-quiet-hours | ? ? | 2/2+3 2/2+4 | ? ? | ? ? | 2/2+4 2/2+3 | ? ? |
| plan-elegance-reorder-report | ? ? | 2/2 2/2+2 | ? ? | ? ? | 2/2+1 2/2+1 | ? ? |
| plan-elegance-sales-export | ? ? | 2/2+1 2/2+1 | ? ? | ? ? | 2/2+2 2/2+2 | ? ? |
| plan-elegance-session-expiry | ? ? | 0/0+3 0/0+4 | ? ? | ? ? | 0/0+4 0/0+3 | ? ? |
| plan-elegance-tag-search | ? ? | 1/1+2 1/1+2 | ? ? | ? ? | 1/1+2 1/1+2 | ? ? |
| plan-elegance-webhook-retry | ? ? | 1/1+2 1/1+1 | ? ? | ? ? | 1/1+3 1/1+3 | ? ? |
| plan-elegance-weekend-surcharge | ? ? | 1/1 1/1+1 | ? ? | ? ? | 1/1+1 1/1+1 | ? ? |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | recall % (gpt-6.1-sol:xhigh) | false P1/P2 per review (gpt-6.1-sol:xhigh) | recall % (claude-opus-5.5:xhigh) | false P1/P2 per review (claude-opus-5.5:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 20 | 100.0 | 2.05 | n/a | n/a | 0 | $8.532 | 1893819 | 52s | claude_agent_sdk |
| claude-opus-5.5@medium | 20 | 100.0 | 1.90 | 100.0 | 1.85 | 0 | $4.173 | 2012124 | 50s | claude_agent_sdk |
| gpt-6-astra@medium | 20 | 100.0 | 2.55 | n/a | n/a | 0 | $7.888 | 1780623 | 89s | chatgpt |
| gpt-6.1-sol@high | 20 | 100.0 | 2.60 | n/a | n/a | 0 | $2.254 | 2347657 | 164s | chatgpt |
| gpt-6.1-sol@medium | 20 | 100.0 | 2.45 | 100.0 | 2.45 | 0 | $1.697 | 2031834 | 107s | chatgpt |
| gpt-6.1-sol@xhigh | 20 | 100.0 | 2.70 | n/a | n/a | 0 | $3.153 | 3105948 | 308s | chatgpt |

## Coverage

Suite tasks that a setting has no current cell of:

- None: every setting has a current cell of every suite task.

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-13T14-48-59-768Z | claude-opus-5.5@medium, gpt-6.1-sol@medium | gpt-6.1-sol:xhigh | 40 | 80 | 0 | 0 | not recorded |
| 2026-11-14T06-37-02-914Z | claude-fable-5.2@low, gpt-6-astra@medium, gpt-6.1-sol@high, gpt-6.1-sol@xhigh | gpt-6.1-sol:xhigh | 80 | 80 | 0 | 0 | 7b6cf8a856b5 |
