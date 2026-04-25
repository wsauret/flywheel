# Plugin tests

Real tmux integration tests against the local plugin. Each case spawns
`claude` in a detached tmux session, loads the plugin from
`plugin/flywheel/` via `--plugin-dir`, drives slash commands, and
asserts behavior against artifacts on disk.

There are no simulated tests. If a test exists here, it runs the real
plugin against the real Anthropic API in a real tmux session.

## Run

```bash
bash tests/integration/run.sh                 # all cases
bash tests/integration/run.sh plugin-loads    # filter by name
```

`ANTHROPIC_API_KEY` must be set. `tmux` and `claude` must be on PATH.
`bunx ajv-cli` is used for schema validation (no install needed).

## Cases

| File | What it exercises | Cost |
|------|--------------------|------|
| `cases/00-plugin-loads.test.sh` | `--plugin-dir` discovery; `/fly:*` palette entries appear | none (no model call) |
| `cases/01-fly-work-resumes.test.sh` | `work-implementation` skill against a pre-seeded session: `progress.json` lands, validates, mode is `plan` | ~1-3 min, real API |
| `cases/02-fly-plan-creates-spec.test.sh` | `plan-creation` skill end-to-end: writes `spec.json`, `session.json`, `active.json` | ~5-15 min, real API |
| `cases/03-pipeline-end-to-end.test.sh` | Full chain in one tmux session: `/fly:plan` → `/fly:work` → `/fly:review` → `/fly:work` (fix-findings). Asserts every phase's artifacts. | ~25-45 min, real API |

## Layout

- `lib/tmux.sh` — start/send/capture/wait helpers.
- `lib/sandbox.sh` — per-case temp git repo so tests never touch the
  developer's `.flywheel/plugin/` state.
- `lib/assert.sh` — `note_pass` / `note_fail` accounting.
- `run.sh` — discovers `cases/*.test.sh`, runs each, tallies results.

## Adding a case

1. Create `cases/NN-<name>.test.sh`.
2. Source `lib/{assert,sandbox,tmux}.sh`.
3. `make_sandbox`, `tmux_start`, drive the slash command, poll for the
   on-disk artifact, validate it, `finalize`.
4. Always set a `trap` that calls `tmux_kill` and `cleanup_sandbox`.
