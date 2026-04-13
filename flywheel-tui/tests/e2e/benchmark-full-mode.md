# E2E Benchmark Report — Plan + Work + Review Mode (Option 3)

**Date:** 2026-03-27
**Mode:** Plan + Work + Review (option 3)
**HITL:** All automatic (no manual consolidation, no manual review triage)
**Approval gates:** N/A (gate step type removed)
**Engine:** Claude (default)
**Branch:** feat/flywheel-cli-engine

## Results

| Prompt | Total Runtime (s) | Quality Score (1-5) | Steps | Notes |
|--------|-------------------|---------------------|-------|-------|
| add a hello world endpoint | 1254 (20m 54s) | 4 | 12 (7→12) | Created server endpoint + integration tests; 5 review fixes applied (port logging, signal handlers, 405 Allow header, test cleanup) |
| add a health check endpoint that returns uptime | 1004 (16m 44s) | 4 | 11 (7→11) | Created health.ts with uptime tracking + comprehensive tests; 4 review fixes applied (startTime scope, await stop, port docs, redundant header) |
| add a YAML config file parser | 1667 (27m 47s) | 4 | 12 (7→12) | Extended config loader with YAML support, discoverConfigFile(), dotfile support, 6 test fixtures; 5 review fixes applied (JSDoc, error messages, extension guard, dotfiles, AGENTS.md) |

## Summary Statistics

- **Mean runtime:** 1308s (21m 48s)
- **Median runtime:** 1254s (20m 54s)
- **Min runtime:** 1004s (16m 44s)
- **Max runtime:** 1667s (27m 47s)
- **All runs:** 0 errors, 0 crashes

## Quality Assessment Methodology

Each run is scored 1-5 based on:
- **Correctness:** Does the implementation work as described?
- **Test coverage:** Are there meaningful tests?
- **Code quality:** Clean, idiomatic TypeScript?
- **Review-fix flow:** Did the implement-fixes step act on review findings?

All 3 runs scored 4/5: implementations were correct with tests, and review findings were properly addressed. No run scored 5 because the implementations, while functional, focused narrowly on the prompt rather than considering broader architectural implications.

## Review-Triggers-Fix Flow

All 3 runs demonstrated the review→implement-fixes pipeline working correctly:
- **Run 1:** 5 fixes from review (port logging, signal handlers, Allow header, test cleanup, hostname binding)
- **Run 2:** 4 fixes from review (startTime scope, await server.stop, port documentation, redundant Content-Type)
- **Run 3:** 5 fixes from review (orphaned JSDoc, error messages, extension guard, dotfile support, documentation update)

The "Implement review fixes" step successfully received context from prior review steps and acted on the findings in all cases.

## Observations

1. **Plan phase takes ~6-9 minutes** (4 steps: research, draft, review, consolidate)
2. **Work phase takes ~5-12 minutes** depending on task complexity (4-5 steps dynamically inserted from plan)
3. **Review phase takes ~4-8 minutes** (3 steps: multi-agent review, consolidation, implement fixes)
4. **Dynamic step insertion works:** Initial queue has 7 steps, work steps are inserted after plan consolidation (growing to 11-12 total)
5. **YAML config parser took longest** due to more files needing modification and more complex review fixes
6. **Zero errors across all runs** — the pipeline is stable and reliable
