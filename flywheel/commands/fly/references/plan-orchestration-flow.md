# Plan Orchestration Flow

State flow between phases in the `/fly:plan` orchestrator.

## Variable Handoff

| Variable | Set By | Used By |
|----------|--------|---------|
| `MODE` | Input Detection | Phase 1 (skip if review) |
| `PLAN_PATH` | Phase 1 (plan-creation) or Input Detection (review mode) | Phases 2, 3, 4, 5 |
| `CONTEXT_PATH` | Phase 1 (plan-creation) | Phases 2, 3, 4 |

## Flow Diagram

```
[Input Detection]
       |
       v
   MODE, INPUT
       |
       v
[Phase 1: Create] -----> PLAN_PATH, CONTEXT_PATH
       |                       |
       v                       |
[Phase 2: Enrich] <-----------+
       |                       |
       | (skill: plan-enrich)
       | (writes Verification Summary + Research Validation TO PLAN FILE)
       v                       |
[Phase 3: Review] <-----------+
       |
       | (skill: plan-review)
       | (writes Review Summary TO PLAN FILE)
       v
[Phase 4: Consolidate]
       |
       | (skill: plan-consolidation)
       | (restructures entire plan into actionable format)
       v
[Phase 5: Present]
```

## Key Point

After Phase 4, the plan file at `PLAN_PATH` is a single, coherent document with:
- Implementation checklist with concrete steps
- Research insights integrated into relevant steps
- Review findings addressed or deferred
- Technical reference section with best practices
- Raw data preserved in collapsible Appendix
- Ready for `/fly:work`
