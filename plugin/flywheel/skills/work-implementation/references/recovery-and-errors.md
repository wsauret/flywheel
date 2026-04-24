# Recovery & Error Handling

## Recovery

If the user clears context mid-execution (or the orchestrator compacts):

1. User says "carry on" or runs `/fly:work` with no arguments.
2. Phase 0 resolves the active session via `.flywheel/plugin/active.json` (see `session-detection.md` for the full procedure, including stale-pointer rescue and slug-arg tiebreak).
3. Phase 1 reads `state.json` from the session directory.
4. Resume entry point: the first phase whose `status != "completed"`.
5. Key decisions carry forward via `state.learnings[]`.

**No work is lost.** `state.json` is the authoritative recovery surface; `session.json` is the session-level pointer. Both are written atomically (see `checkpoint-procedure.md`) so a partial write never corrupts resume.

### Cleanup of Stranded `.tmp` Files

On startup, if `state.json.tmp` or `session.json.tmp` exist, they are scratch from an interrupted write:

```bash
rm -f "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/session.json.tmp"
```

The authoritative files (`state.json`, `session.json`) are untouched by this cleanup.

### Baseline Re-Verification on Resume

Before re-entering the execution loop, verify the baseline is intact (per `baseline-procedure.md`):

```bash
COMPUTED=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
STORED=$(jq -r '.baseline_hash' "$SESSION_DIR/session.json")

if [ "$COMPUTED" != "$STORED" ]; then
  echo "Error: baseline hash mismatch — baseline was mutated after work-start." >&2
  exit 1
fi
```

A mismatch halts resume. Work-review Phase 1.0 Check 0 also catches this; duplicating the check in work-implementation prevents a doomed resume.

## Error Handling

Follow the **3-Strike Error Protocol** from `flywheel-conventions`:

1. **Attempt 1**: Diagnose & fix. Record approach in `state.phases[i].strikes[]`.
2. **Attempt 2**: Alternative approach (never repeat the same failing action). Record.
3. **Attempt 3**: Broader rethink — question assumptions. Record.
4. **After 3 failures**: Append to `state.error_log[]`; escalate to the user via AskUserQuestion.

The `strikes[]` array on each phase tracks attempts for that phase. `error_log[]` on the top-level state tracks cross-phase failure events.

### Specific Cases

- **Subagent failures**: Apply 3-Strike; then ask: retry / skip / abort. If skip, record the unfulfilled BCs in `state.learnings[]` so work-review Phase 4b sees the gap.
- **Test failures**: Fix before checkpointing (3-Strike applies). Never mark a phase `completed` with failing tests.
- **Missing files**: Warn during probe; clarify with the user before dispatch.
- **Schema version mismatch** (spec.json, findings.json, state.json, baseline.json with unsupported `schema_version`): Halt with the literal message `"Unsupported schema version <N>. Re-run the producing skill to regenerate."` This is P2-6; no automatic upgrade.
- **Stale active.json** (pointer refers to a deleted session): clear the pointer per the Phase 0 rescue procedure; exit asking the user to provide a slug or run `/fly:plan`.
- **Baseline hash mismatch**: halt; the user must either restore baseline.json from version control (if the repo tracked it — it's gitignored by default, so this is usually impossible) or delete the session and start over.

## Skill Exit Protocol (P2-14)

Always clear `session.json.active_skill` on exit — success or failure:

```bash
cleanup_active_skill() {
  if [ -f "$SESSION_DIR/session.json" ]; then
    jq '.active_skill = null' "$SESSION_DIR/session.json" \
      > "$SESSION_DIR/session.json.tmp"
    mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
  fi
}
trap cleanup_active_skill EXIT
```

The trap ensures cleanup runs even on script crashes. A lingering `active_skill` value makes the next invocation think another instance is running — confusing error surface.

## Common Mistakes

- **Dismissing a failure as "flaky" without a second attempt** — always burn a strike.
- **Logging the error to `state.learnings[]` instead of `state.error_log[]`** — learnings are positive insights; errors go to error_log.
- **Forgetting to clear `active_skill` on exit** — always register the cleanup trap.
- **Manually editing `state.json` to hide a failure** — K5 violation; downstream compliance catches this.
- **Retrying the same failing command without changing approach** — the 3-Strike rule prohibits this; change the approach or escalate.
