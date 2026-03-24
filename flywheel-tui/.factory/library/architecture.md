# Architecture

Architectural decisions, patterns discovered, and design notes.

**What belongs here:** Key architectural patterns, design decisions, component relationships.

---

## Engine → Transport → Command Flow

The engine system has three layers:
1. **Engine Registry** (`src/engines/core/registry.ts`) — looks up engines by name
2. **Engine Providers** (`src/engines/providers/{name}/index.ts`) — build CLI commands via `buildCommand(options)`
3. **Transports** (dispatcher + evaluator) — spawn subprocesses using engine-built commands

Both the dispatcher and evaluator transports now use the engine registry to build commands with appropriate flags per engine. Both are wired into the production execution pipeline: the dispatcher via `autoDetectTransport()` and the evaluator via `createEvaluatorTransport()` in `src/evaluator/create-transport.ts`. The evaluator transport is threaded through `StageLoopOptions` → `ExecutionLoop` → phase execution. Both transports support Claude Code and OpenCode engines with per-engine optimization flags (tools disabled, fast model, no session persistence for Claude; model flag for OpenCode). Both transports use the shared `extractTextFromNDJSON()` utility from `src/utils/ndjson-text-extractor.ts`.

### Engine-specific system prompt handling

- **Claude Code**: System prompt is passed via `--system-prompt` flag (enables prompt caching). The engine's `buildDispatcherCommand()` handles this.
- **OpenCode**: System prompt is **not** handled by `buildDispatcherCommand()` — it is silently ignored. The SubprocessTransport manually prepends the system prompt to stdin content. This is by design since OpenCode doesn't have a separate system prompt CLI flag.

### OpenCode SDK API surface

The `@opencode-ai/sdk` `SessionPromptData.body` supports:
- `model: { providerID: string; modelID: string }` — override the model for a session prompt
- `tools: Record<string, boolean>` — enable/disable specific tools (not yet used in production)

## Transport Interface Pattern

Both dispatcher and evaluator follow the same transport pattern:
- `IDispatcherTransport` / `IEvaluatorTransport` — DI interface
- `SubprocessTransport` — spawns engine CLI as subprocess
- `SdkTransport` (dispatcher only) — uses OpenCode SDK singleton server
- `autoDetectTransport()` — selects best available transport

## Output Parsing Differences

- **OpenCode** outputs NDJSON (one JSON object per line). Parser reads lines, finds assistant message content.
- **Claude Code** with `--print` outputs plain text (the raw response). For JSON tasks, the output should be parseable JSON directly.
