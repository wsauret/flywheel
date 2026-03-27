# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime

- **Bun** v1.3.6+ (not Node)
- SolidJS requires `--conditions=browser` flag for TUI rendering (handled by `bin/flywheel`)
- Unit tests do NOT need the conditions flag

## Dependencies

All managed via `bun install`. No new dependencies needed for this mission.
Key libraries: zod (schemas), solid-js (reactivity), @opentui/core + @opentui/solid (TUI rendering).

## File Paths

- `.flywheel/` — runtime data directory (sessions, handoffs, logs, plans)
- `.flywheel/sessions/<id>.json` — session metadata
- `.flywheel/sessions/<id>.queue.json` — queue state (NEW)
- `.flywheel/sessions/<id>.output.json` — output block snapshots
- `.flywheel/handoffs/<invocationId>.json` — worker handoff files
- `.flywheel/log/` — rotating log files (10 max)

## Git Ignore

The parent monorepo `.gitignore` includes `flywheel-tui/.flywheel/`, so files written under `.flywheel/` are not tracked by default. To commit files in `.flywheel/` (e.g., benchmark reports), use `git add -f <path>`. Prefer placing persistent artifacts in tracked directories like `tests/e2e/` instead.
