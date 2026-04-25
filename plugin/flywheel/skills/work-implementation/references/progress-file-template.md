# Progress File Template

`progress.json` records execution progress. Conforms to `flywheel/schemas/progress.schema.json`. Atomic writes via `progress.json.tmp` → `mv`.

## Location

```
.flywheel/plugin/sessions/<session-id>/progress.json
```

Scratch file for atomic writes:

```
.flywheel/plugin/sessions/<session-id>/progress.json.tmp
```

The `.tmp` file must not exist after a successful write (the `mv` consumes it). Stranded `.tmp` files from interrupted writes are safe to delete on startup.

---

## Initial state (Phase 1 fresh start)

```json
{
  "schema_version": 1,
  "mode": "plan",
  "status": "pending",
  "completed": [],
  "in_progress": null,
  "artifacts": {
    "files_modified": [],
    "commands_run": []
  },
  "error_log": []
}
```

`mode` is `"plan"` or `"fix-findings"`. `completed[]` holds chunk IDs:

- Plan mode: `phase.id` strings (e.g. `phase-1-infrastructure-and-registry`).
- Fix-findings mode: theme IDs (e.g. `theme-scaffolding-redesign`, `theme-loadmd-simplify`, `theme-polish`). NOT finding IDs — themes are clusters of findings derived by the synthesizer per `references/load-resume-procedures.md`.

---

## Mid-execution (after chunk N completes)

```json
{
  "schema_version": 1,
  "mode": "plan",
  "status": "in_progress",
  "completed": ["phase-1"],
  "in_progress": null,
  "artifacts": {
    "files_modified": ["src/foo.ts", "tests/foo.test.ts"],
    "commands_run": [
      {
        "command": "bun run test tests/foo.test.ts",
        "exit_code": 0,
        "stdout_tail": "PASS — 4 tests passed"
      }
    ]
  },
  "error_log": []
}
```

`in_progress` holds the chunk ID currently dispatched (cleared after checkpoint). `files_modified[]` and `commands_run[]` accumulate across all chunks — append, don't replace.

---

## Completed (skill exit, success path)

```json
{
  "schema_version": 1,
  "mode": "plan",
  "status": "completed",
  "completed": ["phase-1", "phase-2", "phase-3"],
  "in_progress": null,
  "artifacts": { ... },
  "error_log": []
}
```

---

## Atomic Write Procedure

```bash
printf '%s\n' "$NEW_PROGRESS" > "$SESSION_DIR/progress.json.tmp"
mv "$SESSION_DIR/progress.json.tmp" "$SESSION_DIR/progress.json"
```

**Invariants**:

- At any instant, `progress.json` either contains the pre-write or post-write content — never partial.
- `progress.json.tmp` exists only during the write window.
- On startup, if `progress.json.tmp` is present, it is scratch from an interrupted write; delete it.

---

## Status Enum

Three values: `pending` | `in_progress` | `completed`. The schema rejects synonyms.

| status | Meaning |
|---|---|
| `pending` | No chunks have completed yet (initial state). |
| `in_progress` | At least one chunk has completed; more remain. |
| `completed` | All chunks completed and verified. |

Top-level transitions:

```
pending → in_progress → completed
```

There is no per-chunk status. The presence of a chunk ID in `completed[]` IS the status.

---

## commands_run accuracy

Every entry must reflect what actually ran:

```json
{
  "command": "bun run test tests/foo.test.ts",
  "exit_code": 0,
  "stdout_tail": "PASS — 4 tests passed"
}
```

Rules:

- **`command`**: the literal command string, including redirections.
- **`exit_code`**: the actual exit status. If you don't know, do not guess — rerun or drop the entry.
- **`stdout_tail`**: optional last line or two of stdout. Don't fabricate; truncate an actual capture.

Fabricating exit codes or stdout violates the discipline that `verification` is real evidence.

---

## Recovery Process

If orchestrator compacts mid-execution (or user runs `/fly:work` with no args):

1. Phase 0 resolves `SESSION_DIR` via `active.json`.
2. Phase 1 reads `progress.json`.
3. Phase 2 resumes from the first chunk whose ID is NOT in `completed[]`.

**No work is lost.** progress.json is the single authoritative handoff surface.
