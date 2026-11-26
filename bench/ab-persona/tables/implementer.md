# implementer benchmark results

This page is generated from the record files in `bench/ab-persona/records/implementer/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: implementer. Mode: implement. Corpus: 14 tasks, of which 4 are the ranking suite. Records: 16 campaigns, 354 cells, 23 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role implementer, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.2-sol:high

Judge: gpt-6.2-sol:high (other judges in these records: gpt-6.1-sol:xhigh 81 scores)
Corpora: implementer (4 tasks of 14: its ranking suite)
Persona guidance: implementer 1dfb0b75 (3 cells), implementer 645ae0c6 (71 cells)
Filters: hidden-test pass % >= 90.0, followed false claims % <= 26.67. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | hidden-test pass % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.2-sol@medium | openai | mid | 100.0 | 16.67 | >= $0.456 (1 of 8 cells partly unpriced) | 464s | 80.7 | pass | 8 |
| gpt-6.2-sol@high | openai | mid | 100.0 | 16.67 | >= $0.678 (1 of 8 cells partly unpriced) | 680s | 77.3 | pass | 8 |
| gpt-6.1-sol@medium | openai | mid | 99.5 | 25.00 | $0.322 | 356s | 74.5 | pass | 8 |
| gemini-4-neon@medium | other | unpriced | 75.0 | 16.67 | $1.023 | 489s | 52.0 | quality | 8 |
| gemini-4-neon@high | other | unpriced | 75.0 | 16.67 | >= $3.362 (8 of 12 cells partly unpriced) | 797s | 44.7 | quality | 12 |
| claude-opus-5-5@medium | anthropic | powerful | 73.2 | 25.00 | $1.213 | 287s | 43.4 | quality | 8 (1 timed out) |
| claude-opus-5-5@high | anthropic | powerful | 73.2 | 25.00 | $1.905 | 500s | 39.1 | quality | 8 |
| gemini-4-hydrogen@high | other | unpriced | 56.0 | 21.43 | >= $3.562 (8 of 11 cells partly unpriced) | 860s | 20.3 | quality | 11 (1 timed out) |

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
| implementer | 2026-11-26T06-06-30-601Z | 54 | task outside the ranking suite |
| implementer | 2026-11-26T06-08-53-448Z | 18 | task outside the ranking suite |
| implementer | 2026-11-26T06-24-57-058Z | 8 | task outside the ranking suite |
| implementer | 2026-11-26T08-48-39-529Z | 6 | task outside the ranking suite |
| implementer | 2026-11-26T08-56-29-270Z | 4 | task outside the ranking suite |
| implementer | 2026-11-26T09-25-40-966Z | 2 | task outside the ranking suite |
| implementer | 2026-11-26T14-27-47-990Z | 20 | task outside the ranking suite |
| implementer | 2026-11-26T14-27-49-276Z | 4 | task outside the ranking suite |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  1. openai gpt-6.2-sol medium
  2. anthropic claude-opus-5-5 medium (no setting of this family passes the filters)
  fallback: mid, medium
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T07-24-16-693Z, implementer-2026-11-24T15-17-18-831Z, implementer-2026-11-24T23-57-38-543Z, implementer-2026-11-26T06-06-30-601Z, implementer-2026-11-26T06-08-53-448Z, implementer-2026-11-26T14-27-47-990Z
```

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: gpt-6.2-sol:high 267 scores)
Corpora: implementer (4 tasks of 14: its ranking suite)
Persona guidance: implementer 1dfb0b75 (45 cells), implementer 645ae0c6 (2 cells)
Filters: hidden-test pass % >= 0.0, followed false claims % <= 0.00. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | hidden-test pass % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|

