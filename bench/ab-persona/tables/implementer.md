# implementer benchmark results

This page is generated from the record files in `bench/ab-persona/records/implementer/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: implementer. Mode: implement. Corpus: 14 tasks, of which 4 are the ranking suite. Records: 8 campaigns, 198 cells, 12 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role implementer, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: gpt-6.2-sol:high 112 scores)
Corpora: implementer (4 tasks of 14: its ranking suite)
Persona guidance: implementer 1dfb0b75 (45 cells), implementer 645ae0c6 (1 cells)
Filters: hidden-test pass % >= 0.0, followed false claims % <= 0.00. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | hidden-test pass % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|

Incomplete (cells to run next):
- claude-fable-5.2@low: implementer: 2 of 4 tasks
- claude-opus-5.5@high: implementer: 3 of 4 tasks
- claude-opus-5.5@medium: implementer: 2 of 4 tasks
- gemini-4-hydrogen@high: implementer: 1 of 4 tasks
- gpt-6-astra@low: implementer: 2 of 4 tasks
- gpt-6.1-sol@high: implementer: 3 of 4 tasks
- gpt-6.1-sol@medium: implementer: 2 of 4 tasks
- gpt-6.1-sol@xhigh: implementer: 3 of 4 tasks

Cells to retry (failed with no result; a resume runs them again):
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| implementer | 2026-11-13T21-16-42-634Z | 17 | task grader changed (--regrade grades it with the current grader) |
| implementer | 2026-11-13T21-16-44-771Z | 22 | task grader changed (--regrade grades it with the current grader) |
| implementer | 2026-11-24T07-13-03-614Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T07-24-16-693Z | 30 | task outside the ranking suite |
| implementer | 2026-11-24T07-24-16-693Z | 12 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T14-59-24-385Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T15-07-31-792Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T15-17-18-831Z | 30 | task outside the ranking suite |
| implementer | 2026-11-24T15-17-18-831Z | 11 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T23-57-38-543Z | 20 | task outside the ranking suite |
| implementer | 2026-11-24T23-57-38-543Z | 7 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  fallback: none (no setting passes the filters)
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T15-17-18-831Z
```

### Judged by gpt-6.2-sol:high

Judge: gpt-6.2-sol:high (other judges in these records: gpt-6.1-sol:xhigh 81 scores)
Corpora: implementer (4 tasks of 14: its ranking suite)
Persona guidance: implementer 1dfb0b75 (3 cells), implementer 645ae0c6 (31 cells)
Filters: hidden-test pass % >= 65.0, followed false claims % <= 26.67. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | hidden-test pass % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gemini-4-neon@high | other | unpriced | 75.0 | 16.67 | >= $3.362 (8 of 12 cells partly unpriced) | 797s | 53.9 | pass | 12 |
| claude-opus-5-5@high | anthropic | powerful | 73.2 | 25.00 | $1.905 | 500s | 48.2 | pass | 8 |
| gemini-4-hydrogen@high | other | unpriced | 56.0 | 21.43 | >= $3.562 (8 of 11 cells partly unpriced) | 860s | 29.5 | quality | 11 (1 timed out) |

A lower-bound cost enters the score as its bound, which can only flatter that setting.

Incomplete (cells to run next):
- claude-opus-5.5@high: implementer: 1 of 4 tasks
- gpt-6.1-sol@high: implementer: 1 of 4 tasks
- gpt-6.1-sol@xhigh: implementer: 1 of 4 tasks

Cells to retry (failed with no result; a resume runs them again):
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| implementer | 2026-11-13T21-16-42-634Z | 18 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |
| implementer | 2026-11-13T21-16-42-634Z | 17 | task grader changed (--regrade grades it with the current grader) |
| implementer | 2026-11-13T21-16-44-771Z | 24 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |
| implementer | 2026-11-13T21-16-44-771Z | 22 | task grader changed (--regrade grades it with the current grader) |
| implementer | 2026-11-24T07-13-03-614Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T07-24-16-693Z | 30 | task outside the ranking suite |
| implementer | 2026-11-24T14-59-24-385Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T15-07-31-792Z | 1 | task outside the ranking suite |
| implementer | 2026-11-24T15-17-18-831Z | 30 | task outside the ranking suite |
| implementer | 2026-11-24T23-57-38-543Z | 20 | task outside the ranking suite |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  1. anthropic claude-opus-5-5 high
  fallback: powerful, high
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T07-24-16-693Z, implementer-2026-11-24T15-17-18-831Z, implementer-2026-11-24T23-57-38-543Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. P: every hidden test passed. F(p/t): p of t hidden tests passed. T: the cell hit its time limit, a failed attempt. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it; it shows the latest grade that the records hold. (suite) marks a task of the ranking suite.

