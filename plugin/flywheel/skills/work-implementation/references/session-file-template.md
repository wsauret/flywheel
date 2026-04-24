# Session File Template

`session.json` is the session-level metadata pointer. Conforms to `flywheel/schemas/session.schema.json`. Written once by plan-creation and updated on every skill entry/exit.

## File Location

```
.flywheel/plugin/sessions/<session-id>/session.json
```

And the active-session pointer:

```
.flywheel/plugin/active.json
```

The active pointer has shape `{ "schema_version": 1, "session_id": "<session-id>" }`.

---

## Initial Session (plan-creation exit)

Written by plan-creation Phase 3 Step 9:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "slug": "add-timeout-flag",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": null,
  "active_skill": null,
  "baseline_hash": null
}
```

Note: `active_skill: null` because plan-creation sets the field only while running, then clears it on exit (P2-14).

---

## At work-implementation Start (Phase 1 exit)

After Phase 1 computes the baseline hash and initializes state.json:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "slug": "add-timeout-flag",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": "2026-04-23T12:05:00Z",
  "active_skill": "work-implementation",
  "baseline_hash": "53f1cdd7f5bac32c065ad6d15265a62e42f249860d0025ecf7f25489dfab84c5"
}
```

Changes from the initial form:

- `last_checkpoint_at`: timestamp of Phase 1 completion.
- `active_skill`: `"work-implementation"` while the skill is executing.
- `baseline_hash`: SHA-256 of baseline.json (64 hex chars).

---

## Mid-Execution Checkpoint

Each phase completion updates `last_checkpoint_at`. The other fields stay stable:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "slug": "add-timeout-flag",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": "2026-04-23T12:35:00Z",
  "active_skill": "work-implementation",
  "baseline_hash": "53f1cdd7f5bac32c065ad6d15265a62e42f249860d0025ecf7f25489dfab84c5"
}
```

`baseline_hash` must never change during execution. If it does, the frozen baseline has been mutated — a protocol violation (work-review Phase 1.0 Check 0 catches this).

---

## At Skill Exit (P2-14)

On **every** exit path — success, caught error, 3-strike abort, user interruption — the skill must clear `active_skill`:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "slug": "add-timeout-flag",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": "2026-04-23T13:00:00Z",
  "active_skill": null,
  "baseline_hash": "53f1cdd7f5bac32c065ad6d15265a62e42f249860d0025ecf7f25489dfab84c5"
}
```

Implementation pattern (bash):

```bash
cleanup_active_skill() {
  if [ -f "$SESSION_DIR/session.json" ]; then
    jq '.active_skill = null' "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
    mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
  fi
}
trap cleanup_active_skill EXIT
```

The trap ensures cleanup runs even on script crashes. `session.status` stays `"active"` — the session itself is still open; just this skill is done.

---

## Session Completion

When work-implementation ships a full, successful run **and** the user chooses to ship (via `/fly:ship`), `/fly:ship` sets `session.status = "completed"`:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "slug": "add-timeout-flag",
  "status": "completed",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": "2026-04-23T13:30:00Z",
  "active_skill": null,
  "baseline_hash": "53f1cdd7f5bac32c065ad6d15265a62e42f249860d0025ecf7f25489dfab84c5"
}
```

work-implementation itself does **not** mark the session completed — that's ship's job. work-implementation's exit simply clears `active_skill`.

---

## Status Enum

Three states (per the user's state-machine overhaul memory):

| status | Meaning |
|---|---|
| `active` | Session is open, skills may run against it. |
| `paused` | Session is suspended (user interrupted; work is mid-flight). |
| `completed` | Session is done. Typically shipped via ship; could also be manually closed. |

Delete is an action, not a state — `rm -rf` the session directory to remove it. `active.json` must be cleared first (or the stale-pointer rescue runs next time).

---

## Atomic Writes

Every session.json update follows the `state.json` atomic-write pattern (see `state-file-template.md`):

```bash
jq '<update>' "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"
```

The `mv` is atomic on local POSIX filesystems. `.tmp` is scratch; stranded `.tmp` files are safe to delete.

---

## Resume Detection

When `/fly:work` is called with no arguments:

1. Read `.flywheel/plugin/active.json`.
2. Load `session.json` from the active session.
3. If `active_skill == "work-implementation"` is already set, another instance may be running — warn the user (do not auto-switch; ask to confirm).
4. Otherwise, set `active_skill = "work-implementation"` and enter Phase 1 resume path (see `load-resume-procedures.md`).

### "Carry On" Shorthand

"carry on", "continue", "resume" — all route through the same Phase 0 procedure as bare `/fly:work`:

1. Read active.json.
2. Resolve session dir (with stale-pointer rescue if needed).
3. Enter Phase 1 resume (state.json present → skip init, jump to first non-completed phase).

---

## Common Mistakes

- **Forgetting to clear `active_skill` on exit** — a lingering active_skill value makes the next invocation think another instance is running. Always use the trap-based cleanup pattern.
- **Changing `baseline_hash` mid-execution** — the hash is immutable for the lifetime of the session. Editing spec.json does not update baseline_hash (baseline is frozen; mid-execution plan changes require a fresh `/fly:work` invocation which writes a new baseline).
- **Setting `status: "completed"` in work-implementation** — that belongs to ship. work-implementation only manipulates `active_skill` and `last_checkpoint_at`.
- **Writing session.json directly (not through `.tmp`)** — use the atomic write pattern.

---

## Gitignore

`.flywheel/` is in `.gitignore` per Phase 1 of the refactor. Session state stays local; it is not committed. Once a session ships, artifacts the user wants to keep (plan summaries, post-mortems) go into `docs/`, not `.flywheel/`.
