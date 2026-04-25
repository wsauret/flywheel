# Recovery & Error Handling

## Recovery

If the user clears context mid-execution (or the orchestrator compacts):

1. User says "carry on" or runs `/fly:work` with no arguments.
2. Phase 0 resolves the active session via `.flywheel/plugin/active.json` (see `session-detection.md` for the full procedure).
3. Phase 1 reads `progress.json` from the session directory.
4. Resume entry point: the first chunk whose ID is not in `progress.completed[]`.

**No work is lost.** `progress.json` is the authoritative recovery surface; `session.json` is the session-level pointer. Both are written atomically (see `checkpoint-procedure.md`) so a partial write never corrupts resume.

### Cleanup of Stranded `.tmp` Files

On startup, if `progress.json.tmp` or `session.json.tmp` exist, they are scratch from an interrupted write:

```bash
rm -f "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/session.json.tmp"
```

The authoritative files (`progress.json`, `session.json`) are untouched by this cleanup.

## Error Handling

Follow the **3-Strike Error Protocol** from `flywheel-conventions`:

1. **Attempt 1**: Diagnose & fix.
2. **Attempt 2**: Alternative approach (never repeat the same failing action).
3. **Attempt 3**: Broader rethink — question assumptions.
4. **After 3 failures**: Append to `progress.error_log[]`; escalate to the user via AskUserQuestion.

`progress.error_log[]` tracks cross-chunk failure events. The chunk being attempted stays in `progress.in_progress` (not yet appended to `completed[]`) until verification passes.

### Specific Cases

- **Subagent failures**: Apply 3-Strike; then ask: retry / skip / abort. If skip, append a note to `progress.error_log[]` so work-review can surface the gap.
- **Test failures**: Fix before checkpointing (3-Strike applies). Never append a chunk ID to `completed[]` with failing tests.
- **Missing files**: Warn during probe; clarify with the user before dispatch.
- **Schema version mismatch** (spec.json, review.findings.json, progress.json with unsupported `schema_version`): Halt with the literal message `"Unsupported schema version <N>. Re-run the producing skill to regenerate."`
- **Stale active.json** (pointer refers to a deleted session): clear the pointer per the Phase 0 rescue procedure; exit asking the user to provide a slug or run `/fly:plan`.

## Skill Exit Protocol

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

The trap ensures cleanup runs even on script crashes. A lingering `active_skill` value makes the next invocation think another instance is running.

## Common Mistakes

- **Dismissing a failure as "flaky" without a second attempt** — always burn a strike.
- **Forgetting to clear `active_skill` on exit** — always register the cleanup trap.
- **Manually editing `progress.json` to hide a failure** — breaks the verification discipline; downstream review surfaces the discrepancy.
- **Retrying the same failing command without changing approach** — the 3-Strike rule prohibits this; change the approach or escalate.
