# implementer benchmark results

This page is generated from the record files in `bench/ab-persona/records/implementer/` and the benchmark catalog (ARCH-DIRECTORIES-023). Do not edit it. Regenerate it with `bun run bench:tables`. Findings documents interpret these results and link this page.

Role: implementer. Mode: implement. Corpus: 14 tasks. Records: 18 campaigns, 426 cells, 23 failed attempts.

## Ranking

The ranking pools every current, scored cell of the role implementer, so it can include other personas of that role. It reads only absolute per-cell measures (ARCH-DIRECTORIES-021).

### Judged by gpt-6.2-sol:high

Judge: gpt-6.2-sol:high (other judges in these records: gpt-6.1-sol:xhigh 81 scores)
Corpora: implementer (14 tasks)
Persona guidance: implementer 1dfb0b75 (3 cells), implementer 645ae0c6 (322 cells)
Filters: core quality % >= 90.0, followed false claims % <= 20.00. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | core quality % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|
| gpt-6.2-sol@medium | openai | mid | 100.0 | 11.11 | >= $0.276 (1 of 57 cells partly unpriced) | 209s | 84.1 | pass | 57 |
| gpt-6.2-sol@high | openai | mid | 100.0 | 10.00 | >= $0.386 (1 of 30 cells partly unpriced) | 316s | 81.9 | pass | 30 |
| gpt-6.1-sol@medium | openai | mid | 97.4 | 15.00 | $0.193 | 168s | 80.0 | pass | 30 |
| gemini-4-neon@medium | other | unpriced | 99.8 | 10.00 | $0.733 | 374s | 78.2 | pass | 30 |
| claude-opus-5-5@medium | anthropic | powerful | 95.4 | 12.50 | $0.615 | 98s | 77.9 | pass | 56 (1 timed out) |
| gemini-4-neon@high | other | unpriced | 99.7 | 10.00 | >= $2.260 (26 of 45 cells partly unpriced) | 590s | 71.3 | pass | 45 |
| claude-opus-5-5@high | anthropic | powerful | 97.0 | 18.75 | $0.874 | 135s | 70.3 | pass | 31 |
| gemini-4-hydrogen@high | other | unpriced | 94.0 | 11.54 | >= $2.048 (26 of 40 cells partly unpriced) | 477s | 65.3 | pass | 40 (1 timed out) |

A lower-bound cost enters the score as its bound, which can only flatter that setting.

Incomplete (cells to run next):
- claude-opus-5.5@high: implementer: 1 of 14 tasks
- gemini-3.8-flash@low: implementer: 1 of 14 tasks
- gpt-6.1-sol@high: implementer: 1 of 14 tasks
- gpt-6.1-sol@xhigh: implementer: 1 of 14 tasks

Cells to retry (failed with no result; a resume runs them again):
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| implementer | 2026-11-13T21-16-42-634Z | 35 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |
| implementer | 2026-11-13T21-16-44-771Z | 46 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |
| implementer | 2026-11-24T07-24-16-693Z | 3 | task content changed |
| implementer | 2026-11-24T15-17-18-831Z | 3 | task content changed |
| implementer | 2026-11-24T15-17-18-831Z | 1 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |
| implementer | 2026-11-24T23-57-38-543Z | 2 | task content changed |
| implementer | 2026-11-26T06-06-30-601Z | 6 | task content changed |
| implementer | 2026-11-26T06-08-53-448Z | 2 | task content changed |
| implementer | 2026-11-26T14-27-47-990Z | 2 | task content changed |
| implementer | 2026-11-27T00-45-28-316Z | 1 | not scored by gpt-6.2-sol:high (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.2-sol:high`) |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  1. openai gpt-6.2-sol medium
  2. anthropic claude-opus-5-5 medium
  fallback: mid, high
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T07-13-03-614Z, implementer-2026-11-24T07-24-16-693Z, implementer-2026-11-24T14-59-24-385Z, implementer-2026-11-24T15-07-31-792Z, implementer-2026-11-24T15-17-18-831Z, implementer-2026-11-24T23-57-38-543Z, implementer-2026-11-26T06-06-30-601Z, implementer-2026-11-26T06-08-53-448Z, implementer-2026-11-26T06-24-57-058Z, implementer-2026-11-26T08-48-39-529Z, implementer-2026-11-26T08-56-29-270Z, implementer-2026-11-26T09-25-40-966Z, implementer-2026-11-26T14-27-47-990Z, implementer-2026-11-26T14-27-49-276Z, implementer-2026-11-26T20-31-14-559Z, implementer-2026-11-27T00-45-28-316Z
```

### Judged by gpt-6.1-sol:xhigh

Judge: gpt-6.1-sol:xhigh (other judges in these records: gpt-6.2-sol:high 338 scores)
Corpora: implementer (14 tasks)
Persona guidance: implementer 1dfb0b75 (84 cells), implementer 645ae0c6 (2 cells)
Filters: core quality % >= 0.0, followed false claims % <= 0.00. Score = quality - 1 x false - 3 log2(cost / cheapest) - 3 log2(latency / fastest), over passing settings.

| Setting | Family | Tier | core quality % | followed false claims % | Cost/cell | Median latency | Score | Filter | Cells |
|---|---|---|---:|---:|---:|---:|---:|---|---:|

Incomplete (cells to run next):
- claude-fable-5.2@low: implementer: 4 of 14 tasks
- claude-opus-5-5@medium: implementer: 1 of 14 tasks
- claude-opus-5.5@high: implementer: 4 of 14 tasks
- claude-opus-5.5@medium: implementer: 4 of 14 tasks
- gemini-4-hydrogen@high: implementer: 1 of 14 tasks
- gpt-6-astra@low: implementer: 4 of 14 tasks
- gpt-6.1-sol@high: implementer: 4 of 14 tasks
- gpt-6.1-sol@medium: implementer: 4 of 14 tasks
- gpt-6.1-sol@xhigh: implementer: 4 of 14 tasks

Cells to retry (failed with no result; a resume runs them again):
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).
- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (implementer 2026-11-24T23-57-38-543Z): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

