# reviewer-mechanism benchmark results

This page is generated from the record files in `bench/ab-persona/records/reviewer-mechanism/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: reviewer-mechanism. Mode: reviewer. Corpus: 10 tasks. Records: 1 campaign, 180 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role reviewer-mechanism, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by claude-opus-5.5:xhigh

Judge: claude-opus-5.5:xhigh (other judges in these records: gpt-6.1-sol:xhigh 180 scores)
Corpora: reviewer-mechanism (10 tasks)
Persona guidance: reviewer-mechanism 00931ea6 (180 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 0.65. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | recall % | false P1/P2 per review | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-terra@medium | openai | cheap | 100.0 | 0.85 | $0.019 | 29s | 101.4 | false | 20 |
| gpt-6.1-terra@high | openai | cheap | 100.0 | 1.15 | $0.020 | 31s | 99.5 | false | 20 |
| gpt-6.1-sol@medium | openai | mid | 100.0 | 0.25 | $0.065 | 49s | 96.8 | pass | 20 |
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 0.10 | $0.143 | 31s | 96.1 | pass | 20 |
| gpt-6.1-terra@xhigh | openai | cheap | 100.0 | 1.25 | $0.028 | 49s | 95.6 | false | 20 |
| gpt-6.1-sol@high | openai | mid | 100.0 | 0.40 | $0.074 | 72s | 93.8 | pass | 20 |
| gpt-6-astra@medium | openai | powerful | 100.0 | 0.05 | $0.300 | 52s | 90.9 | pass | 20 |
| claude-fable-5.2@low | anthropic | powerful | 100.0 | 0.05 | $0.329 | 48s | 90.9 | pass | 20 |
| gpt-6.1-sol@xhigh | openai | mid | 100.0 | 0.35 | $0.099 | 123s | 90.5 | pass | 20 |

Policy:

```
reviewer-mechanism (ROLE_MODEL_DEFAULTS entry: reviewer-mechanism)
  1. openai gpt-6.1-sol medium
  2. anthropic claude-opus-5.5 medium
  fallback: mid, medium
  evidence: reviewer-mechanism-2026-11-11T21-48-24-057Z
```

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: claude-opus-5.5:xhigh 180 scores)
Corpora: reviewer-mechanism (10 tasks)
Persona guidance: reviewer-mechanism 00931ea6 (180 cells)
Filters: recall % >= 90.0, false P1/P2 per review <= 0.65. Score = quality - 5 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | recall % | false P1/P2 per review | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-terra@medium | openai | cheap | 100.0 | 0.85 | $0.019 | 29s | 101.4 | false | 20 |
| gpt-6.1-terra@high | openai | cheap | 100.0 | 1.15 | $0.020 | 31s | 99.5 | false | 20 |
| gpt-6.1-sol@medium | openai | mid | 100.0 | 0.25 | $0.065 | 49s | 96.8 | pass | 20 |
| claude-opus-5.5@medium | anthropic | powerful | 100.0 | 0.10 | $0.143 | 31s | 96.1 | pass | 20 |
| gpt-6.1-terra@xhigh | openai | cheap | 100.0 | 1.25 | $0.028 | 49s | 95.6 | false | 20 |
| gpt-6.1-sol@high | openai | mid | 100.0 | 0.40 | $0.074 | 72s | 93.8 | pass | 20 |
| gpt-6-astra@medium | openai | powerful | 100.0 | 0.05 | $0.300 | 52s | 90.9 | pass | 20 |
| claude-fable-5.2@low | anthropic | powerful | 100.0 | 0.05 | $0.329 | 48s | 90.9 | pass | 20 |
| gpt-6.1-sol@xhigh | openai | mid | 100.0 | 0.35 | $0.099 | 123s | 90.5 | pass | 20 |

Policy:

```
reviewer-mechanism (ROLE_MODEL_DEFAULTS entry: reviewer-mechanism)
  1. openai gpt-6.1-sol medium
  2. anthropic claude-opus-5.5 medium
  fallback: mid, medium
  evidence: reviewer-mechanism-2026-11-11T21-48-24-057Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/d: the review caught c of d seeded defects. +n: n unsupported P1/P2 findings. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by claude-opus-5.5:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh |
