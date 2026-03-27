# Flywheel CLI — E2E Pipeline Benchmark Report

**Date:** 2026-03-27
**Branch:** feat/flywheel-cli-engine
**Engine:** Claude (default)
**Approval gates:** Skipped (FLYWHEEL_SKIP_APPROVAL_GATES=true)
**HITL:** All automatic (no manual consolidation, no manual review triage)

---

## Combined Results

| Prompt | Mode | Total Runtime (s) | Quality Score (1-5) | Notes |
|--------|------|-------------------|---------------------|-------|
| add a hello world endpoint | Plan+Work+Review | 1254 (20m 54s) | 4 | 12 steps (7→12); 5 review fixes applied (port logging, signal handlers, 405 Allow header, test cleanup, hostname binding) |
| add a health check endpoint that returns uptime | Plan+Work+Review | 1004 (16m 44s) | 4 | 11 steps (7→11); 4 review fixes applied (startTime scope, await stop, port docs, redundant header) |
| add a YAML config file parser | Plan+Work+Review | 1667 (27m 47s) | 4 | 12 steps (7→12); 5 review fixes applied (JSDoc, error messages, extension guard, dotfiles, AGENTS.md) |
| add a hello world endpoint | Sprint | 143 (2m 23s) | 4 | 2 steps (work + verify); simplified endpoint with tests; 10 assertions |
| add a health check endpoint that returns uptime | Sprint | 200 (3m 20s) | 4 | 2 steps (work + verify); uptime tracking + method guard; 2 new tests |
| add a YAML config file parser | Sprint | 292 (4m 52s) | 4 | 2 steps (work + verify); js-yaml loader with error handling; 12 new tests |

---

## Summary of Latency Patterns

### Aggregate Statistics

| Metric | Plan+Work+Review | Sprint |
|--------|------------------|--------|
| Mean runtime | 1308s (21m 48s) | 212s (3m 32s) |
| Median runtime | 1254s (20m 54s) | 200s (3m 20s) |
| Min runtime | 1004s (16m 44s) | 143s (2m 23s) |
| Max runtime | 1667s (27m 47s) | 292s (4m 52s) |
| Mean speedup | — | **6.2× faster** |

### Per-Prompt Speedup (Sprint vs Full Mode)

| Prompt | Sprint (s) | Full Mode (s) | Speedup |
|--------|-----------|---------------|---------|
| hello world endpoint | 143 | 1254 | 8.8× |
| health check endpoint | 200 | 1004 | 5.0× |
| YAML config parser | 292 | 1667 | 5.7× |

### Key Latency Patterns

1. **Task complexity is the dominant variable.** Across both modes, the YAML config parser (most complex) consistently took ~2× longer than the hello world endpoint (simplest). This held for both Sprint (143s → 292s) and Full mode (1004s → 1667s).

2. **Plan phase is the largest latency contributor in full mode.** The 4-step plan phase (research, draft, review, consolidate) consumes ~6–9 minutes, roughly 40–50% of total full-mode runtime. Skipping it is why Sprint achieves its 5–9× speedup.

3. **Review phase adds 4–8 minutes.** The 3 review steps (multi-agent review, consolidation, implement fixes) add meaningful latency but also meaningful quality improvement through iterative refinement.

4. **Sprint work ≈ 50% of sprint runtime.** In Sprint mode, the work step and verify step each consume roughly half the total time (e.g., 71s work + 72s verify for hello world).

5. **Dynamic step insertion increases step count by 57–71%.** Full mode starts with 7 static steps and grows to 11–12 after plan consolidation inserts 4–5 work steps. This is expected behavior — the plan phase determines the work to do.

6. **Zero errors across all 6 runs.** Both modes completed with no crashes, no log errors, and no log warnings. The pipeline is stable and reliable.

---

## Quality Assessment Methodology

Each run was scored on a 1–5 scale by semantically evaluating the produced artifacts across four dimensions:

