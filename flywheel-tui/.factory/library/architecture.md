# Architecture

Architectural decisions, patterns discovered, and design notes.

**What belongs here:** Key architectural patterns, design decisions, component relationships.

---

## Engine → Transport → Command Flow

The engine system has three layers:
1. **Engine Registry** (`src/engines/core/registry.ts`) — looks up engines by name
2. **Engine Providers** (`src/engines/providers/{name}/index.ts`) — build CLI commands via `buildCommand(options)`
3. **Transports** (dispatcher + evaluator) — spawn subprocesses using engine-built commands

Currently (pre-optimization), the transports bypass the engine registry entirely and hardcode `opencode run --format json`. The mission changes this so transports use the engine registry to build commands with appropriate flags per engine and per use-case (worker vs dispatcher/evaluator).

## Transport Interface Pattern

Both dispatcher and evaluator follow the same transport pattern:
- `IDispatcherTransport` / `IEvaluatorTransport` — DI interface
- `SubprocessTransport` — spawns engine CLI as subprocess
- `SdkTransport` (dispatcher only) — uses OpenCode SDK singleton server
- `autoDetectTransport()` — selects best available transport

## Output Parsing Differences

- **OpenCode** outputs NDJSON (one JSON object per line). Parser reads lines, finds assistant message content.
- **Claude Code** with `--print` outputs plain text (the raw response). For JSON tasks, the output should be parseable JSON directly.
