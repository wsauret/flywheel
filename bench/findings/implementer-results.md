# Implementer persona implementation benchmark results

## Cost-first rerun: 2026-08-20

Three runs after the luna provider optimizations, all on the 2026-08-08 task set:

1. `implementer-2026-08-20T16-49-17-288Z`: luna/max solo, cross-judged against every 2026-08-08 seat with `compare.ts` (which gained same-variant cross-run support for this). New luna/max beat old luna/max 2-1 at 40% lower cost and one fifth the tokens.
2. `implementer-2026-08-20T17-41-49-838Z`: luna/max with a temporary hardcoded OpenAI `speed: "fast"` probe: 53/53 acceptance, ~23% lower latency, ~2.7x cost (2x fast-tier multiplier plus more tokens). Not adopted; the hardcode was reverted.
3. `implementer-2026-08-20T18-04-05-701Z`: the deciding 4-seat round-robin, 2 repeats, 18 blinded verdicts per seat:

| Variant | Acceptance | Quality W-L-T | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|
| sol/low | 104/106 (98.1%) | 15-3-0 | $0.794 | 98s |
| terra/xhigh | 90/93 (96.8%) | 9-9-0 | $0.715 | 234s |
| luna/xhigh | 105/106 (99.1%) | 6-12-0 | $0.108 | 258s |
| luna/max | 97/100 (97.0%) | 6-12-0 | $0.123 | 349s |

Findings: sol/low is now the outright quality leader; its wins are substantive (preserving `computePercentiles` correctness for unsorted input, keeping the provider-chain head-identity contract). terra/xhigh's 2026-08-08 dominance (17-4) did not replicate (9-9; one repeat shipped a non-compiling `reader.ts`). luna/xhigh strictly dominates luna/max: better acceptance (best on the board), same quality record, cheaper, faster. Both luna seats repeated one public-contract mistake (moving the numeric sort out of `computePercentiles` into its sole caller) and shed further verdicts on diff economy; luna/max also shipped one non-compiling diff. The luna loss modes are largely catchable by a typecheck gate plus a review pass, which is what makes the cost-first default viable.

