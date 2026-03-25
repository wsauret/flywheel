# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime
- **Bun** (not Node) — use `Bun.file()`, `Bun.write()`, etc.
- **SolidJS** requires `--conditions=browser` flag (handled by `bin/flywheel` wrapper)
- Unit tests do NOT need `--conditions=browser`

## Key Paths
- Handoffs: `.flywheel/handoffs/<uuid>.json`
- Logs: `.flywheel/log/*.log`
- Sessions: `.flywheel/sessions/`
- Plans: `.flywheel/plan*.md`
- State: alongside plan files as `<plan>.state.md`

## Test Infrastructure
- Framework: Bun built-in (`bun test`)
- 132 test files, 3359+ tests
- No external test dependencies
- Typecheck: `bunx tsc --noEmit`
