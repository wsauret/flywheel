---
name: plan-consolidation
description: Refine the active session's spec.json by merging reviewer findings.json into it. Backs up the pre-refinement spec to a .pre-consolidation sidecar. Triggers on "consolidate plan", "finalize plan".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# Plan Consolidation Skill

Merge review findings into the active session's `spec.json`. The refined spec carries `origin.created_by = "plan-consolidation"` and an `origin.findings_path`. Pre-refinement spec preserved as a `.pre-consolidation` sidecar (D7). Namespace: plugin uses `.flywheel/plugin/sessions/`.

## Input

No arguments. Reads the active session from `.flywheel/plugin/active.json`.

---

## Phase 1: Load Active Session

1. Read `.flywheel/plugin/active.json` to resolve `session_id`
2. Compute session directory: `.flywheel/plugin/sessions/<session_id>/`
3. Read three inputs:
   - `spec.json` (the pre-refinement spec)
   - `findings.json` (written by plan-review)
   - `context.md` (research sidecar)

**Errors:**

- `active.json` missing → ask the user to run plan-creation first
- `findings.json` missing → ask the user to run plan-review first, or abort
- `spec.json` missing → the session is broken; ask the user to delete and restart

---

## Phase 2: Back Up to Sidecar (D7)

```bash
cp .flywheel/plugin/sessions/<id>/spec.json \
   .flywheel/plugin/sessions/<id>/spec.json.pre-consolidation
```

Cleaned on `ship`.

---

## Phase 3: No-Op Check

If `findings.json` has zero findings and zero open questions:

- Print: "No refinements needed — spec is already work-ready."
- Skip to Phase 7 (next-steps prompt).

---

## Phase 4: Surface Open Questions

Questions to surface:

1. `findings.json.open_questions` (entries the synthesizer could not resolve)
2. Inter-reviewer conflicts — findings sharing a fingerprint but diverging on severity (synthesizer promotes severity and flags the divergence)

Present each question **BLOCKING: one at a time** via AskUserQuestion:

```
Question: "[Topic]: [The question]"
Context: [Brief explanation of why this matters]
My recommendation: [Preferred option and why]
Options:
1. [Option A] (Recommended) - [Brief description]
2. [Option B] - [Brief description]
3. "You pick what's best" - Let me decide
```

Record: user picks option → decision logged; "You decide" → apply recommendation, note delegated; custom answer → record exactly. **BLOCKING: Never proceed with unresolved questions.**

---

## Phase 5: Integrate Findings by Severity

For each finding in `findings.json.findings`:

### P1 — Must Integrate

- Fold `suggested_fix` language into the affected task's `description`
- Add test scenarios that cover the failure mode described in `what_wrong`
- If the finding does not map to an existing task: add a new task (and, if needed, a new BC with a matching `fulfills[]` claim)

### P2 — Default Integrate; Allow Defer

Same as P1 by default, but the user may defer with a rationale. Deferred P2s are recorded as a task note (keep the rationale terse; one sentence).

### P3 — User Triage

Present each P3 via AskUserQuestion with three options:

- **Include** — integrate like a P2
- **Drop** — no change to spec
- **Follow-up** — note as a future improvement in the spec's `success_criteria` or `open_questions` (user's choice)

---

## Phase 6: Re-Validate BC Coverage

Per D13:

- **BLOCKING: Orphans (zero claims)** → hard error. Either assign a task's `fulfills[]` or remove the BC.
- **Duplicates (multiple claims on the same BC)** → surface as an Open Question (not automatic failure). Ask which claim is authoritative; keep both if they cover different scenarios.

Re-run coverage check after integrations. If a new BC was added in Phase 5, confirm it has at-least-one task claim.

---

## Phase 7: Write Refined Spec and Prompt

1. Update the spec in memory:
   - `origin.created_by = "plan-consolidation"`
   - `origin.findings_path = ".flywheel/plugin/sessions/<id>/findings.json"`
2. Validate the refined spec against `flywheel/schemas/task-list.schema.json` before writing
3. Write `.flywheel/plugin/sessions/<id>/spec.json` (overwrite)
4. Print summary:
   ```
   Spec refined — <id>
   Integrated: N P1, N P2, N P3
   Deferred: N
   BC coverage: OK (all BCs claimed)
   ```
5. **AskUserQuestion:** "Spec consolidated and ready. What next?"
   - Start `/fly:work` (Recommended)
   - Done for now

---

## Error Handling

- **Active session missing:** Prompt user to run plan-creation first
- **Findings missing:** Prompt user to run plan-review first, or abort
- **Schema validation failure on write:** Restore from `spec.json.pre-consolidation`; report which field failed; do not leave a half-merged spec on disk
- **User rejects every option on an open question:** Abort consolidation; spec stays in pre-refinement state (sidecar was created but the main spec.json was not overwritten)

---

## Anti-Patterns

- **Skip open-question resolution** — Don't refine with unresolved questions
- **Multiple questions at once** — One at a time
- **BLOCKING: Auto-drop a P1** — P1s integrate; only the user may downgrade to follow-up
- **BLOCKING: Silent BC orphaning** — Adding a task without assigning `fulfills[]` is a coverage failure
- **Touch `context.md`** — Research context stays a sidecar (D1). Only `spec.json` is refined.
