# Checkpoint Procedure

Every phase completion emits a checkpoint: a JSON-atomic write to `state.json` + an update to `session.json.last_checkpoint_at`. This file documents the exact procedure, the atomic-write invariant, and the accuracy requirements for `commands_run[]`.

## When to Checkpoint

- After every phase completes (`phases[i].status` transitions to `completed`).
- After every successful subagent dispatch (update `outcomes[]`, `artifacts`).
- On 3-strike escalation (record the strike in `phases[i].strikes[]`).
- On skill exit (update `active_skill: null` in session.json).

## Atomic Write Invariant (P1-D)

**Always** write `state.json` through `state.json.tmp`, then rename:

```bash
# Construct the updated state in-memory (via jq), write to .tmp, rename.
jq '<mutation>' "$SESSION_DIR/state.json" > "$SESSION_DIR/state.json.tmp"
mv "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/state.json"
```

The `mv` is atomic on local POSIX filesystems. At any instant, `state.json` is either pre-write or post-write — never partial. `state.json.tmp` exists only during the write window.

**Same pattern applies to session.json**:

```bash
jq '.last_checkpoint_at = $ts' --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
```

`tests/work/atomic-write.test.sh` exercises this pattern.

## Checkpoint Steps (Per Phase Completion)

### Step 1: Capture artifacts from the subagent

The subagent reports:
- `files_created[]` — paths of new files.
- `files_modified[]` — paths of edited files.
- `commands_run[]` — every command executed, with exit_code and stdout_tail.

Example agent-reported JSON payload:

```json
{
  "outcomes": ["Added --timeout to commander", "Tests pass"],
  "artifacts": {
    "files_created": ["tests/cli/timeout.test.ts"],
    "files_modified": ["src/cli.ts"],
    "commands_run": [
      {
        "command": "bun run test tests/cli/timeout.test.ts",
        "exit_code": 0,
        "stdout_tail": "PASS — 4 tests passed",
        "re_executable": true
      }
    ]
  }
}
```

### Step 2: Compute `bc_satisfied[]` for this phase

Union of `fulfills[]` across the phase's tasks. Pull from the baseline (not the live spec.json — baseline is authoritative for what was committed to):

```bash
BC_SATISFIED=$(jq --arg pid "$PHASE_ID" '
  [.phases[] | select(.id == $pid) | .tasks[].fulfills[]] | unique
' "$SESSION_DIR/baseline.json")
```

### Step 3: Record how the phase was executed

Every phase-completion checkpoint must set `executed_by` — `"subagent"` (default, the phase was dispatched per SKILL.md Phase 2.2) or `"main-agent"` (bypass, requires `bypass_justification`). See `references/state-file-template.md` for the field contract.

If you are about to write `executed_by: "main-agent"`, stop and read the "`executed_by` and `bypass_justification`" section of state-file-template.md before proceeding. Bypasses for convenience reasons ("it was small," "I already had context") are not legitimate and should be rewritten as subagent dispatches.

### Step 4: Merge into state.json via atomic write

```bash
jq --argjson new_phase "$UPDATED_PHASE_JSON" \
   --argjson bc_list "$BC_SATISFIED" \
   --arg executed_by "$EXECUTED_BY" \
   --arg bypass_justification "${BYPASS_JUSTIFICATION:-}" '
  (.phases[] | select(.id == $new_phase.id)) |= (
    . + $new_phase |
    .status = "completed" |
    .completed_at = now | todateiso8601 |
    .bc_satisfied = $bc_list |
    .executed_by = $executed_by |
    .bypass_justification = (if $bypass_justification == "" then null else $bypass_justification end)
  )
  | .status = "in_progress"
  | .summary = "Phase \($new_phase.id) complete."
' "$SESSION_DIR/state.json" > "$SESSION_DIR/state.json.tmp"
mv "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/state.json"
```

**Checkpoint validity check**: if `executed_by == "main-agent"` and `bypass_justification` is null or empty, the checkpoint is invalid. Either set a real justification or re-execute the phase via subagent dispatch before checkpointing.

