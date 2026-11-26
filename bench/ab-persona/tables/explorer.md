# explorer benchmark results

This page is generated from the record files in `bench/ab-persona/records/explorer/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: explorer. Mode: research. Corpus: 15 tasks. Records: 2 campaigns, 96 cells, 0 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role explorer, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh
Corpora: explorer (12 tasks)
Persona guidance: explorer 58d0c12d (96 cells)
Filters: fact recall % >= 77.1, trap rate % <= 10.00. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | fact recall % | trap rate % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.1-sol@low | openai | mid | 87.1 | 0.00 | >= $0.183 (2 of 12 cells partly unpriced) | 84s | 83.8 | pass | 12 |
| gpt-6-luna@high | openai | cheap | 71.4 | 0.00 | >= $0.010 (2 of 12 cells partly unpriced) | 83s | 80.8 | quality | 12 |
| claude-sonnet-5.5@low | anthropic | mid | 77.1 | 0.00 | $0.185 | 39s | 77.1 | pass | 12 |
| claude-sonnet-5.5@medium | anthropic | mid | 85.7 | 8.33 | $0.243 | 49s | 75.1 | pass | 12 |
| gpt-6-luna@xhigh | openai | cheap | 72.9 | 0.00 | $0.029 | 306s | 72.0 | quality | 12 |
| gpt-6.1-sol@medium | openai | mid | 81.4 | 8.33 | >= $0.217 (5 of 12 cells partly unpriced) | 110s | 67.9 | pass | 12 |
| claude-haiku-5.5@medium | anthropic | cheap | 80.0 | 16.67 | $0.047 | 105s | 65.0 | false | 12 |
| claude-haiku-5.5@high | anthropic | cheap | 81.4 | 25.00 | $0.067 | 163s | 54.6 | false | 12 |

A lower-bound cost enters the score as its bound, which can only flatter that setting.

Policy:

```
explorer (ROLE_MODEL_DEFAULTS entry: explorer)
  1. openai gpt-6.1-sol low
  2. anthropic claude-sonnet-5.5 low
  fallback: mid, medium
  evidence: explorer-2026-11-13T21-20-04-158Z, explorer-2026-11-13T21-20-06-290Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. c/f: the answer stated c of f key facts. t: the answer asserted a trap. ?: no score by this judge under the current scoring version. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it.

### Scored by gpt-6.1-sol:xhigh

| Task | claude-haiku-5.5@high | claude-haiku-5.5@medium | claude-sonnet-5.5@low | claude-sonnet-5.5@medium | gpt-6-luna@high | gpt-6-luna@xhigh | gpt-6.1-sol@low | gpt-6.1-sol@medium |
|---|---|---|---|---|---|---|---|---|
| background-command-turn-end-wait | 4/6 | 4/6 | 4/6 | 4/6 | 3/6 | 4/6 | 5/6 | 4/6 |
| concurrency-limit-quota | 4/4t | 4/4 | 3/4 | 4/4 | 3/4 | 3/4 | 4/4 | 4/4 |
| conversation-tree-reopen-fold | 6/7 | 5/7t | 6/7 | 6/7 | 6/7 | 6/7 | 7/7 | 6/7 |
| edit-mixed-parameter-syntax | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 5/5 | 5/5 |
| model-effort-resolution | - | - | - | - | - | - | - | - |
| prompt-cache-key-by-request-kind | 7/7 | 6/7 | 6/7 | 7/7 | 5/7 | 6/7 | 7/7 | 6/7 |
| resume-while-agent-opens | 3/4 | 4/4 | 3/4 | 4/4 | 3/4 | 2/4 | 4/4 | 4/4 |
| role-config-prune-scope | 6/6t | 5/6 | 4/6 | 5/6t | 5/6 | 5/6 | 6/6 | 6/6t |
| session-disposal | - | - | - | - | - | - | - | - |
| stop-during-signed-thinking-row | 5/6 | 5/6 | 6/6 | 6/6 | 4/6 | 5/6 | 5/6 | 5/6 |
| streaming-output | - | - | - | - | - | - | - | - |
| subagent-handoff-contract-failure | 4/6 | 5/6 | 3/6 | 5/6 | 5/6 | 4/6 | 4/6 | 4/6 |
| unattended-spent-capacity-vs-chat | 6/6 | 5/6 | 6/6 | 6/6 | 4/6 | 5/6 | 6/6 | 6/6 |
| unreadable-launch-link-subtree | 5/7 | 5/7 | 5/7 | 5/7 | 5/7 | 5/7 | 5/7 | 5/7 |
| unshown-session-resume-paths | 2/6t | 3/6t | 3/6 | 3/6 | 3/6 | 2/6 | 3/6 | 2/6 |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. The fact recall % share counts every scored cell; the ranking instead weighs each corpus the same.

| Setting | Cells | fact recall % (gpt-6.1-sol:xhigh) | trap rate % (gpt-6.1-sol:xhigh) | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| claude-haiku-5.5@high | 12 | 81.4 | 25.0 | 0 | $0.805 | 31423789 | 163s | claude_agent_sdk |
| claude-haiku-5.5@medium | 12 | 80.0 | 16.7 | 0 | $0.558 | 21144147 | 105s | claude_agent_sdk |
| claude-sonnet-5.5@low | 12 | 77.1 | 0.0 | 0 | $2.220 | 5222597 | 39s | claude_agent_sdk |
| claude-sonnet-5.5@medium | 12 | 85.7 | 8.3 | 0 | $2.913 | 6815216 | 49s | claude_agent_sdk |
| gpt-6-luna@high | 12 | 71.4 | 0.0 | 0 | >= $0.117 (2 cells partly unpriced) | >= 5132429 | 83s | chatgpt |
| gpt-6-luna@xhigh | 12 | 72.9 | 0.0 | 0 | $0.342 | 15566916 | 306s | chatgpt |
| gpt-6.1-sol@low | 12 | 87.1 | 0.0 | 0 | >= $2.201 (2 cells partly unpriced) | >= 6400738 | 84s | chatgpt |
| gpt-6.1-sol@medium | 12 | 81.4 | 8.3 | 0 | >= $2.602 (5 cells partly unpriced) | >= 6986558 | 110s | chatgpt |

## Coverage

Corpus tasks that a setting has no current cell of:

- None: every setting has a current cell of every corpus task.

Cells to retry (every attempt failed with no result; a resume runs them again):

- None.

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-13T21-20-04-158Z | gpt-6-luna@high, gpt-6-luna@xhigh, gpt-6.1-sol@low, gpt-6.1-sol@medium | gpt-6.1-sol:xhigh | 48 | 48 | 0 | 0 | not recorded |
| 2026-11-13T21-20-06-290Z | claude-haiku-5.5@high, claude-haiku-5.5@medium, claude-sonnet-5.5@low, claude-sonnet-5.5@medium | gpt-6.1-sol:xhigh | 48 | 48 | 0 | 0 | not recorded |