Incomplete (cells to run next):
- claude-fable-5.2@low: implementer: 2 of 4 tasks
- claude-opus-5-5@medium: implementer: 1 of 4 tasks
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
| implementer | 2026-11-26T06-06-30-601Z | 54 | task outside the ranking suite |
| implementer | 2026-11-26T06-06-30-601Z | 24 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T06-08-53-448Z | 18 | task outside the ranking suite |
| implementer | 2026-11-26T06-08-53-448Z | 8 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T06-24-57-058Z | 8 | task outside the ranking suite |
| implementer | 2026-11-26T08-48-39-529Z | 6 | task outside the ranking suite |
| implementer | 2026-11-26T08-56-29-270Z | 4 | task outside the ranking suite |
| implementer | 2026-11-26T09-25-40-966Z | 2 | task outside the ranking suite |
| implementer | 2026-11-26T14-27-47-990Z | 20 | task outside the ranking suite |
| implementer | 2026-11-26T14-27-47-990Z | 7 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T14-27-49-276Z | 4 | task outside the ranking suite |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  fallback: none (no setting passes the filters)
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T15-17-18-831Z, implementer-2026-11-26T14-27-47-990Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. P: every hidden test passed. F(p/t): p of t hidden tests passed. T: the cell hit its time limit, a failed attempt. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it; it shows the latest grade that the records hold. (suite) marks a task of the ranking suite.

| Task | claude-fable-5.2@low | claude-opus-5-5@high | claude-opus-5-5@medium | claude-opus-5.5@high | claude-opus-5.5@medium | gemini-3.8-flash@low | gemini-4-hydrogen@high | gemini-4-neon@high | gemini-4-neon@medium | gpt-6-astra@low | gpt-6.1-sol@high | gpt-6.1-sol@medium | gpt-6.1-sol@xhigh | gpt-6.2-sol@high | gpt-6.2-sol@medium |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-14598 | - | F(175/176)* F(175/176)* F(175/176) F(175/176) | F(175/176) F(175/176) | - | - | - | P* P* P* | P* P* P* P P | P P | - | - | F(175/176) F(175/176) | - | P P | P P |
| ds1000-298 | - | F(0/1) F(0/1) | F(0/1) F(0/1) | - | - | - | P P P | P P P | P P | - | - | P P | - | F(0/1) P | P F(0/1) |
| getmoto__moto-7365 | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |
| hosted-thinking-row-wait (suite) | F(6/7) F(6/7) F(6/7) | F(6/7) P | P F(6/7) | P F(6/7) P | F(6/7) P F(6/7) | - | P F(1/7) | P P P | P P | P F(6/7) P | P P P | P P F(6/7) P P | P P P | P P | P P |
| httpx-streaming-json-iteration (suite) | P* P* F(0/1)* | F(0/1) F(0/1) | P F(0/1) | F(0/1)* F(0/1)* F(0/1)* | F(0/1)* F(0/1)* F(0/1)* | - | F(0/1) F(0/1) F(0/1) | F(0/1) F(0/1) F(0/1) | F(0/1) F(0/1) | P* P* P* | P* P* P* | P* P* P* P P | P* P* P* | P P | P P |
| jquense__yup-2305 | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |
| metrics-resteer | - | P P | P P | - | - | P P F(8/10) | P P P | P P P | P P | - | - | P P | - | P P | P P |
| psf__requests-6028 | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |
| recall-punctuated-words (suite) | P P P | P P | P P | P P P | P P P | - | P P P | P P P | P P | P P P | P P P | P P P F(22/23) P | P P P | P P | P P |
| redis__redis-10068 | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |
| regex-chess | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |
| rust-react | - | P* P* P P | P P | - | - | - | P* P* P | P* P* P P P | P P P P | - | - | P P P P | - | P P P P | P P P P |
| scheme-metacircular (suite) | P* P* P* | P P | T P | P* P* T | P* P* P* | - | P T P | P P P | P P | P* P* P* | T P* P* | P* P* P* P P | P* P* T | P P | P P |
| template-multiphase | - | P P | P P | - | - | - | P P P | P P P | P P | - | - | P P | - | P P | P P |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. A full pass reads the grade that the matrix shows.