| Dimension | Weight | What We Checked |
|-----------|--------|-----------------|
| **Correctness** | High | Does the implementation work as described? Are endpoints reachable? Do parsers handle edge cases? |
| **Test coverage** | High | Are there meaningful unit/integration tests? Do they cover happy paths and error cases? |
| **Code quality** | Medium | Is the code clean, idiomatic TypeScript? Proper error handling? No dead code? |
| **Process quality** | Medium | Full mode: Did review findings flow to the implement-fixes step? Sprint: Did the verify step thoroughly check the work? |

### Score Scale

| Score | Definition |
|-------|-----------|
| 5 | Excellent — correct, comprehensive tests, clean code, considers broader architectural implications |
| 4 | Good — correct implementation with tests, minor gaps (e.g., narrow focus on prompt, no broader refactoring) |
| 3 | Adequate — functional but rough edges, missing tests or error handling |
| 2 | Poor — partially functional, significant issues |
| 1 | Failed — doesn't work or has major errors |

### Scoring Results

All 6 runs scored **4/5**. In every case:
- Implementations were correct and functional
- Meaningful tests were written (ranging from 2 to 12 new tests per run)
- Code was clean and idiomatic
- The pipeline's quality mechanisms worked (review fixes in full mode, verify step in sprint)

No run scored 5 because implementations focused narrowly on the prompt without considering broader architectural implications (e.g., the hello world endpoint didn't consider API versioning; the YAML parser didn't consider config schema migration). This is expected — the prompts are deliberately simple, single-feature requests.

**Quality parity between modes:** Sprint and Full mode produced equivalent quality scores (4/4/4 each). Full mode's review cycle catches and fixes more issues (4–5 fixes per run), but Sprint's single-pass implementation was clean enough to score the same. For simple, well-scoped tasks, Sprint's quality is indistinguishable from Full mode.

---

## Observations About the Review-Triggers-Fix Flow

The Plan+Work+Review pipeline chains three review steps after work execution:

1. **Multi-agent code review** — reviews the work output
2. **Review consolidation** — synthesizes findings
3. **Implement review fixes** — applies the consolidated findings

### How It Worked

All 3 full-mode runs demonstrated the flow working correctly end-to-end:

| Run | Review Findings | Fixes Applied | Examples |
|-----|----------------|---------------|----------|
| hello world endpoint | 5 | 5 | Port logging, signal handlers, 405 Allow header, test cleanup, hostname binding |
| health check endpoint | 4 | 4 | startTime scope, await server.stop, port documentation, redundant Content-Type |
| YAML config parser | 5 | 5 | Orphaned JSDoc, error messages, extension guard, dotfile support, documentation update |

### Key Observations

1. **Review findings consistently flow to the implement-fixes step.** The dispatcher accumulates context from prior review steps and passes it to the "Implement review fixes" step. This worked in 3/3 runs with zero failures.

2. **Fixes are substantive, not cosmetic.** Review findings included real code improvements: signal handler installation, proper async cleanup (`await server.stop`), missing HTTP method guards (405 responses), and expanded error messages. These are the kinds of issues that would survive casual human review.

3. **Review adds 14 total fixes across 3 runs** (mean 4.7 per run). Each fix represents a concrete code quality improvement that the initial work step missed.

4. **The review cycle's latency cost is justified for complex changes.** The review phase adds ~4–8 minutes, but produces 4–5 actionable improvements per run. For production-quality changes, this is a favorable tradeoff.

5. **Sprint skips review but still produces good code.** Sprint's verify step runs tests and type checks but doesn't do semantic code review. For simple tasks, the resulting quality is equivalent (both scored 4/5). For larger, more complex changes, the review cycle would likely differentiate more.

---

## Conclusions

- **Use Sprint mode for simple, well-scoped tasks** where speed matters (3.5 min mean, 6× faster).
- **Use Plan+Work+Review for complex tasks** where thoroughness matters (22 min mean, includes iterative review fixes).
- **Quality is consistent at 4/5** across both modes for simple tasks. The review cycle's value would likely increase with task complexity.
- **Pipeline reliability is excellent** — zero errors across 6 runs, stable step insertion, consistent review-fix flow.
