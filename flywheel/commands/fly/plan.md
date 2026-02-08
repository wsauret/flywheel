---
name: fly:plan
description: Full planning workflow - create, enrich (verify + add research insights), review, and consolidate. Orchestrates four independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**MANDATORY FIRST ACTION — You MUST follow the orchestration instructions below, starting with Input Detection. Do NOT read files, search code, or respond to the user first.**

**Note: The current year is 2026.**

<input> #$ARGUMENTS </input>

This orchestrator coordinates four independent skills in sequence:
1. **plan-creation** - Research and create the initial plan
2. **plan-enrich** - Verify assumptions AND add research insights
3. **plan-review** - Run all reviewer agents in parallel
4. **plan-consolidation** - Restructure into actionable checklist for `/fly:work`

Each skill can also be invoked independently. All outputs are materialized to the same plan file.

---

## IMPORTANT: Planning Mode Only

**DO NOT WRITE OR EDIT ANY CODE DURING PLANNING!**

This workflow is for research and planning only. Implementation happens in `/fly:work`.

- Research the codebase (read files, search patterns)
- Query documentation and best practices
- Write and edit markdown plan files in `plans/`
- Do NOT create or edit source code, tests, or configs

---

## Input Detection

**Check the input type to determine which phases to run:**

```
If input ends with "-design.md" AND file exists:
  -> DESIGN MODE
  -> Run: plan-creation (uses design as input) -> plan-enrich -> plan-review -> plan-consolidation

If input is ".md" file in plans/ AND file exists:
  -> REVIEW MODE
  -> Skip creation, use existing plan
  -> Run: plan-enrich -> plan-review -> plan-consolidation

Otherwise:
  -> FULL MODE
  -> Run: plan-creation -> plan-enrich -> plan-review -> plan-consolidation
```

### Determine Mode

1. **Check if input ends with `-design.md`:**
   ```bash
   test -f "[input]" && echo "Design doc exists"
   ```
   If exists: Set `MODE=design`, `DESIGN_PATH=[input]`

2. **Check if input is existing plan in `plans/`:**
   ```bash
   test -f "[input]" && [[ "[input]" == plans/*.md ]] && echo "Existing plan"
   ```
   If exists: Set `MODE=review`, `PLAN_PATH=[input]`

3. **Otherwise:** Set `MODE=full`, `FEATURE_DESCRIPTION=[input]`

---

## Phase Sequence

### Phase 1: Create Plan (skip if MODE=review)

```
skill: plan-creation
arguments: [input - feature description or design doc path]
```

Capture `PLAN_PATH` and `CONTEXT_PATH` from output. If post-creation options appear, select "Run verification".

### Phase 2: Enrich Plan

```
skill: plan-enrich
arguments: [PLAN_PATH]
```

If post-enrichment options appear, select "Run review".

### Phase 3: Review Plan

```
skill: plan-review
arguments: [PLAN_PATH]
```

If post-review options appear, select "Run consolidation".

### Phase 4: Consolidate

```
skill: plan-consolidation
arguments: [PLAN_PATH]
```

### Phase 5: Present Results

Display summary: plan path, context path, phases completed, findings count, and any critical items.

---

## Error Handling

- **plan-creation fails**: Report error, do not proceed
- **plan-enrich fails**: Report error, still run review on original plan
- **plan-review fails**: Report error, still run consolidation on what we have
- **plan-consolidation fails**: Report error, present un-consolidated plan (still usable)

Each phase writes to disk before completing. Re-running `/fly:plan` with an existing plan path skips creation.

---

## Examples

- `/fly:plan Add user authentication with OAuth2` — Full mode (all 4 phases)
- `/fly:plan plans/oauth2-design.md` — Design mode (uses design doc as input)
- `/fly:plan plans/feat-user-auth.md` — Review mode (skips creation)

---

See `references/plan-orchestration-flow.md` for state flow diagram and variable handoff details.
