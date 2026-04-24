# State File Template

`state.json` is the authoritative record of execution progress. Conforms to `flywheel/schemas/state.schema.json`. Written atomically on every checkpoint.

## File Location

```
.flywheel/plugin/sessions/<session-id>/state.json
```

Scratch file for atomic writes lives next to it:

```
.flywheel/plugin/sessions/<session-id>/state.json.tmp
```

The `.tmp` file must not exist after a successful write (the `mv` consumes it). Stranded `.tmp` files from interrupted writes are safe to delete on startup.

---

## Initial State (Phase 1 exit)

Written once by work-implementation Phase 1 after loading the TaskList:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "status": "pending",
  "summary": "Phase 1 load complete. No phases executed yet.",
  "phases": [
    {
      "id": "phase-1",
      "status": "pending",
      "started_at": null,
      "completed_at": null,
      "outcomes": [],
      "strikes": [],
      "bc_satisfied": [],
      "artifacts": {
        "files_created": [],
        "files_modified": [],
        "commands_run": []
      }
    }
  ],
  "learnings": [],
  "error_log": []
}
```

One phase stub per `TaskList.phases[].id`, in order.

---

## Mid-Execution State (Phase 2 checkpoint)

After phase-1 completion, state.json looks like:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "status": "in_progress",
  "summary": "Phase 1 complete. Phase 2 pending.",
  "phases": [
    {
      "id": "phase-1",
      "status": "completed",
      "started_at": "2026-04-23T12:00:00Z",
      "completed_at": "2026-04-23T12:30:00Z",
      "outcomes": [
        "Added --timeout flag to commander",
        "Wired SIGALRM handler with Windows guard and stderr warning"
      ],
      "strikes": [],
      "bc_satisfied": ["BC-CLI-001", "BC-CLI-002"],
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
    },
    {
      "id": "phase-2",
      "status": "pending",
      "started_at": null,
      "completed_at": null,
      "outcomes": [],
      "strikes": [],
      "bc_satisfied": [],
      "artifacts": {
        "files_created": [],
        "files_modified": [],
        "commands_run": []
      }
    }
  ],
  "learnings": [
    "SIGALRM install must be platform-guarded; Windows shim warns on stderr."
  ],
  "error_log": []
}
```

---

## Completed State (skill exit, success path)

When every phase's `status == "completed"`, set the top-level `status: "completed"` and the summary line:

```json
{
  "schema_version": 1,
  "session_id": "add-timeout-flag-2026-04-23",
  "status": "completed",
  "summary": "All 2 phases executed and verified. Ready for /fly:review or /fly:ship.",
  "phases": [ ... ],
  "learnings": [ ... ],
  "error_log": []
}
```

---

## Atomic Write Procedure (P1-D)

Every state.json write follows this sequence:

```bash
# 1. Serialize the updated state to a .tmp file.
printf '%s\n' "$NEW_STATE_JSON" > "$SESSION_DIR/state.json.tmp"

# 2. Rename over the existing state.json. mv is atomic on local POSIX FS.
mv "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/state.json"
```

**Invariants**:

- At any instant, `state.json` either contains the pre-write or post-write content — never partial.
- `state.json.tmp` exists only during the (very brief) write window.
- On startup, if `state.json.tmp` is present, it is scratch from an interrupted write; delete it.

`tests/work/atomic-write.test.sh` exercises this pattern against temp directories.

---

## Status Enum

**BLOCKING:** exactly four values. Do NOT use synonyms like `not_started`, `active`, `done`, `failed` — the schema rejects them.

| status | Meaning |
|---|---|
| `pending` | Phase has not begun (initial state). |
| `in_progress` | Phase is actively executing (subagent dispatched; waiting on return). |
| `paused` | Phase is halted awaiting user input (manual verification, 3-strike escalation). |
| `completed` | Phase verification passed. |

Status transitions:

```
pending → in_progress → completed
                ↓
             paused → in_progress (resume) or paused (persisted across context clear)
```

The top-level `state.status` follows the same enum. `paused` at the top level means the **whole** execution is suspended (e.g. waiting on the user); individual phases may already be `completed` while the top-level is `paused`.

---

## `commands_run` Accuracy (K5 discipline)

Every entry in `artifacts.commands_run[]` must reflect what actually ran:

```json
{
  "command": "bun run test tests/cli/timeout.test.ts",
  "exit_code": 0,
  "stdout_tail": "PASS — 4 tests passed",
  "re_executable": true
}
```

Rules:

- **`command`**: the literal command string, including redirections if relevant.
- **`exit_code`**: the actual exit status. If you don't know, do not guess — rerun the command or drop the entry.
- **`stdout_tail`**: the last line or two of stdout. Useful as human-readable ground truth. Do not fabricate; truncate an actual capture.
- **`re_executable`**: `true` unless the command is irreversible (e.g. `git commit`, DB migration, `rm`). Retained in the schema as a capability hint; work-review's commands re-execution check was CUT per D3, so this field is currently not consumed by any check, but is kept for future reintroduction.

Fabricating a zero exit code or inventing stdout is a K5 violation. Phase 4b (work-review) does not re-run commands, so integrity here relies on the B5 anti-pattern ("don't declare done without running tests") in work-implementation.

---

## Recovery Process

If orchestrator compacts mid-execution (or user runs `/fly:work` with no args):

1. Session Phase 0 resolves `SESSION_DIR` via `active.json`.
2. Phase 1 reads `state.json`.
3. Phase 2 resumes from the first `phase` whose `status != "completed"`.
4. Key decisions are carried forward via `learnings[]` in state.json.

**No work is lost.** The state.json + baseline.json pair is the authoritative handoff surface.

---

## Common Mistakes

- **Writing directly to `state.json` (not through `.tmp`)** — a kill mid-write leaves a half-valid state file. Use the atomic-write pattern.
- **Leaving `strikes[]` empty when errors actually happened** — record every 3-strike attempt with the approach tried and why it failed.
- **Guessing `exit_code` values** — if the command didn't run, don't add an entry; if it ran, capture the real code.
- **Updating `bc_satisfied[]` before verification passes** — only add BCs after the phase's `verification` command exits 0.
- **Using `plan_id` instead of `session_id`** — state.json lives in a session directory; the canonical identifier is `session_id` (matches `session.json.session_id` and the directory name). The schema requires it.
- **Duplicating `baseline_hash` into state.json** — the hash lives in `session.json.baseline_hash` only. One source of truth; work-review reads it from there.
- **Inventing status values like `"not_started"`, `"active"`, or `"done"`** — the enum is exactly `pending | in_progress | paused | completed`. Nothing else validates.
