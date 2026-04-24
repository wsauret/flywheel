# Plan Compliance Check — Full Reference

This reference backs `work-review` Phase 1.0. It describes the TWO mechanical compliance checks the skill runs against the frozen baseline + live state, plus Check 0 (baseline hash verification) which gates both.

> Note on "Check 3" (commands re-execution): per D3 of the rigor-gradient pipeline refactor, the K6 commands re-execution check is **CUT**. The trust mechanism for "implementer ran the tests" is B5 (work-implementation's anti-pattern against declaring done without running tests). Re-executing recorded commands adds wall-time, idempotency risk (re-running `git commit`/migrations), and only samples a few entries. Do not reintroduce Check 3 without reversing D3 at the plan level.

## Preconditions

Phase 1.0 only runs when the active session has both `baseline.json` and `state.json`. Resolve the session dir via `.flywheel/plugin/active.json`:

```bash
SESSION_DIR=".flywheel/plugin/sessions/$(jq -r .session_id .flywheel/plugin/active.json)"
BASELINE="$SESSION_DIR/baseline.json"
STATE="$SESSION_DIR/state.json"
SESSION="$SESSION_DIR/session.json"
```

If either `baseline.json` or `state.json` is missing, skip to Phase 1.5 (this is not planned work — nothing to compare against).

## Check 0 — Baseline Hash Verification (Gate)

Before any structural comparison, re-verify that the baseline bytes on disk still match the hash recorded when work-implementation froze them.

```bash
COMPUTED=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
STORED=$(jq -r '.baseline_hash' "$SESSION")

if [ "$COMPUTED" != "$STORED" ]; then
  # Emit a synthetic P1 finding and HALT the mechanical checks.
  # Subsequent checks would be meaningless against a mutated baseline.
  ...
fi
```

Hash format: 64 lowercase hex chars (SHA-256). Portable hasher: `shasum -a 256` (available on both macOS and Linux).

On mismatch, emit this synthetic P1 finding:

```json
{
  "title": "Baseline was mutated after work-start",
  "severity": "P1",
  "scope": { "kind": "plan", "phase_id": "*" },
  "what_wrong": "SHA-256 of baseline.json (<computed>) does not match session.json.baseline_hash (<stored>). The baseline file was altered after work-implementation froze it.",
  "suggested_fix": "Investigate what modified baseline.json. If the change is intentional, re-run work-implementation to produce a fresh baseline with an updated hash. Do NOT edit baseline.json directly.",
  "evidence": "shasum -a 256 mismatch. Check 0 halts subsequent mechanical checks."
}
```

**HALT semantics**: when Check 0 fails, do not run Check 1 or Check 2 against this session. Their output would be compared against an untrusted reference. Write only the Check 0 finding into `review.findings.json` and surface the halt prominently in the chat summary.

## Check 1 — Structured Diff (Scope Drift)

Compare the baseline shape to the state shape. Three classes of drift, all P1:

### 1a. Skipped phases

`baseline.phases[].id` that is absent from `state.phases[]` with `status == "completed"` is a phase the implementer committed to but never finished (even though work is considered done).

```json
{
  "title": "Phase <id> skipped but baseline requires it",
  "severity": "P1",
  "scope": { "kind": "plan", "phase_id": "<id>" },
  "what_wrong": "Baseline phase <id> is not marked completed in state.",
  "suggested_fix": "Implement the phase or amend the baseline to remove it.",
  "evidence": "state.phases[].status for <id> is <status or 'absent'>."
}
```

### 1b. Files outside baseline scope

Any path in `state.phases[i].artifacts.files_created[]` or `files_modified[]` that is NOT in the corresponding `baseline.phases[i].files[]` is an out-of-scope edit.

```json
{
  "title": "File outside baseline scope modified",
  "severity": "P1",
  "scope": { "kind": "code", "file": "<path>", "line": null },
  "what_wrong": "state.phases[<id>].artifacts touched <path> but baseline.phases[<id>].files[] does not include it.",
  "suggested_fix": "Remove the edit or amend the baseline to include <path>.",
  "evidence": "state.phases[<id>].artifacts files_modified/files_created listed <path>."
}
```

Note the polymorphic scope: this is a `code` finding because the evidence is a concrete file, not a planning concept.

### 1c. Removed tasks

Baseline tasks that show no evidence of being implemented in state. The evidence surface is `state.phases[i].outcomes[]`: if outcomes reference at least one baseline task id (by literal match), any baseline task NOT referenced is treated as removed. If outcomes reference no task ids, the check is silent for that phase (we cannot distinguish coverage and must not emit false positives).

```json
{
  "title": "Task removed from implementation",
  "severity": "P1",
  "scope": { "kind": "plan", "phase_id": "<id>", "task_id": "<tid>" },
  "what_wrong": "Baseline task <tid> in <id> is not referenced in state outcomes.",
  "suggested_fix": "Implement task <tid> or amend baseline to remove it.",
  "evidence": "state.phases[<id>].outcomes does not mention task id <tid>."
}
```

## Check 2 — BC Coverage

Every behavioral contract in the baseline must have at least one phase that satisfied it. Compute the union of `state.phases[].bc_satisfied[]`. For each `baseline.behavioral_contract[].id` NOT in the union, emit a P1 finding.

```json
{
  "title": "Behavioral contract <bc_id> has no satisfying task",
  "severity": "P1",
  "scope": { "kind": "plan", "bc_id": "<bc_id>" },
  "what_wrong": "Baseline declares <bc_id> but no phase satisfied it (absent from union of state.phases[].bc_satisfied[]).",
  "suggested_fix": "Add a task that fulfills <bc_id> or amend the baseline to remove the BC.",
  "evidence": "Union of state.phases[].bc_satisfied[] does not include <bc_id>."
}
```

This turns "did the implementer satisfy every contract they agreed to?" into a mechanical one-liner.

## Scope Polymorphism Summary

| Check | scope.kind | Additional required |
|---|---|---|
| Check 0 (hash mismatch) | `plan` | `phase_id` (use `"*"` when not phase-specific) |
| Check 1a (skipped phase) | `plan` | `phase_id` |
| Check 1b (file outside baseline) | `code` | `file`, optional `line: null` |
| Check 1c (removed task) | `plan` | `phase_id` + `task_id` |
| Check 2 (uncovered BC) | `plan` | `bc_id` |

All findings must conform to `flywheel/schemas/findings.schema.json`. The `scope` is polymorphic (`oneOf`) — `plan` requires at least one of `phase_id` / `task_id` / `bc_id`; `code` requires `file`.

## Emission Path

The findings produced by Check 0, 1, and 2 are synthetic (no reviewer agent produced them), so they skip the parse step in Phase 3.1 but still pass through:

1. The fingerprint script (`flywheel/synthesizer/fingerprint.sh --group`) alongside reviewer outputs, so cross-reviewer + mechanical-check collisions promote severity (rare but possible: a reviewer also flags scope drift).
2. The write path that produces `review.findings.json` in the session dir.

The synthesizer uses `"reviewer": "synthesizer"` on the envelope (see `findings.schema.json`'s reviewer enum). The mechanical checks use the same envelope when surfacing their findings through the pipeline.

## Reference Tests

- `tests/work-review/hash.test.sh` — Check 0 (normal + mutated cases, hash format).
- `tests/work-review/diff.test.sh` — Check 1 (skipped phase, file outside baseline, removed task).
- `tests/work-review/bc-coverage.test.sh` — Check 2 (uncovered BC, all-covered happy path).

## Anti-Patterns

- **Do not re-emit findings when Check 0 halts**. Checks 1 and 2 must be skipped on hash mismatch.
- **Do not widen the file-outside-baseline check to subdirectories.** An explicit file list means the implementer committed to those files; the check's value is that it is literal.
- **Do not treat "state.status == completed" as proof of phase completion.** Check 1a compares `baseline.phases[].id` against `state.phases[]` with `status == "completed"`; state's top-level status is a summary field.
- **Do not re-introduce commands re-execution (former Check 3).** D3 cut it; reversing requires a D3-level decision, not an implementation change.
