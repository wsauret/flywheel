# E2E Benchmark Report — Sprint Mode (Option 5)

**Date:** 2026-03-27
**Mode:** Sprint (option 5)
**HITL:** All automatic (no manual consolidation)
**Approval gates:** Skipped (FLYWHEEL_SKIP_APPROVAL_GATES=true)
**Engine:** Claude (default)
**Branch:** feat/flywheel-cli-engine

## Results

| Prompt | Total Runtime (s) | Quality Score (1-5) | Steps | Notes |
|--------|-------------------|---------------------|-------|-------|
| add a hello world endpoint | 143 (2m 23s) | 4 | 2 (work + verify) | Simplified existing /hello response from `{ greeting, timestamp }` to `{ message: "Hello, World!" }`; updated tests; 3/3 tests pass, 10 assertions |
| add a health check endpoint that returns uptime | 200 (3m 20s) | 4 | 2 (work + verify) | Added GET /health returning `{ status: "ok", uptime: <seconds> }`; module-level startedAt for uptime; method guard (405); 2 new tests; 4,372 total tests pass |
| add a YAML config file parser | 292 (4m 52s) | 4 | 2 (work + verify) | Added js-yaml loader with error handling (missing files, invalid YAML, empty files, array roots); extended CONFIG_FILES with 4 YAML variants; TOML precedence preserved; 12 new tests; 4,382 total tests pass; updated AGENTS.md docs |

## Summary Statistics

- **Mean runtime:** 212s (3m 32s)
- **Median runtime:** 200s (3m 20s)
- **Min runtime:** 143s (2m 23s)
- **Max runtime:** 292s (4m 52s)
- **All runs:** 0 errors, 0 crashes, 0 log warnings

## Quality Assessment Methodology

Each run is scored 1-5 based on:
- **Correctness:** Does the implementation work as described?
- **Test coverage:** Are there meaningful tests?
- **Code quality:** Clean, idiomatic TypeScript?
- **Verification:** Did the verify step thoroughly check the implementation?

All 3 runs scored 4/5: implementations were correct with tests, and the verify step provided thorough checks (test execution, type checking, regression analysis). No run scored 5 because the implementations focused narrowly on the prompt without broader architectural considerations.

## Step-Level Timing Breakdown

| Prompt | Sprint Work (s) | Verify Changes (s) |
|--------|-----------------|---------------------|
| hello world endpoint | 71 | 72 |
| health check endpoint | 85 | 115 |
| YAML config parser | 158 | 134 |

## Sprint vs Full Mode Comparison

| Prompt | Sprint (s) | Full Mode (s) | Speedup |
|--------|-----------|---------------|---------|
| hello world endpoint | 143 | 1254 | 8.8× |
| health check endpoint | 200 | 1004 | 5.0× |
| YAML config parser | 292 | 1667 | 5.7× |
| **Mean** | **212** | **1308** | **6.2×** |

Sprint mode is ~6× faster than Plan + Work + Review mode because it skips the plan phase (4 steps: research, draft, review, consolidate), the review phase (3 steps: multi-agent review, consolidation, implement fixes), and dynamic step insertion. Sprint runs only 2 steps (work + verify) vs 11-12 steps in full mode.

## Observations

1. **Sprint mode completes in 2-5 minutes** — significantly faster than full mode (17-28 minutes)
2. **Work step takes 50-55% of total time** on average — the verify step is comparable
3. **Task complexity scales linearly** — YAML parser (most complex) took ~2× longer than hello world (simplest)
4. **Zero errors across all runs** — the sprint pipeline is stable and reliable
5. **Quality is consistent at 4/5** — sprint produces correct, tested implementations despite no review cycle
6. **Verify step is thorough** — runs tests, type checks, and performs regression analysis in all cases
7. **No sprint iterations triggered** — all 3 tasks were completed in Sprint 1/5 (first iteration), suggesting the verify step passed on first attempt