Not pooled:

| Persona | Campaign | Cells | Reason |
|---|---|---:|---|
| implementer | 2026-11-24T07-13-03-614Z | 1 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T07-24-16-693Z | 39 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T07-24-16-693Z | 3 | task content changed |
| implementer | 2026-11-24T14-59-24-385Z | 1 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T15-07-31-792Z | 1 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T15-17-18-831Z | 38 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T15-17-18-831Z | 3 | task content changed |
| implementer | 2026-11-24T23-57-38-543Z | 25 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-24T23-57-38-543Z | 2 | task content changed |
| implementer | 2026-11-26T06-06-30-601Z | 6 | task content changed |
| implementer | 2026-11-26T06-06-30-601Z | 72 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T06-08-53-448Z | 2 | task content changed |
| implementer | 2026-11-26T06-08-53-448Z | 24 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T06-24-57-058Z | 8 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T08-48-39-529Z | 6 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T08-56-29-270Z | 4 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T09-25-40-966Z | 2 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T14-27-47-990Z | 25 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T14-27-47-990Z | 2 | task content changed |
| implementer | 2026-11-26T14-27-49-276Z | 4 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-26T20-31-14-559Z | 16 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |
| implementer | 2026-11-27T00-45-28-316Z | 56 | not scored by gpt-6.1-sol:xhigh (`bun bench/ab-persona/bench.ts --rejudge implementer --judge gpt-6.1-sol:xhigh`) |

Policy:

```
implementer (ROLE_MODEL_DEFAULTS entry: implementer)
  fallback: none (no setting passes the filters)
  evidence: implementer-2026-11-13T21-16-42-634Z, implementer-2026-11-13T21-16-44-771Z, implementer-2026-11-24T15-17-18-831Z, implementer-2026-11-26T14-27-47-990Z
```

## Cells by task and setting

Each cell lists every recorded repeat, oldest campaign first. Each setting has a core quality column and an edge column (ARCH-DIRECTORIES-024). Core quality p/t: p of the task's new core and serious checks passed, where t adds one failed check for each existing test that the change broke. Edge p/t: p of the task's t new edge checks passed; n/a: the task has no edge checks. (p/t): a grade before the check tags, p of all t hidden tests passed, with ? for its edge checks. T: the cell hit its time limit, a failed attempt. -: no recorded cell. A trailing * marks a cell whose task changed since it ran, so the ranking does not pool it; it shows the latest grade that the records hold.