| Task | claude-fable-5.2@low | claude-opus-5-5@high | claude-opus-5.5@high | claude-opus-5.5@medium | gemini-3.8-flash@low | gemini-4-hydrogen@high | gemini-4-neon@high | gpt-6-astra@low | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh |
|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-14598 | - | F(175/176)* F(175/176)* | - | - | - | P* P* P* | P* P* P* | - | - | - | - |
| ds1000-298 | - | F(0/1) F(0/1) | - | - | - | P P P | P P P | - | - | - | - |
| getmoto__moto-7365 | - | P P | - | - | - | P P P | P P P | - | - | - | - |
| hosted-thinking-row-wait (suite) | F(6/7) F(6/7) F(6/7) | F(6/7) P | P F(6/7) P | F(6/7) P F(6/7) | - | P F(1/7) | P P P | P F(6/7) P | P P P | P P F(6/7) | P P P |
| httpx-streaming-json-iteration (suite) | P* P* F(0/1)* | F(0/1) F(0/1) | F(0/1)* F(0/1)* F(0/1)* | F(0/1)* F(0/1)* F(0/1)* | - | F(0/1) F(0/1) F(0/1) | F(0/1) F(0/1) F(0/1) | P* P* P* | P* P* P* | P* P* P* | P* P* P* |
| jquense__yup-2305 | - | P P | - | - | - | P P P | P P P | - | - | - | - |
| metrics-resteer | - | P P | - | - | P P F(8/10) | P P P | P P P | - | - | - | - |
| psf__requests-6028 | - | P P | - | - | - | P P P | P P P | - | - | - | - |
| recall-punctuated-words (suite) | P P P | P P | P P P | P P P | - | P P P | P P P | P P P | P P P | P P P | P P P |
| redis__redis-10068 | - | P P | - | - | - | P P P | P P P | - | - | - | - |
| regex-chess | - | P P | - | - | - | P P P | P P P | - | - | - | - |
| rust-react | - | P* P* | - | - | - | P* P* P | P* P* P | - | - | - | - |
| scheme-metacircular (suite) | P* P* P* | P P | P* P* T | P* P* P* | - | P T P | P P P | P* P* P* | T P* P* | P* P* P* | P* P* T |
| template-multiphase | - | P P | - | - | - | P P P | P P P | - | - | - | - |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. A full pass reads the grade that the matrix shows.

| Setting | Cells | Full passes | Timed out | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 12 | 8 | 0 | 1 | $23.031 | 9355446 | 214s | claude_agent_sdk |
| claude-opus-5-5@high | 28 | 21 | 0 | 0 | $25.971 | 25050860 | 136s | claude_agent_sdk |
| claude-opus-5.5@high | 12 | 7 | 1 | 0 | $25.386 | 31819674 | 455s | claude_agent_sdk |
| claude-opus-5.5@medium | 12 | 7 | 0 | 0 | $14.800 | 17272214 | 294s | claude_agent_sdk |
| gemini-3.8-flash@low | 3 | 2 | 0 | 0 | >= $1.078 (3 cells partly unpriced) | >= 1542085 | 106s | google_antigravity |
| gemini-4-hydrogen@high | 41 | 36 | 1 | 3 | >= $82.057 (28 cells partly unpriced) | >= 83815115 | 475s | google_antigravity |
| gemini-4-neon@high | 42 | 39 | 0 | 2 | >= $96.082 (28 cells partly unpriced) | >= 49745694 | 581s | google_antigravity |
| gpt-6-astra@low | 12 | 11 | 0 | 1 | >= $20.617 (1 cell partly unpriced) | >= 11054620 | 234s | chatgpt |
| gpt-6.1-sol@high | 12 | 11 | 1 | 2 | >= $6.578 (1 cell partly unpriced) | >= 23571007 | 694s | chatgpt |
| gpt-6.1-sol@medium | 12 | 11 | 0 | 1 | $4.378 | 15814692 | 425s | chatgpt |
| gpt-6.1-sol@xhigh | 12 | 11 | 1 | 2 | >= $7.897 (2 cells partly unpriced) | >= 26450755 | 732s | chatgpt |

## Coverage

Suite tasks that a setting has no current cell of:

- claude-fable-5.2@low: httpx-streaming-json-iteration, scheme-metacircular
- claude-opus-5.5@high: httpx-streaming-json-iteration
- claude-opus-5.5@medium: httpx-streaming-json-iteration, scheme-metacircular
- gemini-3.8-flash@low: hosted-thinking-row-wait, httpx-streaming-json-iteration, recall-punctuated-words, scheme-metacircular
- gpt-6-astra@low: httpx-streaming-json-iteration, scheme-metacircular
- gpt-6.1-sol@high: httpx-streaming-json-iteration
- gpt-6.1-sol@medium: httpx-streaming-json-iteration, scheme-metacircular
- gpt-6.1-sol@xhigh: httpx-streaming-json-iteration

Cells to retry (every attempt failed with no result; a resume runs them again):

- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (2026-11-24T23-57-38-543Z), 3 failed attempts: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-13T21-16-42-634Z | claude-fable-5.2@low, claude-opus-5.5@high, claude-opus-5.5@medium | gpt-6.1-sol:xhigh | 36 | 35 | 24 | 1 | not recorded |
| 2026-11-13T21-16-44-771Z | gpt-6-astra@low, gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh | gpt-6.1-sol:xhigh | 48 | 46 | 30 | 6 | not recorded |
| 2026-11-24T07-13-03-614Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 0 | 0 | 09680054133f |
| 2026-11-24T07-24-16-693Z | claude-opus-5-5@high, gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 42 | 42 | 0 | 0 | ee74385de2bd |
| 2026-11-24T14-59-24-385Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 0 | 0 | 1b7e3eb81399 |
| 2026-11-24T15-07-31-792Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 0 | 0 | 1f146dfe1b5f |
| 2026-11-24T15-17-18-831Z | claude-opus-5-5@high, gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 42 | 40 | 0 | 2 | 1f146dfe1b5f, b6d307b80714 |
| 2026-11-24T23-57-38-543Z | gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 27 | 27 | 0 | 3 | b718866b40ff |
