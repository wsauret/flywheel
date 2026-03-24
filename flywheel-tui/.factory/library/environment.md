# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime
- Bun (not Node) — all commands use `bun` not `npm`/`node`
- macOS (darwin 25.3.0), 36GB RAM, 11 cores

## Engine Dependencies
- Claude Code CLI (`claude`) — must be on PATH for Claude engine
- OpenCode CLI (`opencode`) — must be on PATH for OpenCode engine
- At least one engine must be available for the dispatcher/evaluator to work

## Config
- `flywheel.toml` — main config file (TOML format)
- `FLYWHEEL_ENGINE` — override engine selection
- `FLYWHEEL_DISPATCHER_MODEL` — override dispatcher model
- `FLYWHEEL_LOG_LEVEL` — override log level (default: INFO)
