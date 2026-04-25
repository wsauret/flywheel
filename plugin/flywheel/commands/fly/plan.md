---
name: fly:plan
description: Full planning workflow - create (with integrated validation), review, and consolidate. Orchestrates three independent skills.
argument-hint: "[feature description OR path to *-design.md OR slug of existing session]"
---

# Full Planning Workflow

**MANDATORY FIRST ACTION — You MUST use the Skill tool to invoke the correct skill below BEFORE doing anything else. Do NOT read files, search code, or respond to the user first.**

**Determine which skill to invoke first based on the input:**

- If the input is a **slug** (lowercase kebab, e.g. `feat-user-auth`) that matches an existing session under `.flywheel/plugin/sessions/<slug>-*` whose `spec.json` exists: invoke `plan-review` (skip creation)
- **Otherwise** (feature description, or a path to a design document ending in `-design.md`): invoke `plan-creation`

**Invoke the first skill NOW using the Skill tool:**

```
skill: plan-creation
```

OR if the input resolves to an existing session with spec.json:

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

After plan-creation, the session dir at `.flywheel/plugin/sessions/<session-id>/` contains the spec.json and session.json that subsequent skills read. The active pointer `.flywheel/plugin/active.json` is the connecting glue — no explicit path-passing between phases.

1. **plan-creation** → writes `spec.json`, `session.json` into the session dir; updates `active.json`
2. **plan-review** → reads the active session's spec.json, writes `findings.json`
3. **plan-consolidation** → merges `findings.json` into `spec.json`; backs up pre-consolidation spec to `spec.json.pre-consolidation`

If the input was a slug that resolved to an existing session (review mode), start at step 2.

### Invoking each subsequent skill:

After plan-creation completes, invoke:
```
skill: plan-review
```

After plan-review completes, invoke:
```
skill: plan-consolidation
```

Both skills read the active session via `.flywheel/plugin/active.json` — no path arg needed.

### Phase 4: Present Results

Display summary: session id, session dir path, phases completed, findings count, and any critical items.

---

## Error Handling

- **plan-creation fails**: Report error, do not proceed
- **plan-review fails**: Report error, still run consolidation on what we have
- **plan-consolidation fails**: Report error, present un-consolidated plan (still usable)

---

## Examples

- `/fly:plan Add user authentication with OAuth2` — Full mode (all 3 phases, creates a new session)
- `/fly:plan docs/plans/oauth2-design.md` — Design mode (creation uses design doc as input, creates a new session)
- `/fly:plan feat-user-auth` — Review mode if a session slug `feat-user-auth-*` already exists (skips creation, starts at review)

---

After consolidation, the session dir contains: `spec.json` (refined with findings integrated), `spec.json.pre-consolidation` (backup of the pre-refinement spec), and `session.json`. The `review.findings.json` is consumed and removed. Ready for `/fly:work`.
