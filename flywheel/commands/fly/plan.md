---
name: fly:plan
description: Full planning workflow - create (with integrated validation), review, and consolidate. Orchestrates three independent skills.
argument-hint: "[feature description OR path to *-design.md OR path to existing plan]"
---

# Full Planning Workflow

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the correct skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Determine which skill to invoke first based on the input:**

- If the input is a path to an **existing `.md` file in `docs/plans/`** (NOT ending in `-design.md`): invoke `plan-review` (skip creation)
- **Otherwise** (feature description OR `-design.md` path): invoke `plan-creation`

**Invoke the first skill NOW using the Skill tool:**

```
skill: plan-creation
```

OR if the input is an existing plan file in `docs/plans/`:

```
skill: plan-review
```

<input> #$ARGUMENTS </input>

**Note: The current year is 2026.**

---

## IMPORTANT: Planning Mode Only

**DO NOT WRITE OR EDIT ANY CODE DURING PLANNING!**

This workflow is for research and planning only. Implementation happens in `/fly:work`.

---

## After the First Skill Completes

This orchestrator runs three skills in sequence. After each skill completes, immediately invoke the next one using the Skill tool. **Do NOT stop between phases** — select "continue" options when presented and invoke the next skill.

### Full sequence:

```
[Input] → plan-creation → plan-review → plan-consolidation → [Present]
```

| Variable | Set By | Used By |
|----------|--------|---------|
| `PLAN_PATH` | plan-creation (or input detection in review mode) | All subsequent skills |
| `CONTEXT_PATH` | plan-creation | plan-review, plan-consolidation |

1. **plan-creation** → produces `PLAN_PATH` and `CONTEXT_PATH` (includes codebase research, DRY checks, and external validation for high-risk topics)
2. **plan-review** → invoke with `PLAN_PATH`
3. **plan-consolidation** → invoke with `PLAN_PATH`

If you started with `plan-review` (review mode), continue with step 3.

### Invoking each subsequent skill:

After plan-creation completes, invoke:
```
skill: plan-review
args: [PLAN_PATH from creation output]
```

After plan-review completes, invoke:
```
skill: plan-consolidation
args: [PLAN_PATH]
```

### Phase 4: Present Results

Display summary: plan path, context path, phases completed, findings count, and any critical items.

---

## Error Handling

- **plan-creation fails**: Report error, do not proceed
- **plan-review fails**: Report error, still run consolidation on what we have
- **plan-consolidation fails**: Report error, present un-consolidated plan (still usable)

---

## Examples

- `/fly:plan Add user authentication with OAuth2` — Full mode (all 3 phases)
- `/fly:plan docs/plans/oauth2-design.md` — Design mode (creation uses design doc as input)
- `/fly:plan docs/plans/feat-user-auth.md` — Review mode (skips creation, starts at review)

---

After consolidation, the plan file at `PLAN_PATH` contains: implementation checklist, integrated review findings addressed or deferred, technical reference section, and raw data in a collapsible appendix. Ready for `/fly:work`.