| Setting | Cells | Full passes | Timed out | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 12 | 8 | 0 | 1 | $23.031 | 9355446 | 214s | claude_agent_sdk |
| claude-opus-5-5@high | 32 | 23 | 0 | 0 | $27.539 | 26062562 | 134s | claude_agent_sdk |
| claude-opus-5-5@medium | 28 | 21 | 1 | 0 | $16.935 | 18279174 | 105s | claude_agent_sdk |
| claude-opus-5.5@high | 12 | 7 | 1 | 0 | $25.386 | 31819674 | 455s | claude_agent_sdk |
| claude-opus-5.5@medium | 12 | 7 | 0 | 0 | $14.800 | 17272214 | 294s | claude_agent_sdk |
| gemini-3.8-flash@low | 3 | 2 | 0 | 0 | >= $1.078 (3 cells partly unpriced) | >= 1542085 | 106s | google_antigravity |
| gemini-4-hydrogen@high | 41 | 36 | 1 | 3 | >= $82.057 (28 cells partly unpriced) | >= 83815115 | 475s | google_antigravity |
| gemini-4-neon@high | 46 | 43 | 0 | 4 | >= $101.950 (28 cells partly unpriced) | >= 56750439 | 582s | google_antigravity |
| gemini-4-neon@medium | 30 | 28 | 0 | 3 | $21.954 | 25414941 | 374s | google_antigravity |
| gpt-6-astra@low | 12 | 11 | 0 | 1 | >= $20.617 (1 cell partly unpriced) | >= 11054620 | 234s | chatgpt |
| gpt-6.1-sol@high | 12 | 11 | 1 | 2 | >= $6.578 (1 cell partly unpriced) | >= 23571007 | 694s | chatgpt |
| gpt-6.1-sol@medium | 42 | 38 | 0 | 3 | $10.206 | 33161764 | 183s | chatgpt |
| gpt-6.1-sol@xhigh | 12 | 11 | 1 | 2 | >= $7.897 (2 cells partly unpriced) | >= 26450755 | 732s | chatgpt |
| gpt-6.2-sol@high | 30 | 29 | 0 | 2 | >= $11.582 (1 cell partly unpriced) | >= 32665996 | 316s | chatgpt |
| gpt-6.2-sol@medium | 30 | 29 | 0 | 2 | >= $8.454 (1 cell partly unpriced) | >= 26128798 | 240s | chatgpt |

## Coverage

Suite tasks that a setting has no current cell of:

- claude-fable-5.2@low: httpx-streaming-json-iteration, scheme-metacircular
- claude-opus-5.5@high: httpx-streaming-json-iteration
- claude-opus-5.5@medium: httpx-streaming-json-iteration, scheme-metacircular
- gemini-3.8-flash@low: hosted-thinking-row-wait, httpx-streaming-json-iteration, recall-punctuated-words, scheme-metacircular
- gpt-6-astra@low: httpx-streaming-json-iteration, scheme-metacircular
- gpt-6.1-sol@high: httpx-streaming-json-iteration
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
| 2026-11-26T06-06-30-601Z | gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 78 | 78 | 0 | 6 | 957887207bb6, f171aec4572e |
| 2026-11-26T06-08-53-448Z | gemini-4-neon@medium | gpt-6.2-sol:high | 26 | 26 | 0 | 3 | 957887207bb6, f171aec4572e |
| 2026-11-26T06-24-57-058Z | claude-opus-5-5@high, gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 8 | 8 | 0 | 0 | 78e2d7aa334a |
| 2026-11-26T08-48-39-529Z | gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 6 | 6 | 0 | 0 | 957887207bb6 |
| 2026-11-26T08-56-29-270Z | gemini-4-neon@medium | gpt-6.2-sol:high | 4 | 4 | 0 | 0 | 957887207bb6 |
| 2026-11-26T09-25-40-966Z | gemini-4-neon@high | gpt-6.2-sol:high | 2 | 2 | 0 | 0 | 957887207bb6 |
| 2026-11-26T14-27-47-990Z | claude-opus-5-5@medium | gpt-6.2-sol:high | 28 | 27 | 0 | 0 | 957887207bb6 |
| 2026-11-26T14-27-49-276Z | claude-opus-5-5@high, gemini-4-neon@high | gpt-6.2-sol:high | 4 | 4 | 0 | 2 | 957887207bb6 |
