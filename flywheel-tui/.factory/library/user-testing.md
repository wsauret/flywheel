# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

**What belongs here:** How to test the user-facing surface, tools needed, concurrency limits.

---

## Validation Surface

This mission modifies internal engine code (schemas, execution loop, evaluator, dispatcher, handoff consumers). The primary validation surfaces are:

1. **Unit tests** (`bun test`) — all schema, logic, and integration testing
2. **Type checking** (`bunx tsc --noEmit`) — type safety verification
3. **E2E via tmux** — final milestone only, tests full pipeline with TUI

## Validation Concurrency

- **Unit tests**: Bun runs tests in parallel by default. Machine has 11 cores, 36GB RAM. No concurrency limits needed.
- **E2E tmux tests**: Sequential only (one tmux session at a time). Each run takes 5-15 minutes depending on API response times.

## Tools
- `bun test` — unit and integration tests
- `bunx tsc --noEmit` — type checking
- `tmux` — E2E TUI testing (see project AGENTS.md for patterns)
- No browser testing needed (no web UI changes)