| Task | claude-fable-5.2@low | claude-fable-5.2@low edge | claude-opus-5-5@high | claude-opus-5-5@high edge | claude-opus-5-5@medium | claude-opus-5-5@medium edge | claude-opus-5.5@high | claude-opus-5.5@high edge | claude-opus-5.5@medium | claude-opus-5.5@medium edge | gemini-3.8-flash@low | gemini-3.8-flash@low edge | gemini-4-hydrogen@high | gemini-4-hydrogen@high edge | gemini-4-neon@high | gemini-4-neon@high edge | gemini-4-neon@medium | gemini-4-neon@medium edge | gpt-6-astra@low | gpt-6-astra@low edge | gpt-6.1-sol@high | gpt-6.1-sol@high edge | gpt-6.1-sol@medium | gpt-6.1-sol@medium edge | gpt-6.1-sol@xhigh | gpt-6.1-sol@xhigh edge | gpt-6.2-sol@high | gpt-6.2-sol@high edge | gpt-6.2-sol@medium | gpt-6.2-sol@medium edge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy__astropy-14598 | - | - | 2/3 2/3 2/3 2/3 | n/a n/a n/a n/a | 2/3 2/3 2/3 2/3 | n/a n/a n/a n/a | - | - | - | - | - | - | 3/3 3/3 3/3 | n/a n/a n/a | 3/3 3/3 3/3 3/3 3/3 | n/a n/a n/a n/a n/a | 3/3 3/3 | n/a n/a | - | - | - | - | 2/3 2/3 | n/a n/a | - | - | 3/3 3/3 | n/a n/a | 3/3 3/3 3/3 3/3 | n/a n/a n/a n/a |
| ds1000-298 | - | - | (0/1)* (0/1)* 3/3 3/3 | ?* ?* n/a n/a | (0/1)* (0/1)* 3/3 3/3 3/3 3/3 | ?* ?* n/a n/a n/a n/a | - | - | - | - | - | - | (1/1)* (1/1)* (1/1)* 3/3 3/3 | ?* ?* ?* n/a n/a | (1/1)* (1/1)* (1/1)* 3/3 3/3 | ?* ?* ?* n/a n/a | (1/1)* (1/1)* 3/3 3/3 | ?* ?* n/a n/a | - | - | - | - | (1/1)* (1/1)* 3/3 3/3 | ?* ?* n/a n/a | - | - | (0/1)* (1/1)* 3/3 3/3 | ?* ?* n/a n/a | (1/1)* (0/1)* 3/3 3/3 3/3 3/3 | ?* ?* n/a n/a n/a n/a |
| getmoto__moto-7365 | - | - | 1/1 1/1 | n/a n/a | 1/1 1/1 1/1 1/1 | n/a n/a n/a n/a | - | - | - | - | - | - | 1/1 1/1 1/1 | n/a n/a n/a | 1/1 1/1 1/1 | n/a n/a n/a | 1/1 1/1 | n/a n/a | - | - | - | - | 1/1 1/1 | n/a n/a | - | - | 1/1 1/1 | n/a n/a | 1/1 1/1 1/1 1/1 | n/a n/a n/a n/a |
| hosted-thinking-row-wait | 6/7 6/7 6/7 | n/a n/a n/a | 6/7 7/7 | n/a n/a | 7/7 6/7 7/7 7/7 | n/a n/a n/a n/a | 7/7 6/7 7/7 | n/a n/a n/a | 6/7 7/7 6/7 | n/a n/a n/a | - | - | 7/7 0/7 | n/a n/a | 7/7 7/7 7/7 | n/a n/a n/a | 7/7 7/7 | n/a n/a | 7/7 6/7 7/7 | n/a n/a n/a | 7/7 7/7 7/7 | n/a n/a n/a | 7/7 7/7 6/7 7/7 7/7 | n/a n/a n/a n/a n/a | 7/7 7/7 7/7 | n/a n/a n/a | 7/7 7/7 | n/a n/a | 7/7 7/7 7/7 7/7 | n/a n/a n/a n/a |
| httpx-streaming-json-iteration | 88/88 88/88 87/88 | 20/20 20/20 20/20 | 87/88 86/88 | 20/20 20/20 | 88/88 84/88 86/88 87/88 | 20/20 20/20 20/20 20/20 | 86/88 87/88 87/88 | 20/20 20/20 20/20 | 87/88 86/88 87/88 | 20/20 20/20 20/20 | - | - | 86/88 87/88 88/88 | 20/20 20/20 20/20 | 83/88 86/88 84/88 | 20/20 20/20 20/20 | 85/88 85/88 | 20/20 20/20 | 88/88 88/88 88/88 | 20/20 20/20 20/20 | 88/88 88/88 88/88 | 20/20 20/20 20/20 | 88/88 88/88 88/88 88/88 88/88 | 20/20 20/20 20/20 20/20 20/20 | 88/88 88/88 88/88 | 20/20 20/20 20/20 | 88/88 88/88 | 20/20 20/20 | 88/88 88/88 88/88 88/88 | 20/20 20/20 20/20 20/20 |
| jquense__yup-2305 | - | - | 3/3 3/3 | n/a n/a | 3/3 3/3 3/3 3/3 | n/a n/a n/a n/a | - | - | - | - | - | - | 3/3 3/3 3/3 | n/a n/a n/a | 3/3 3/3 3/3 | n/a n/a n/a | 3/3 3/3 | n/a n/a | - | - | - | - | 3/3 3/3 | n/a n/a | - | - | 3/3 3/3 | n/a n/a | 3/3 3/3 3/3 3/3 | n/a n/a n/a n/a |
| metrics-resteer | - | - | 10/10 10/10 | n/a n/a | 10/10 10/10 10/10 10/10 | n/a n/a n/a n/a | - | - | - | - | 10/10 10/10 8/10 | n/a n/a n/a | 10/10 10/10 10/10 | n/a n/a n/a | 10/10 10/10 10/10 | n/a n/a n/a | 10/10 10/10 | n/a n/a | - | - | - | - | 10/10 10/10 | n/a n/a | - | - | 10/10 10/10 | n/a n/a | 10/10 10/10 10/10 10/10 | n/a n/a n/a n/a |
| psf__requests-6028 | - | - | 2/2 2/2 | n/a n/a | 2/2 2/2 2/2 2/2 | n/a n/a n/a n/a | - | - | - | - | - | - | 2/2 2/2 2/2 | n/a n/a n/a | 2/2 2/2 2/2 | n/a n/a n/a | 2/2 2/2 | n/a n/a | - | - | - | - | 2/2 2/2 | n/a n/a | - | - | 2/2 2/2 | n/a n/a | 2/2 2/2 2/2 2/2 | n/a n/a n/a n/a |
| recall-punctuated-words | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 | 8/8 8/8 | 15/15 15/15 15/15 15/15 | 8/8 8/8 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | - | - | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 | 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 15/15 14/15 15/15 | 8/8 8/8 8/8 8/8 8/8 | 15/15 15/15 15/15 | 8/8 8/8 8/8 | 15/15 15/15 | 8/8 8/8 | 15/15 15/15 15/15 15/15 | 8/8 8/8 8/8 8/8 |
| redis__redis-10068 | - | - | 1/1 1/1 | n/a n/a | 1/1 1/1 1/1 1/1 | n/a n/a n/a n/a | - | - | - | - | - | - | 1/1 1/1 1/1 | n/a n/a n/a | 1/1 1/1 1/1 | n/a n/a n/a | 1/1 1/1 | n/a n/a | - | - | - | - | 1/1 1/1 | n/a n/a | - | - | 1/1 1/1 | n/a n/a | 1/1 1/1 1/1 1/1 | n/a n/a n/a n/a |
| regex-chess | - | - | 103/103 103/103 | 1/1 1/1 | 103/103 103/103 103/103 103/103 | 1/1 1/1 1/1 1/1 | - | - | - | - | - | - | 103/103 103/103 103/103 | 1/1 1/1 1/1 | 103/103 103/103 103/103 | 1/1 1/1 1/1 | 103/103 103/103 | 1/1 1/1 | - | - | - | - | 103/103 103/103 | 1/1 1/1 | - | - | 103/103 103/103 | 1/1 1/1 | 103/103 103/103 103/103 103/103 | 1/1 1/1 1/1 1/1 |
| rust-react | - | - | 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 | 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 | - | - | - | - | - | - | 15/15 15/15 15/15 | 5/5 5/5 5/5 | 15/15 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 5/5 | 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 | - | - | - | - | 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 | - | - | 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 | 15/15 15/15 15/15 15/15 15/15 15/15 | 5/5 5/5 5/5 5/5 5/5 5/5 |
| scheme-metacircular | 63/63 63/63 63/63 | n/a n/a n/a | 63/63 63/63 | n/a n/a | T 63/63 63/63 63/63 | T n/a n/a n/a | 63/63 63/63 T | n/a n/a T | 63/63 63/63 63/63 | n/a n/a n/a | - | - | 63/63 T 63/63 | n/a T n/a | 63/63 63/63 63/63 | n/a n/a n/a | 63/63 63/63 | n/a n/a | 63/63 63/63 63/63 | n/a n/a n/a | T 63/63 63/63 | T n/a n/a | 63/63 63/63 63/63 63/63 63/63 | n/a n/a n/a n/a n/a | 63/63 63/63 T | n/a n/a T | 63/63 63/63 | n/a n/a | 63/63 63/63 63/63 63/63 | n/a n/a n/a n/a |
| template-multiphase | - | - | 25/25 25/25 | 5/5 5/5 | 25/25 25/25 25/25 25/25 | 5/5 5/5 5/5 5/5 | - | - | - | - | - | - | 25/25 25/25 25/25 | 5/5 5/5 5/5 | 25/25 25/25 25/25 | 5/5 5/5 5/5 | 25/25 25/25 | 5/5 5/5 | - | - | - | - | 25/25 25/25 | 5/5 5/5 | - | - | 25/25 25/25 | 5/5 5/5 | 25/25 25/25 25/25 25/25 | 5/5 5/5 5/5 5/5 |

