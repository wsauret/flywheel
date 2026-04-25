# Checkpoint Procedure

After every chunk completes, the skill writes an atomic checkpoint to `progress.json` and updates `session.json.last_checkpoint_at`.

## When to Checkpoint

- After every chunk completes (subagent returned, verification passed).
- On skill exit (the trap clears `active_skill`).

## Atomic Write Invariant

**Always** write through `.tmp`, then rename:

```bash
jq '<mutation>' "$SESSION_DIR/progress.json" > "$SESSION_DIR/progress.json.tmp"
mv "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/progress.json"
```

The `mv` is atomic on local POSIX filesystems. At any instant, `progress.json` is either pre-write or post-write — never partial.

Same pattern for `session.json`:

```bash
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_checkpoint_at = $ts' \
  "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
```

## Checkpoint Steps (Per Chunk Completion)

### Step 1: Capture artifacts from the subagent

The subagent reports:
- `files_modified[]` — paths edited or created.
- `commands_run[]` — every command executed, with literal command and actual exit_code.
- `simplifications_made[]` (optional) — places the subagent deleted or consolidated instead of adding. One short string per simplification.

Example agent-reported payload:

```json
{
  "outcomes": ["Added --timeout to commander", "Tests pass"],
  "artifacts": {
    "files_modified": ["src/cli.ts", "tests/cli/timeout.test.ts"],
    "commands_run": [
      { "command": "bun run test tests/cli/timeout.test.ts", "exit_code": 0, "stdout_tail": "PASS — 4 tests passed" }
    ],
    "simplifications_made": ["Inlined the temporary timeout-default helper since it had one consumer"]
  }
}
```

### Step 2: Merge into progress.json

```bash
jq --arg id "$CHUNK_ID" \
   --argjson files "$FILES_MODIFIED" \
   --argjson cmds "$COMMANDS_RUN" \
   --argjson simps "$SIMPLIFICATIONS" '
  .completed += [$id]
  | .in_progress = null
  | .artifacts.files_modified = (.artifacts.files_modified + $files | unique)
  | .artifacts.commands_run += $cmds
  | .artifacts.simplifications_made = ((.artifacts.simplifications_made // []) + $simps)
  | .status = "in_progress"
' "$SESSION_DIR/progress.json" > "$SESSION_DIR/progress.json.tmp"
mv "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/progress.json"
```

`$SIMPLIFICATIONS` defaults to `[]` if the subagent reported none.

If this is the last chunk, set `status: "completed"` instead of `"in_progress"`.

### Step 3: Update session.json.last_checkpoint_at

```bash
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.last_checkpoint_at = $ts' \
  "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
```

### Step 4: Manual Verification Pause (plan mode, if applicable)

If the current phase's `manual_verification` field is non-empty, ask the user before continuing:

```
Phase <id> complete — ready for manual verification.

Automated verification passed: <list from artifacts.commands_run>

Please verify manually: <from phase.manual_verification>

1. Continue to next chunk (Recommended) — I've verified manually
2. Continue all remaining — Skip future manual pauses
3. Stop here — I have feedback
```

Handle:
- **Continue**: proceed to next chunk.
- **Continue all**: set a session-scoped flag to skip future manual pauses this run.
- **Stop here**: stop the loop and wait for the user. Resume picks up from the same chunk on next `/fly:work`.

## `commands_run` Accuracy

From the schema:

```json
{
  "command": "...",
  "exit_code": 0,
  "stdout_tail": "..."
}
```

Rules:

- **`command`** is the literal string executed. Include redirections, pipes, env-var prefixes.
- **`exit_code`** is the actual value captured. **Do not guess**; do not write `0` just because tests "should" pass.
- **`stdout_tail`** is an actual truncation of captured stdout. Fabrication here breaks the verification discipline.

Be accurate or drop the entry.

## Recovery From Interrupted Checkpoint

If the orchestrator is interrupted mid-checkpoint (e.g. context cleared right after `jq` but before `mv`):

- `progress.json.tmp` exists with the new content.
- `progress.json` still holds the prior state.
- Readers see the prior state (no partial-write corruption).
- On resume, Phase 0/1 should delete any stale `.tmp` file:
  ```bash
  rm -f "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/session.json.tmp"
  ```
- The chunk will be re-executed (its ID was not yet in `completed[]`). Subagent work should be idempotent — TDD-driven changes usually are.

## Common Mistakes

- **Writing `progress.json` directly (no `.tmp`)**: half-written state corrupts resume.
- **Forgetting to update `session.json.last_checkpoint_at`**: resume still works but staleness tracking is wrong.
- **Fabricating `commands_run[]` entries**: breaks verification discipline.
- **Appending the chunk ID to `completed[]` before `verification` exits 0**: violates the "evidence before claim" rule. See `verification-gates.md`.