Decision (2026-08-20): the `implementer` seat moves to gpt-5.6-luna xhigh as a cost-first default (99.1% acceptance at about a seventh of sol/low's cost). gpt-5.6-sol low remains the quality leader and the swap-back choice when diff quality outranks cost. claude-sonnet-5/high stays the Anthropic fallback.

## Replacement matrix: 2026-08-08

Run: `implementer-2026-08-08T04-50-28-280Z`. Eight variants ran once across `metrics-resteer`, `provider-chain-fix`, and `template-multiphase`. The run contains 24 successful cells, 84 successful blinded pairwise comparisons, 24 trap records, zero failed judge calls, and zero unsuccessful cell attempts.

| Variant | Acceptance | Trap self-corrected / blind / lucky | Quality W-L-T | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|---:|
| gpt-5.6-sol/low | 53/53 (100.0%) | 4 / 0 / 2 | 12-9-0 | $0.716 | 117s |
| gpt-5.6-terra/high | 53/53 (100.0%) | 4 / 0 / 2 | 11-10-0 | $0.593 | 264s |
| claude-sonnet-5/high | 53/53 (100.0%) | 5 / 0 / 1 | 10-11-0 | $2.035 | 599s |
| claude-opus-5/low | 53/53 (100.0%) | 5 / 0 / 1 | 10-11-0 | $3.627 | 500s |
| gpt-5.6-terra/xhigh | 51/53 (96.2%) | 4 / 0 / 2 | 17-4-0 | $1.161 | 424s |
| gpt-5.6-luna/max | 51/53 (96.2%) | 3 / 1 / 2 | 9-12-0 | $0.196 | 484s |
| claude-opus-4-6/medium | 50/53 (94.3%) | 3 / 1 / 2 | 4-17-0 | $2.257 | 344s |
| gpt-5.6-terra/max | 49/53 (92.5%) | 4 / 1 / 1 | 11-10-0 | $1.366 | 376s |

Candidate runs cost $35.853 and consumed 1,844,966 tokens. The 100 completed judge calls cost a separate $9.022 and consumed 65,142 tokens. Every judge call reported observed accounting and used `openai_api`.

### Findings

1. `gpt-5.6-sol/low` is the best cheaper replacement candidate for the implementer seat. It reached perfect acceptance, followed no trap blindly, led the complete-correctness variants in round-robin quality, and was the fastest complete-correctness variant. It beat `gpt-5.6-terra/high` on `metrics-resteer` and `template-multiphase`, losing only `provider-chain-fix`.

2. `gpt-5.6-terra/high` is the cost-first alternative. It matched Sol on acceptance and trap outcomes at 17% lower candidate cost, but averaged 2.25 times Sol's latency and lost the direct quality comparison 1-2.

3. `claude-opus-5/low` preserved the strongest trap disclosure profile and beat Sol directly on two of three tasks. It did not justify its operating cost as the cheaper replacement: it averaged 5.1 times Sol's cost and 4.3 times its latency, while its full round-robin record was 10-11 against Sol's 12-9.

4. `gpt-5.6-terra/xhigh` had the strongest blind quality record, 17-4, but failed two hidden acceptance outcomes on the production-scale fixture. Correctness-first selection excludes it.

5. `claude-sonnet-5/high` matched perfect acceptance and strong trap handling, but it was the slowest variant and lost the round robin 10-11. It offers no cost or latency case over Sol.

6. Luna/max, Terra/max, and Opus-4-6/medium all missed acceptance outcomes and followed one trap blindly. Their lower cost or isolated quality wins do not compensate for correctness failures in this seat.

### Recommendation

Adopted 2026-08-08: `gpt-5.6-sol` at low effort is the primary implementer default, displacing `claude-opus-5` at medium. `claude-sonnet-5` at high effort is the Anthropic fallback; it matched `claude-opus-5@low` on acceptance (53/53), trap outcomes (5/0/1), and quality record (10-11) at 44% lower cost, with latency as Opus's only edge. `gpt-5.6-terra` at high effort remains the cost-first OpenAI alternative.

### Caveats

This matrix has one repeat per cell, so rankings are directional. Some cells persisted before the benchmark turn-budget prompt fix and may have received `at most undefined turns`; the run was resumed rather than restarted by explicit decision. The matrix tested Opus-5/low, not the deployed Opus-5/medium default, so the new evidence compares cheaper alternatives against the current family rather than directly re-running the exact default. Pairwise quality and trap classification are judge opinions on captured diffs and handoffs; acceptance is executable hidden-test evidence.

## Prior baseline: 2026-07-24

Date: 2026-07-24. Persona: implementer. Valid runs: `implementer-2026-07-24T01-27-23-623Z` (six-variant matrix, completed via `--resume` after 5 crashed cells were pruned, see Scoring notes), `implementer-2026-07-24T18-05-46-220Z` (opus-4-8/medium solo), and `implementer-2026-07-24T21-34-39-666Z` (opus-5/medium solo, day-of-release); both solos cross-judged against the six-variant run with `compare.ts`. Variants: sol/medium, sol/high, terra/medium, terra/high, opus-4-8/high, opus-4-8/medium, opus-5/medium, fable-5/low. 2 repeats x 2 fixtures per variant.

## Setup

Two implementation fixtures in `fixtures/implement/` (removed; see git history), run in isolated git sandboxes with hidden acceptance suites copied in only after the diff is captured:

1. `template-engine` (control, no traps): complete a nested template renderer from a strict TypeScript skeleton and a truthful ordered plan. 27 hidden acceptance tests. Measures greenfield execution.
2. `metrics-pipeline` (trapped refactor): refactor a callback-based metrics pipeline to a pull-based reader, following a plan that is deliberately wrong on 5 points: a stale symbol (`flushWindow` vs the shipped `drainWindow`), a false invariant (claims percentile inputs arrive sorted; visible tests prove out-of-order input), a dead-code lie (claims `normalizeUnit` is unused; it is live in the report path), a signature conflict (`createReader` shape contradicts the shipped call site), and a unit error (retention given in seconds against millisecond timestamps). 14 hidden acceptance tests. Measures whether the model verifies the plan against the code or follows it blindly.

Scoring: acceptance is hidden Bun test passes over total outcomes (a broken build counts as one failed outcome). A trap judge (sol) classifies each trap per run as self-corrected, followed blindly, silently lucky, or unclear, from the diff plus final handoff against manifest catch criteria. Quality is randomized blinded pairwise diff judging (sol) with an anti-bloat rubric covering correctness, code quality, architecture, and elegance; seeded traps are disclosed to the quality judge.

## Results (totals, 4 runs per variant, 82 acceptance opportunities)

| Variant | Acceptance | Self-corrected | Followed blindly | Quality W-L-T | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|---:|---:|
| opus-5/medium | 100.0% | 8 | 0 | 4-0-0 vs fable-5/low | $0.47 | 95s |
| opus-4-8/medium | 90.2% | 6 | 2 | 2-2-0 vs fable-5/low | $0.54 | 124s |
| opus-4-8/high | 89.0% | 6 | 2 | 10-10-0 | $0.57 | 138s |
| fable-5/low | 87.8% | 5 | 3 | 11-9-0 | $0.57 | 51s |
| terra/high | 80.5% | 2 | 4 | 9-11-0 | $0.18 | 60s |
| terra/medium | 76.8% | 0 | 7 | 9-11-0 | $0.15 | 44s |
| sol/high | 76.8% | 1 | 5 | 11-9-0 | $0.36 | 112s |
| sol/medium | 75.6% | 3 | 6 | 10-10-0 | $0.31 | 82s |

opus-4-8/medium and opus-5/medium ran solo after the six-variant matrix; their quality columns are `compare.ts` cross-run head-to-heads against fable-5/low only (in-matrix W-L-T is not comparable to the round-robin numbers above them). opus-5/medium's remaining 2 trap outcomes were silently-lucky.

Per fixture, the split is stark:

| Fixture | Variant | Acceptance | Quality W-L-T |
|---|---|---:|---:|
| metrics-pipeline (trapped refactor) | opus-4-8/high | 19/28 (67.9%) | 10-0-0 |
| metrics-pipeline | opus-5/medium | 28/28 (100%) | 2-0-0 vs fable-5/low |
| metrics-pipeline | fable-5/low | 18/28 (64.3%) | 8-2-0 |
| metrics-pipeline | terra/high | 12/28 (42.9%) | 6-4-0 |
| metrics-pipeline | sol/high | 9/28 (32.1%) | 3-7-0 |
| metrics-pipeline | terra/medium | 9/28 (32.1%) | 1-9-0 |
| metrics-pipeline | sol/medium | 8/28 (28.6%) | 2-8-0 |
| template-engine (greenfield) | all six variants | 54/54 (100%) | sol/medium 8-2, sol/high 8-2, terra/medium 8-2, terra/high 3-7, fable-5/low 3-7, opus-4-8/high 0-10 |

## Conclusions

1. Greenfield does not discriminate: every variant passed all 27 hidden tests on the truthful plan. A straightforward plan is not a useful implementer benchmark.
2. The trapped refactor separates the field exactly along the hypothesis: Claude variants self-correct against misleading plans (opus 6 self-corrected / 2 followed blindly; fable 5/3) while every GPT variant mostly follows the plan into the traps (terra/medium worst at 0/7). Acceptance follows: 64-68% for the Claudes vs 29-43% for the GPTs.
3. opus-4-8/high is the strongest refactor implementer (highest acceptance, best trap discipline, 10-0 blind quality on the trapped fixture) but the weakest greenfield designer in this cohort (0-10 quality; judges repeatedly flagged eager block-body rendering and permissive tag casting) and the slowest (138s avg).
4. fable-5/low is the balance point: within noise of opus on acceptance and traps, 2.7x faster, same cost per run. Its token counts are tiny (4k avg) but fable pricing ($10/$50 per M) makes the dollars match opus.
5. Among GPT variants, terra/high dominates: better acceptance and trap handling than either sol effort at half the cost and ~half the latency. sol buys nothing over terra as an implementer on these fixtures. Raising terra effort medium -> high moves trap discipline from 0/7 to 2/4 for $0.03 per run.
6. The cost hierarchy inverts the quality hierarchy: terra/high is 3x cheaper than the Claudes but follows misleading plans. Which end to sit on depends on how much a wrong implementation costs downstream (review + rework), which this benchmark does not measure.
7. opus-4-8/medium vs fable-5/low is a tie on everything except latency: acceptance within one test (74/82 vs 72/82), traps 6/2/2 vs 5/3/2, cross-run blind quality 2-2-0 with real defects on both sides (opus broke retention units in one metrics repeat; fable kept its unterminated-tag tokenizer loop in one template repeat), measured cost equal ($0.54 vs $0.57; fable's 2x per-token price is offset by 2.3x fewer tokens). fable is 2.4x faster, and implementer latency is on the critical path of every workflow phase. Lowering opus effort high -> medium changed nothing measurable in this seat.
8. Seat asymmetry, cross-referenced with ab-steps: opus-4-8/medium is trap-perfect as the implement ORCHESTRATOR (8/8 self-corrected over fable/low executors) yet follows 2 traps blindly as the hands-on executor. Orchestrating verification gates and executing under them are different competencies; benchmark them separately.
9. opus-5/medium (released 2026-07-24, same $5/$25 pricing as opus-4-8) is the first variant to clear the trapped refactor completely: 28/28 acceptance, 8 of 10 traps self-corrected and the other 2 silently-lucky, none followed blindly. It swept the cross-run blind quality judging against fable-5/low 4-0 (both fixtures, both repeats) at lower cost ($0.47 vs $0.57). fable's only remaining edge is latency (51s vs 95s). The opus-4-8 executor weakness (conclusion 8) does not carry into opus-5.

## Decision

Global `implementer` role: claude-opus-5 medium displaces fable-5/low as the preferred candidate; gpt-5.6-terra high stays as the OpenAI candidate. opus-5/medium dominates fable/low on acceptance (100% vs 87.8%), trap discipline (8/0 vs 5/3), blind quality (4-0), and cost ($0.47 vs $0.57); fable keeps only a 1.9x latency edge, and the standing rule from the fable decision is that trap discipline outranks speed and cost in this seat. `step-worker` stays provisional (orchestration-shaped fixtures still needed); the implementer data is the nearest proxy.

## Caveats

Two repeats per cell; two fixtures; single judge model (sol, blind to variant identity). Greenfield quality verdicts and trap classifications are judge opinions on diffs, not executions. The kept metrics-pipeline cells (sol both efforts, terra/medium, terra/high repeat 1) ran against a slightly older plan.md wording than the 5 resumed cells: the resume added an explicit `MetricsStore` class pin after ambiguity crashed the original cells (see Scoring notes). All variants faced the same traps either way.

## Scoring notes

- `implementer-2026-07-24T00-28-25-213Z` is INVALID: the acceptance suite at that time imported a `RETENTION_MS` constant the plan never pinned, so metrics acceptance crashed at module load for all variants, and diffs were polluted by `.flywheel/agent-outputs/` telemetry before the sandbox gitignore fix. Treat it as historical only.
- `implementer-2026-07-24T00-26-33-262Z` (luna/low solo) was a harness smoke test, not a measurement.
- Earlier `implementer-2026-07-23T*` directories are partial runs killed to consolidate variants into one round-robin, plus one crash at judge-model resolution before the judge was pinned to sol/openai_api. None contain scoreable full matrices.
- In the valid run, 5 metrics-pipeline cells (terra/high repeat 0, opus both repeats, fable both repeats) initially scored 0 acceptance because the agents shipped a `createMetricsStore()` factory while the acceptance suite imports a `MetricsStore` class; plan.md step 1 was ambiguous about the export shape. The plan was pinned, the 5 runs and all metrics-pipeline scores were pruned from `runs.jsonl`/`scores.jsonl`, and `--resume` re-ran only those cells and re-judged the fixture. Template-engine runs and verdicts were reused unchanged.