## Totals by setting

Totals cover every recorded cell, current or not. Estimated USD is the sum over the setting's cells; ">=" marks a lower bound, because some cell has no complete price or usage. Failed attempts settled with no result. Core quality is the mean over the cells that show a check grade or timed out (0), and Edge is the share of edge checks passed over the cells that show a check grade; both read the grade that the matrix shows, and the ranking instead weighs each task the same.

| Setting | Cells | Core quality % | Edge % | Timed out | Failed attempts | Estimated USD | Tokens | Median latency | Providers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| claude-fable-5.2@low | 12 | 96.3 | 100.0 | 0 | 1 | $23.031 | 9355446 | 214s | claude_agent_sdk |
| claude-opus-5-5@high | 34 | 95.3 | 100.0 | 0 | 0 | $27.787 | 26136241 | 132s | claude_agent_sdk |
| claude-opus-5-5@medium | 58 | 95.4 | 100.0 | 1 | 0 | $34.568 | 34269369 | 96s | claude_agent_sdk |
| claude-opus-5.5@high | 12 | 90.1 | 100.0 | 1 | 0 | $25.386 | 31819674 | 455s | claude_agent_sdk |
| claude-opus-5.5@medium | 12 | 97.2 | 100.0 | 0 | 0 | $14.800 | 17272214 | 294s | claude_agent_sdk |
| gemini-3.8-flash@low | 3 | 93.3 | n/a | 0 | 0 | >= $1.078 (3 cells partly unpriced) | >= 1542085 | 106s | google_antigravity |
| gemini-4-hydrogen@high | 43 | 94.9 | 100.0 | 1 | 3 | >= $82.262 (28 cells partly unpriced) | >= 84118819 | 460s | google_antigravity |
| gemini-4-neon@high | 48 | 99.7 | 100.0 | 0 | 4 | >= $102.408 (28 cells partly unpriced) | >= 57057843 | 573s | google_antigravity |
| gemini-4-neon@medium | 32 | 99.8 | 100.0 | 0 | 3 | $22.245 | 25607444 | 330s | google_antigravity |
| gpt-6-astra@low | 12 | 98.8 | 100.0 | 0 | 1 | >= $20.617 (1 cell partly unpriced) | >= 11054620 | 234s | chatgpt |
| gpt-6.1-sol@high | 12 | 91.7 | 100.0 | 1 | 2 | >= $6.578 (1 cell partly unpriced) | >= 23571007 | 694s | chatgpt |
| gpt-6.1-sol@medium | 44 | 97.9 | 100.0 | 0 | 3 | $10.290 | 33321041 | 178s | chatgpt |
| gpt-6.1-sol@xhigh | 12 | 91.7 | 100.0 | 1 | 2 | >= $7.897 (2 cells partly unpriced) | >= 26450755 | 732s | chatgpt |
| gpt-6.2-sol@high | 32 | 100.0 | 100.0 | 0 | 2 | >= $11.731 (1 cell partly unpriced) | >= 32931894 | 312s | chatgpt |
| gpt-6.2-sol@medium | 60 | 100.0 | 100.0 | 0 | 2 | >= $16.323 (1 cell partly unpriced) | >= 47516932 | 208s | chatgpt |

