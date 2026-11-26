# reviewer-plan-quality benchmark results

This page is generated from the record files in `bench/ab-persona/records/reviewer-plan-quality/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: reviewer-quality. Mode: reviewer. Corpus: 10 tasks. Records: 1 campaign, 60 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role reviewer-quality, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: claude-opus-5.5:xhigh 618 scores)
Corpora: reviewer-code-quality (31 tasks), reviewer-plan-quality (10 tasks), averaged with equal weight
Persona guidance: reviewer-code-quality 335687bc (652 cells), reviewer-plan-quality a89b31cc (60 cells)
Filters: recall % >= 83.8, false P1/P2 per review <= 1.99. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | recall % | false P1/P2 per review | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-sol@high | openai | mid | 92.3 | 1.39 | $0.216 | 148s | 83.1 | pass | 82 |
| gpt-6.1-sol@xhigh | openai | mid | 93.8 | 1.50 | $0.309 | 296s | 79.4 | pass | 82 |
| claude-opus-5.5@medium | anthropic | powerful | 89.4 | 1.46 | $0.542 | 88s | 78.1 | pass | 82 |

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
  1. openai gpt-6.1-sol high
  2. anthropic claude-opus-5.5 medium
  fallback: mid, xhigh
  evidence: reviewer-code-quality-2026-11-11T01-03-13-088Z, reviewer-code-quality-2026-11-11T01-04-30-041Z, reviewer-code-quality-2026-11-11T05-15-25-509Z, reviewer-code-quality-2026-11-11T06-50-30-346Z, reviewer-code-quality-2026-11-11T15-32-09-950Z, reviewer-plan-quality-2026-11-14T06-37-01-303Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by gpt-6.1-sol:xhigh

| Task | claude-opus-5.5@medium | gpt-6.1-sol@high | gpt-6.1-sol@xhigh |
|---|---|---|---|
| plan-quality-bin-locations | 2/2+3 2/2+3 | 2/2+1 2/2+2 | 2/2+1 2/2+1 |
| plan-quality-clinic-reminders | 2/2+3 2/2+1 | 2/2+2 2/2+3 | 2/2+2 2/2+2 |
| plan-quality-library-renewals | 0/0+1 0/0+3 | 0/0+3 0/0+4 | 0/0+5 0/0+3 |
| plan-quality-member-export | 2/2+2 2/2+1 | 2/2 2/2 | 2/2 2/2 |
| plan-quality-parking-permits | 0/0 0/0+1 | 0/0+4 0/0+2 | 0/0+1 0/0+5 |
| plan-quality-recipe-scaling | 0/0+3 0/0+2 | 0/0+1 0/0+3 | 0/0+2 0/0+3 |
| plan-quality-seat-map | 2/2+2 2/2+1 | 2/2+1 2/2+2 | 2/2+2 2/2+2 |
| plan-quality-store-refunds | 2/2+2 2/2+3 | 2/2+1 2/2+1 | 2/2+2 2/2+2 |
| plan-quality-timesheet-rounding | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 |
| plan-quality-wiki-cache | 1/1+1 1/1+1 | 1/1+2 1/1+1 | 1/1+2 1/1 |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | recall % (gpt-6.1-sol:xhigh) | false P1/P2 per review (gpt-6.1-sol:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| claude-opus-5.5@medium | 20 | 100.0 | 1.65 | 0 | $4.006 | 1727919 | 47s | claude_agent_sdk |
| gpt-6.1-sol@high | 20 | 100.0 | 1.70 | 0 | $2.136 | 2367515 | 129s | chatgpt |
| gpt-6.1-sol@xhigh | 20 | 100.0 | 1.80 | 0 | $2.894 | 3049280 | 250s | chatgpt |

## Coverage

Suite tasks that a setting has no current cell of:

- None: every setting has a current cell of every suite task.

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-14T06-37-01-303Z | claude-opus-5.5@medium, gpt-6.1-sol@high, gpt-6.1-sol@xhigh | gpt-6.1-sol:xhigh | 60 | 60 | 0 | 0 | 7b6cf8a856b5 |