### Step 5: Update session.json.last_checkpoint_at

```bash
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_checkpoint_at = $ts' \
  "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
```

### Step 6: Manual Verification Pause (if applicable)

If the current phase's `manual_verification` field is non-empty, ask the user before continuing:

```
Phase <id> complete — ready for manual verification.

Automated verification passed: <list from artifacts.commands_run>

Please verify manually: <from phase.manual_verification>

1. Continue to next phase (Recommended) — I've verified manually
2. Continue all remaining — Skip future manual pauses
3. Stop here — I have feedback
```

Handle:
- **Continue**: proceed to next phase.
- **Continue all**: set a session-scoped flag to skip future manual pauses this run.
- **Stop here**: set phase status to `paused`, exit the execution loop, wait for the user.

## `commands_run` Accuracy Requirement (K5)

From the state schema:

```json
{
  "command": "...",
  "exit_code": 0,
  "stdout_tail": "...",
  "re_executable": true
}
```

Rules:

- **`command`** is the literal string executed. Include redirections, pipes, env-var prefixes if they're part of the run.
- **`exit_code`** is the actual value captured via `$?` or the bash return. **Do not guess**; do not write `0` just because tests "should" pass.
- **`stdout_tail`** is an actual truncation of captured stdout (last ~200 chars is fine). Fabrication here is a K5 violation.
- **`re_executable`** is `true` if the command can be re-run safely (idempotent tests, lints, type-checks) and `false` if not (`git commit`, DB migrations, filesystem-mutating scripts).

Work-review Phase 4b (when it lands) may run a re-execution check against entries with `re_executable: true`. Fabricated entries break that check. Be accurate or drop the entry.

## Reference to Phase 4b Compliance Consequences

Phase 4b (work-review) runs two mechanical checks against state.json:

1. **Structured diff** vs baseline.json — did we stay within scope?
2. **BC coverage** — is every baseline BC covered by `state.phases[].bc_satisfied[]`?

Both require state.json to accurately reflect what happened. If you fabricate a phase-completion entry, Phase 4b's BC-coverage check will claim false coverage, and a reviewer will surface the discrepancy as a P1 finding against the phase.

Accurate checkpointing is a downstream requirement. Enforce it at source.

## Recovery From Interrupted Checkpoint

If the orchestrator is interrupted mid-checkpoint (e.g. context cleared right after `jq` but before `mv`):

- `state.json.tmp` exists with the new content.
- `state.json` still holds the prior state.
- Readers see the prior state (no partial-write corruption).
- On resume, work-implementation Phase 0 startup should **delete any stale `.tmp` file** (it's scratch):
  ```bash
  rm -f "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/session.json.tmp"
  ```
- The phase will be re-executed (it was `in_progress`, not `completed`). This is safe if subagent work is idempotent — TDD-driven phases usually are. If not, the subagent must detect "already done" and short-circuit.

## No Dual-Write, Just Atomic Write

Earlier versions of this skill used dual-write (state.md + native Tasks) for redundancy. With JSON state the dual-write is unnecessary:

- `state.json` is atomic on disk.
- Recovery reads from `state.json` directly.
- Native Tasks (TaskCreate/TaskUpdate/TaskList) are still useful for UI-level progress visualization but are **not** the source of truth. Keep them in sync if used; do not rely on them for resume.

## Common Mistakes

- **Writing `state.json` directly (no `.tmp`)**: half-written state corrupts resume.
- **Forgetting to update `session.json.last_checkpoint_at`**: resume still works but staleness tracking is wrong.
- **Fabricating `commands_run[]` entries**: K5 violation; downstream compliance breaks.
- **Leaving `strikes[]` empty after actual failures**: loses the error log; 3-strike escalation needs the history.
- **Updating `bc_satisfied[]` before the phase's `verification` command exits 0**: violates the "evidence before claim" rule; see `verification-gates.md`.
- **Omitting `executed_by` or setting `"main-agent"` without a justification**: SKILL.md Phase 2.2 requires subagent dispatch. Bypass requires a documented structural reason (not convenience) in `bypass_justification`.
