# Plan Compliance Check — Full Reference

This reference contains the detailed procedure and report template for Phase 1.0: Plan Compliance Check.

## Check for Associated Plan

```bash
# Look for state file that indicates this was planned work
ls docs/plans/*.state.md 2>/dev/null | head -5
```

If state file exists, proceed with compliance check. Otherwise, skip to Phase 1.5.

## Load Plan and State

1. Read the plan file (or `.baseline.md` if it exists — see Baseline section below)
2. Read the state file
3. Extract:
   - All phases from plan
   - Progress markers from state file
   - Acceptance criteria from plan
   - Key decisions from state file

## Baseline Plan Snapshot

**When work-implementation starts**, it should copy plan to `[plan].baseline.md`.

The compliance check compares against the **baseline** (what was committed to) not the current plan (which may have evolved). If no baseline exists, use the current plan.

## Compliance Report Template

```markdown
## Plan Compliance Check

### Plan: [plan name]

### Implementation Status

| Phase | Plan | State | Status |
|-------|------|-------|--------|
| Phase 1 | [description] | [x] | ✓ Implemented |
| Phase 2 | [description] | [x] | ✓ Implemented |
| Phase 3 | [description] | [ ] | ⚠️ Not started |

### Acceptance Criteria

#### Automated Verification (from plan)
- [x] Tests pass: [evidence from state]
- [x] Linting passes: [evidence]

#### Manual Verification (from plan)
- [~] Feature works in UI: [status from state]
- [ ] Performance acceptable: [status]

### Deviations from Plan

| Item | Planned | Actual | Type |
|------|---------|--------|------|
| [Item] | [Expected] | [What happened] | Intentional/Accidental |

### Key Decisions Made (from state)

- [Decision 1]
- [Decision 2]

### Compliance Summary

**Status:** ✓ Compliant / ⚠️ Partial / ✗ Non-compliant

[Brief assessment of whether implementation matches plan spec]
```

## Compliance Checks

1. **Phase Completion:** Are all phases in plan marked complete in state?
2. **Acceptance Criteria:** Are all criteria addressed? (Use state file evidence)
3. **Scope Adherence:** Did implementation stay within "What We're NOT Doing"?
4. **Deviations:** Any intentional deviations documented? Any accidental ones?

## Output

Include compliance report as **first section** of the review output.

If compliance check reveals significant deviations (P1), flag them prominently.
