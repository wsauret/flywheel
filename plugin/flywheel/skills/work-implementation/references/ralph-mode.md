# Ralph Mode: Stateless Agent Loops

**Philosophy:** Agent as stateless function. Fresh context each chunk. `progress.json` and `session.json` are THE source of truth.

Named after [Ralph Wiggum](https://ghuntley.com/ralph/) — a "hilariously dumb" but effective solution to context window limits.

## When Ralph Mode Activates

Any of:

1. **Spec has >5 phases** (plan mode) or **review has >5 file-groups** (fix-findings mode) — long tasks benefit from periodic context refresh.
2. **User invokes with `--ralph` flag** — explicit request for stateless execution.
3. **Context exceeds 50% and >2 chunks remain** — proactive compaction.

## Ralph Checkpoint

After each chunk checkpoint in Ralph mode:

### 1. Ensure progress.json carries forward what the next agent needs

`progress.json` already records `completed[]` and `artifacts`. For Ralph, also append decisions/discoveries to `error_log` (or extend with a `learnings[]` field if the discovery isn't an error). The next agent reads progress.json cold and needs:

- `completed[]` — which chunks are done.
- `artifacts.files_modified[]` — every file touched.
- `artifacts.commands_run[]` — every verification command with accurate exit codes.

### 2. Suggest Context Clear

```
Chunk <id> complete. Context is <X>% full with <M> chunks remaining.

Recommend clearing context and saying "carry on" for optimal performance.

Your progress is saved in:
- progress: .flywheel/plugin/sessions/<id>/progress.json
- session: .flywheel/plugin/sessions/<id>/session.json
- spec or findings: .flywheel/plugin/sessions/<id>/spec.json or review.findings.json

Options:
1. Clear context now (Recommended) — Say "carry on" to resume
2. Continue without clearing — may degrade quality on later chunks
```

### 3. If User Clears

New instance runs `/fly:work` with no args:

1. Phase 0 resolves session via `active.json`.
2. Phase 1 reads `progress.json`, skips init (progress already exists).
3. Phase 2 enters from the first chunk whose ID is NOT in `completed[]`.

No work lost.

## Common Mistakes in Ralph Mode

- **Stale or vague artifacts**: writing `"implemented the feature"` instead of concrete file/command lines. Be specific so the cold-resume agent doesn't rediscover.
- **Forgetting to update `last_checkpoint_at`**: harmless for Ralph itself, but staleness tracking elsewhere gets wrong.
- **Not clearing `active_skill` on Ralph-triggered context clear**: the trap should handle this, but double-check; a lingering active_skill blocks re-entry.
