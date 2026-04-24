# Ralph Mode: Stateless Agent Loops

**Philosophy:** Agent as stateless function. Fresh context each phase. `state.json` and `session.json` are THE source of truth.

Named after [Ralph Wiggum](https://ghuntley.com/ralph/) — a "hilariously dumb" but effective solution to context window limits.

## When Ralph Mode Activates

Any of:

1. **Plan has >5 phases** — long tasks benefit from periodic context refresh.
2. **User invokes with `--ralph` flag** — explicit request for stateless execution.
3. **Context exceeds 50% and >2 phases remain** — proactive compaction.

## Ralph Checkpoint

After each phase checkpoint in Ralph mode:

### 1. Enrich `state.json` for cold resume

Ensure the current state.json has everything a context-less agent needs:

- `phases[i].outcomes[]` — exhaustive for completed phases (what shipped).
- `phases[i].artifacts.files_created[]`, `files_modified[]` — every file touched.
- `phases[i].artifacts.commands_run[]` — every verification command with accurate exit codes.
- `phases[i].bc_satisfied[]` — the BCs this phase discharges.
- `learnings[]` — patterns discovered, gotchas, any context that saves the next phase.
- `error_log[]` — any cross-phase failure events.

Ralph state.json is **exhaustive**, not minimal. Token spend is cheap; repeating work is expensive.

### 2. Suggest Context Clear

```
Phase <id> complete. Context is <X>% full with <M> phases remaining.

Recommend clearing context and saying "carry on" for optimal performance.

Your progress is saved in:
- state: .flywheel/plugin/sessions/<id>/state.json
- session: .flywheel/plugin/sessions/<id>/session.json
- baseline: .flywheel/plugin/sessions/<id>/baseline.json (frozen; hash in session.json.baseline_hash)

Options:
1. Clear context now (Recommended) — Say "carry on" to resume
2. Continue without clearing — may degrade quality on later phases
```

### 3. If User Clears

New instance runs `/fly:work` with no args:

1. Phase 0 resolves session via `active.json`.
2. Phase 1 reads `state.json`, re-verifies baseline hash, skips init (state already exists).
3. Phase 2 enters from the first non-completed phase.

No work lost.

## State Completeness for Ralph

A Ralph-ready state.json looks like:

```json
{
  "schema_version": 1,
  "plan_id": "add-timeout-flag-2026-04-23",
  "status": "in_progress",
  "summary": "Phase 1 complete (commander flag + SIGALRM wrapper). Phase 2 pending (fallback UI).",
  "phases": [
    {
      "id": "phase-1",
      "status": "completed",
      "started_at": "2026-04-23T12:00:00Z",
      "completed_at": "2026-04-23T12:30:00Z",
      "outcomes": [
        "Added --timeout option to commander registration",
        "Wrapped dispatch in SIGALRM handler with platform guard",
        "Added Windows stderr warning when --timeout > 0"
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
            "stdout_tail": "PASS — 6 tests passed",
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
    "SIGALRM unsupported on Windows; need explicit platform guard at install site",
    "commander registers flags via .option(); -t shorthand conflicts with --tenant elsewhere, use --timeout",
    "existing CLI tests live in tests/cli/; follow sleep-wrap pattern for timeout integration tests"
  ],
  "error_log": []
}
```

The `learnings[]` array is the most-valuable field for Ralph — it carries forward the discoveries that made Phase 1 succeed, so the fresh Phase 2 agent doesn't rediscover them.

## Common Mistakes in Ralph Mode

- **Sparse learnings**: missing the "why" of a decision; next agent rediscovers it.
- **Stale outcomes**: writing `"implemented the feature"` instead of specific file/line/approach. Be concrete.
- **Forgetting to update `last_checkpoint_at`**: harmless for Ralph itself, but staleness tracking elsewhere gets wrong.
- **Not clearing `active_skill` on Ralph-triggered context clear**: the trap should handle this, but double-check; a lingering active_skill blocks re-entry.