## Coverage

Corpus tasks that a setting has no current cell of:

- claude-fable-5.2@low: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase
- claude-opus-5.5@high: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase
- claude-opus-5.5@medium: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase
- gemini-3.8-flash@low: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, hosted-thinking-row-wait, httpx-streaming-json-iteration, jquense__yup-2305, psf__requests-6028, recall-punctuated-words, redis__redis-10068, regex-chess, rust-react, scheme-metacircular, template-multiphase
- gpt-6-astra@low: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase
- gpt-6.1-sol@high: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase
- gpt-6.1-sol@xhigh: astropy__astropy-14598, ds1000-298, getmoto__moto-7365, jquense__yup-2305, metrics-resteer, psf__requests-6028, redis__redis-10068, regex-chess, rust-react, template-multiphase

Cells to retry (every attempt failed with no result; a resume runs them again):

- gemini-4-hydrogen@high hosted-thinking-row-wait #0 (2026-11-24T23-57-38-543Z), 3 failed attempts: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).

The ranking above lists each record that it does not pool, with the reason.

## Campaigns

| Campaign | Settings | Judge | Cells | Scores | Grades | Failed attempts | Sources |
|---|---|---|---:|---:|---:|---:|---|
| 2026-11-13T21-16-42-634Z | claude-fable-5.2@low, claude-opus-5.5@high, claude-opus-5.5@medium | gpt-6.1-sol:xhigh | 36 | 35 | 59 | 1 | not recorded |
| 2026-11-13T21-16-44-771Z | gpt-6-astra@low, gpt-6.1-sol@high, gpt-6.1-sol@medium, gpt-6.1-sol@xhigh | gpt-6.1-sol:xhigh | 48 | 46 | 76 | 6 | not recorded |
| 2026-11-24T07-13-03-614Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 1 | 0 | 09680054133f |
| 2026-11-24T07-24-16-693Z | claude-opus-5-5@high, gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 42 | 42 | 42 | 0 | ee74385de2bd |
| 2026-11-24T14-59-24-385Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 1 | 0 | 1b7e3eb81399 |
| 2026-11-24T15-07-31-792Z | gemini-3.8-flash@low | gpt-6.2-sol:high | 1 | 1 | 1 | 0 | 1f146dfe1b5f |
| 2026-11-24T15-17-18-831Z | claude-opus-5-5@high, gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 42 | 40 | 41 | 2 | 1f146dfe1b5f, b6d307b80714 |
| 2026-11-24T23-57-38-543Z | gemini-4-hydrogen@high, gemini-4-neon@high | gpt-6.2-sol:high | 27 | 27 | 27 | 3 | b718866b40ff |
| 2026-11-26T06-06-30-601Z | gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 78 | 78 | 72 | 6 | 957887207bb6, f171aec4572e |
| 2026-11-26T06-08-53-448Z | gemini-4-neon@medium | gpt-6.2-sol:high | 26 | 26 | 24 | 3 | 957887207bb6, f171aec4572e |
| 2026-11-26T06-24-57-058Z | claude-opus-5-5@high, gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 8 | 8 | 16 | 0 | 78e2d7aa334a |
| 2026-11-26T08-48-39-529Z | gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 6 | 6 | 6 | 0 | 957887207bb6 |
| 2026-11-26T08-56-29-270Z | gemini-4-neon@medium | gpt-6.2-sol:high | 4 | 4 | 6 | 0 | 957887207bb6 |
| 2026-11-26T09-25-40-966Z | gemini-4-neon@high | gpt-6.2-sol:high | 2 | 2 | 4 | 0 | 957887207bb6 |
| 2026-11-26T14-27-47-990Z | claude-opus-5-5@medium | gpt-6.2-sol:high | 28 | 27 | 27 | 0 | 957887207bb6 |
| 2026-11-26T14-27-49-276Z | claude-opus-5-5@high, gemini-4-neon@high | gpt-6.2-sol:high | 4 | 4 | 4 | 2 | 957887207bb6 |
| 2026-11-26T20-31-14-559Z | claude-opus-5-5@high, claude-opus-5-5@medium, gemini-4-hydrogen@high, gemini-4-neon@high, gemini-4-neon@medium, gpt-6.1-sol@medium, gpt-6.2-sol@high, gpt-6.2-sol@medium | gpt-6.2-sol:high | 16 | 16 | 0 | 0 | 68c52ac076a0 |
| 2026-11-27T00-45-28-316Z | claude-opus-5-5@medium, gpt-6.2-sol@medium | gpt-6.2-sol:high | 56 | 55 | 0 | 0 | 712ee6f65754 |
