---
name: fly:plan
description: Full planning workflow - create, enrich (verify + add research insights), review, and consolidate. Orchestrates four independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the correct skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Determine which skill to invoke first based on the input:**

- If the input is a path to an **existing `.md` file in `docs/plans/`** (NOT ending in `-design.md`): invoke `plan-enrich` (skip creation)
- **Otherwise** (feature description OR `-design.md` path): invoke `plan-creation`

**Invoke the first skill NOW using the Skill tool:**

```
skill: plan-creation
```

OR if the input is an existing plan file in `docs/plans/`:

```
skill: plan-enrich
```

<input> #$ARGUMENTS </input>

**Note: The current year is 2026.**

---

## IMPORTANT: Planning Mode Only

**DO NOT WRITE OR EDIT ANY CODE DURING PLANNING!**

This workflow is for research and planning only. Implementation happens in `/fly:work`.

---

## After the First Skill Completes

This orchestrator runs four skills in sequence. After each skill completes, immediately invoke the next one using the Skill tool. **Do NOT stop between phases** — select "continue" options when presented and invoke the next skill.

### Full sequence:

1. **plan-creation** → produces `PLAN_PATH` and `CONTEXT_PATH`
2. **plan-enrich** → invoke with `PLAN_PATH` from step 1
3. **plan-review** → invoke with `PLAN_PATH`
4. **plan-consolidation** → invoke with `PLAN_PATH`

If you started with `plan-enrich` (review mode), continue with steps 3-4.

### Invoking each subsequent skill:

After plan-creation completes, invoke:
```
skill: plan-enrich
args: [PLAN_PATH from creation output]
```

After plan-enrich completes, invoke:
```
skill: plan-review
args: [PLAN_PATH]
```

After plan-review completes, invoke:
```
skill: plan-consolidation
args: [PLAN_PATH]
```

### Phase 5: Present Results

Display summary: plan path, context path, phases completed, findings count, and any critical items.

---

## Error Handling

- **plan-creation fails**: Report error, do not proceed
- **plan-enrich fails**: Report error, still run review on original plan
- **plan-review fails**: Report error, still run consolidation on what we have
- **plan-consolidation fails**: Report error, present un-consolidated plan (still usable)

---

## Examples

- `/fly:plan Add user authentication with OAuth2` — Full mode (all 4 phases)
- `/fly:plan docs/plans/oauth2-design.md` — Design mode (creation uses design doc as input)
- `/fly:plan docs/plans/feat-user-auth.md` — Review mode (skips creation, starts at enrich)

---

See `references/plan-orchestration-flow.md` for state flow diagram and variable handoff details.
