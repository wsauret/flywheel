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

## Research Workflow Architecture

The research functionality has two variants sharing a core engine:

### Plan Research Phase (step 0 of plan workflow)
- Single combined locate+analyze step
- Prompt: `buildPlanResearchPrompt()` in `src/prompts/plan/research.ts`
- Persists output as `.context.md` file alongside the plan
- Consumed by the draft step via `parseContextFile()` in `src/controller/templates.ts`
- Constrained scope: focused on the feature being planned

### Standalone /research Command
- Three-step workflow: locate → analyze → persist
- Prompts: `src/prompts/research/{locate,analyze,persist}.ts`
- Step chaining via `previousResult` (locate feeds analyze, analyze feeds persist)
- Persists comprehensive document to `docs/research/YYYY-MM-DD-<topic-slug>.md`
- Full-bodied research covering the complete research question

### Shared Core
Both variants use shared conventions from `src/prompts/conventions.ts`:
- `DOCUMENTARIAN_MODE` — map what IS, not what SHOULD BE
- `LOCATOR_ANALYZER_PATTERN` — locate WHERE, then analyze HOW
- `FILE_LINE_DISCIPLINE` — cite as file:line, not copied code
- `READ_FULLY_RULE` — read files fully to avoid hallucination
- `TOKEN_LIMITS` — per-agent token budgets (locator: 500, analyzer: 750, research output: relaxed)

Workers CAN dispatch sub-agents via the Task tool. The BLOCKING rule in research prompts enforces locate-first methodology.

## Output Parsing Differences

- **OpenCode** outputs NDJSON (one JSON object per line). Parser reads lines, finds assistant message content.
- **Claude Code** with `--print` outputs plain text (the raw response). For JSON tasks, the output should be parseable JSON directly.