|---|---|---|---|---|---|---|---|---|---|
| mechanism-chunked-upload | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 |
| mechanism-config-reload | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+2 1/1+2 |
| mechanism-export-sweep | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0+1 | 0/0 0/0 | 0/0+1 0/0 | 0/0+3 0/0+3 | 0/0 0/0+3 | 0/0+3 0/0+3 |
| mechanism-flag-rollout | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0 0/0+1 |
| mechanism-job-lease | 2/2+1 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2 2/2+1 | 2/2+1 2/2+1 |
| mechanism-member-events | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 |
| mechanism-order-journal | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+2 2/2 | 2/2+2 2/2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+3 |
| mechanism-rate-window | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 |
| mechanism-session-cache | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+2 |
| mechanism-wallet-transfer | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2+1 2/2+1 |

### Scored by gpt-6.1-sol:xhigh

| Task | claude-fable-5.2@low | claude-opus-5.5@medium | gpt-6-astra@medium | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.1-terra@high | gpt-6.1-terra@medium | gpt-6.1-terra@xhigh |
|---|---|---|---|---|---|---|---|---|---|
| mechanism-chunked-upload | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 |
| mechanism-config-reload | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+2 1/1+2 | 1/1+1 1/1+1 | 1/1+2 1/1+2 |
| mechanism-export-sweep | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0+1 | 0/0 0/0 | 0/0+1 0/0 | 0/0+3 0/0+3 | 0/0 0/0+3 | 0/0+3 0/0+3 |
| mechanism-flag-rollout | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0+1 0/0+1 | 0/0+1 0/0+1 | 0/0 0/0+1 |
| mechanism-job-lease | 2/2+1 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2+1 2/2+1 | 2/2 2/2+1 | 2/2+1 2/2+1 |
| mechanism-member-events | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 |
| mechanism-order-journal | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+2 2/2 | 2/2+2 2/2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+2 | 2/2+2 2/2+3 |
| mechanism-rate-window | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 | 0/0 0/0 |
| mechanism-session-cache | 1/1 1/1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 1/1 1/1 | 1/1 1/1 | 1/1+1 1/1+1 | 1/1+1 1/1+1 | 1/1+1 1/1+2 |
| mechanism-wallet-transfer | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2 2/2 | 2/2+1 2/2 | 2/2+1 2/2 | 2/2+1 2/2+1 |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | recall % (claude-opus-5.5:xhigh) | false P1/P2 per review (claude-opus-5.5:xhigh) | recall % (gpt-6.1-sol:xhigh) | false P1/P2 per review (gpt-6.1-sol:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 20 | 100.0 | 0.05 | 100.0 | 0.05 | 0 | $6.582 | 1676919 | 48s | claude_agent_sdk |
| claude-opus-5.5@medium | 20 | 100.0 | 0.10 | 100.0 | 0.10 | 0 | $2.852 | 1420483 | 31s | claude_agent_sdk |
| gpt-6-astra@medium | 20 | 100.0 | 0.05 | 100.0 | 0.05 | 0 | $5.999 | 1552813 | 52s | chatgpt |
| gpt-6.1-sol@high | 20 | 100.0 | 0.40 | 100.0 | 0.40 | 0 | $1.488 | 1623088 | 72s | chatgpt |
| gpt-6.1-sol@medium | 20 | 100.0 | 0.25 | 100.0 | 0.25 | 0 | $1.304 | 1508109 | 49s | chatgpt |
| gpt-6.1-sol@xhigh | 20 | 100.0 | 0.35 | 100.0 | 0.35 | 0 | $1.989 | 2031737 | 123s | chatgpt |
| gpt-6.1-terra@high | 20 | 100.0 | 1.15 | 100.0 | 1.15 | 0 | $0.395 | 1300512 | 31s | chatgpt |
| gpt-6.1-terra@medium | 20 | 100.0 | 0.85 | 100.0 | 0.85 | 0 | $0.380 | 1327216 | 29s | chatgpt |
| gpt-6.1-terra@xhigh | 20 | 100.0 | 1.25 | 100.0 | 1.25 | 0 | $0.551 | 1675959 | 49s | chatgpt |

## Coverage

Suite tasks that a setting has no current cell of:

- None: every setting has a current cell of every suite task.

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-11T21-48-24-057Z | claude-fable-5.2@low, claude-opus-5.5@medium, gpt-6-astra@medium, gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh, gpt-6.1-terra@high, gpt-6.1-terra@medium, gpt-6.1-terra@xhigh | gpt-6.1-sol:xhigh | 180 | 360 | 0 | 0 | not recorded |
