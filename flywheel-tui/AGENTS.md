# Flywheel CLI — Agent Instructions

## Project overview

Flywheel CLI is a terminal UI application that executes workflow plans. It spawns AI worker processes (Claude or OpenCode), runs plan phases sequentially, and provides a rich TUI built with OpenTUI + SolidJS.

**Runtime:** Bun (not Node)
**TUI framework:** OpenTUI (`@opentui/core` + `@opentui/solid`) with SolidJS signals
**Config format:** TOML (`flywheel.toml`), not YAML
**Important:** SolidJS must resolve with the `"browser"` export condition. The `bin/flywheel` wrapper handles this with `bun --conditions=browser`.

## Running unit tests

```bash
cd flywheel-tui
bun test                   # all tests
bun test tests/foo.test.ts # single file
```

Unit tests do NOT render OpenTUI components, so they don't need the `--conditions=browser` flag.

## E2E pipeline test

A full TUI-level end-to-end test lives at `tests/e2e/tui-pipeline.sh`. It starts the TUI in tmux, sends a `/start` command, and monitors state transitions through plan → work → review. This test uses real API calls.

```bash
# Run the e2e pipeline test (takes several minutes, requires API key)
./tests/e2e/tui-pipeline.sh

# Run and attach to watch it live
./tests/e2e/tui-pipeline.sh --attach
```

The script starts flywheel in tmux, sends `/start`, and polls the screen every 10s. It passes if `work` starts (plan→work chaining works), fails on stall/crash/timeout (15 min). Logs to `tests/e2e/tui-pipeline.log`. Use after modifying pipeline, stage runner, event bus, or workflow chaining logic.

## Testing the TUI with tmux

Always do extensive UAT after any change. The TUI is a full-screen interactive application — use tmux to run it in a detached session, send keystrokes, and read screen output.

**When someone asks you to "test the TUI", "verify the UI works", or "make sure your changes work in the actual app", this is what they mean.** Do not skip this step!

### Setup and primitives

tmux must be installed (`brew install tmux` on macOS). A test plan is at `tests/fixtures/two-phase-plan.md`.

```bash
# Start (kill stale session first)
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 120 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2

# Read screen (what the user sees, minus colors)
tmux capture-pane -t flywheel -p              # full screen
tmux capture-pane -t flywheel -p | tail -5    # prompt area only

# Send text
tmux send-keys -t flywheel 'some text' Enter

# Special keys
tmux send-keys -t flywheel Escape      # Escape
tmux send-keys -t flywheel Tab         # Tab
tmux send-keys -t flywheel Up          # Arrow up / Down / Left / Right
tmux send-keys -t flywheel BSpace      # Backspace
tmux send-keys -t flywheel C-u         # Ctrl+U (clear input line)
tmux send-keys -t flywheel C-c         # Ctrl+C (stop/exit)
tmux send-keys -t flywheel C-s         # Ctrl+S (skip phase)
tmux send-keys -t flywheel C-t         # Ctrl+T (toggle theme)

# Timing: sleep 0.5 for keystrokes, 1-2 for state transitions, 3-5 for process starts

# Clean up
tmux kill-session -t flywheel 2>/dev/null
```

If the TUI exits or crashes, the tmux session is destroyed. Just re-run the setup commands.

### Common test sequences

**1. Verify idle screen:**

```bash
tmux capture-pane -t flywheel -p
# Expect: branding header, ASCII art, starter chooser, session sidebar (if >= 90 cols), prompt
```

**2. Start a pipeline with `/start` (recommended E2E UAT):**

```bash
# With description — skips description question, shows mode picker directly
tmux send-keys -t flywheel '/start add a hello world endpoint' Enter
sleep 2
tmux capture-pane -t flywheel -p
# Expect: QuestionPrompt with 4 pipeline mode options:
#   1. Just Plan  2. Plan + Work  3. Plan + Work + Review (recommended)  4. Full Pipeline

tmux send-keys -t flywheel '3'
sleep 3
tmux capture-pane -t flywheel -p
# Expect: working view with pipeline running (plan -> work -> review in telemetry bar)
```

Without a description, `/start` first asks "What do you want to build?" as a direct text input — just type and press Enter.

**3. Start work with a test plan (direct `/work`):**

```bash
tmux send-keys -t flywheel '/work tests/fixtures/two-phase-plan.md' Enter
sleep 3
tmux capture-pane -t flywheel -p
# Expect: working view — sidebar (left), output window (center),
#         workflow panel (right, if >= 120 cols), prompt line (bottom), status footer
```

**4. Stop a running workflow:**

```bash
tmux send-keys -t flywheel Escape   # first Esc shows hint
sleep 1
tmux send-keys -t flywheel Escape   # second Esc stops
sleep 2
tmux capture-pane -t flywheel -p    # should show completed/idle view
```

**5. Return to idle / test sidebar:**

```bash
tmux send-keys -t flywheel '/new' Enter
sleep 1
tmux capture-pane -t flywheel -p
# Expect: idle screen; sidebar lists previous session with its lifecycle state
```

**6. Test responsive layout (narrow terminal):**

```bash
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 80 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2
tmux capture-pane -t flywheel -p
# Expect: sidebar hidden (< 90 cols), panel hidden (< 120 cols)
```

### What to verify after making TUI changes

After modifying any file under `src/tui/`, always:

1. Run `bun test` to ensure unit tests pass
2. Start the TUI in tmux
3. Verify the idle screen renders correctly (branding, sidebar, starter chooser, prompt)
4. Test the specific feature you changed
5. Test adjacent interactions (e.g., if you changed a modal, also test opening and closing it, keyboard shortcuts within it, and that the view behind it restores correctly)
6. **Check the log file for errors** — after the test, read `.flywheel/log/` for the most recent `.log` file and look for `ERROR` or `WARN` lines. Any errors there indicate problems even if the TUI appeared to work visually.
7. Clean up the tmux session

```bash
# After running a tmux TUI test, check for logged errors:
ls -t .flywheel/log/*.log | head -1 | xargs cat | grep -E '^(ERROR|WARN)'
```

## Architecture quick reference

### Source tree (`src/`)

```
src/
├── cli/           # CLI entry point, arg parsing
├── config/        # Config loading (TOML), schema, defaults
├── controller/    # Work controller, pipeline, phase execution, approval
├── dispatcher/    # Prompt assembly, CLI/SDK transports, auto-detection
├── engines/       # Engine registry, Claude + OpenCode providers
├── evaluator/     # Phase output evaluation
├── events/        # EventBus, FlywheelEmitter, 29 event types
├── memory/        # Context extraction and retrieval
├── prompts/       # Per-workflow prompt templates + conventions
├── schemas/       # Zod schemas (session, workflow, execution, output, etc.)
├── session/       # Session state machine, persistence, worktree, cost tracker
├── state/         # Plan state file (.state.md) lock, reader, writer
├── telemetry/     # Telemetry metrics (workflow timing/counts)
├── tui/           # TUI shell, components, adapters, routes, shared context
├── types/         # Shared type definitions
├── utils/         # Atomic write, debounced writer, retry, file-based logger
├── worker/        # Process spawning, NDJSON parsing, rate limiting, timeouts
└── workflows/     # Per-workflow runners (plan, work, review, ship, debug, research)
```

### Core layers

| Layer | Key files |
|-------|-----------|
| CLI entry | `src/cli/index.ts`, `src/cli/args.ts` |
| TUI launcher | `src/tui/launcher.ts`, `src/tui/app.tsx` |
| Shell (mode routing) | `src/tui/components/flywheel-shell.tsx` |
| Shell modes (state machine) | `src/tui/components/shell-modes.ts` |
| WorkController | `src/controller/work.ts` |
| Engine registry | `src/engines/core/registry.ts`, `src/engines/core/types.ts` |

### Logging

File-based logger adapted from OpenCode. **Never use `console.error`/`console.warn`/`console.debug` in production code** — they write to stderr and corrupt the TUI display. Use the `Log` module instead.

| Key file | Purpose |
|----------|---------|
| `src/utils/log.ts` | `Log` namespace: file-based logger |
| `src/cli/index.ts` | `Log.init()` call at startup |

**Log directory:** `.flywheel/log/` (relative to project cwd)
**Log format:** `LEVEL TIMESTAMP +DELTAms key=value ... message`
**Rotation:** Keeps the 10 newest `.log` files, deletes older ones at startup.

Usage:
```ts
import { Log } from "../utils/log"
const log = Log.create({ service: "session.manager" })

log.info("recovered stale session", { session: id, to: "work:paused" })
log.error("state transition failed", { error: err instanceof Error ? err : String(err) })
log.debug("init", { isDev: true })

// Timed operations:
const timer = log.time("pipeline execution")
// ... work ...
timer.stop()  // logs duration automatically
```

Service tag convention (dot-separated namespaces): `"shell"`, `"session.manager"`, `"event-bus"`, `"dispatcher"`, `"launcher"`, `"exit"`, `"plan-hook"`, `"review-hook"`.

**CLI flags:**
- `--print-logs` — send log output to stderr instead of file (for debugging outside the TUI)
- `FLYWHEEL_LOG_LEVEL=DEBUG` — override the log level (default: `INFO`)

### Event system

| Layer | Key files |
|-------|-----------|
| Event bus | `src/events/event-bus.ts` |
| Event types | `src/events/types.ts` |

The `EventBus` is a synchronous pub/sub system. `FlywheelEmitter` is a typed facade with named methods (`workflowStarted`, `phaseStarted`, `workerOutput`, etc.) wrapping `bus.emit()`. 29 event types across namespaces: `workflow:*`, `phase:*`, `step:*`, `dispatcher:*`, `evaluator:*`, `worker:*`, `approval:*`, `question:*`, `pipeline:*`.

### Pipeline and execution

| Layer | Key files |
|-------|-----------|
| Pipeline orchestration | `src/controller/workflow-pipeline.ts` |
| Phase execution | `src/controller/phase-executor.ts` |
| Execution loop | `src/controller/execution-loop.ts` |
| Dispatcher orchestrator | `src/controller/dispatcher-orchestrator.ts` |
| Approval handling | `src/controller/approval-handler.ts`, `src/controller/ui-approval-handler.ts` |
| Question service | `src/controller/question-service.ts` |

`WorkflowPipeline` sequences stages (each a `WorkflowType`) with optional gates between them. Gate decisions: `"continue"`, `"stop"`, `"pause"`, `"dismissed"`, `"aborted"`. `ExecutionLoop` iterates phases within a stage, delegating to `PhaseExecutor` which spawns workers with retry (exponential backoff, base 1s, max 120s, jitter).

Six workflow types: `"work" | "plan" | "review" | "ship" | "debug" | "research"`.

### Dispatcher and evaluator

| Layer | Key files |
|-------|-----------|
| Dispatcher | `src/dispatcher/assemble.ts`, `src/dispatcher/auto-detect.ts`, `src/dispatcher/cli-transport.ts`, `src/dispatcher/sdk-transport.ts` |
| Evaluator | `src/evaluator/invoke.ts`, `src/evaluator/cli-transport.ts` |

The dispatcher assembles prompts and routes them to workers via CLI or SDK transports. The evaluator assesses phase outputs for quality/completeness.

### Workflow runners and prompts

Each workflow type has a runner in `src/workflows/` (plan, review, ship, debug, research) and prompt templates in `src/prompts/<type>/`. The prompt builder (`src/workflows/prompt-builder.ts`) and output extractors (`plan-output-extractor.ts`, `review-output-extractor.ts`) handle assembly and parsing. Shared conventions in `src/prompts/conventions.ts`.

### Engine system

Registry: `src/engines/core/registry.ts`. Types: `src/engines/core/types.ts`. Two engines registered by default:
- **claude** — binary `"claude"`, defaultModel `"opus"`, order 2
- **opencode** — binary `"opencode"`, defaultModel `"anthropic/claude-opus-4-6"`, order 1

### Session management

State machine (`src/session/state-machine.ts`), persistence (`src/session/persistence.ts`), manager (`src/session/manager.ts`), cost tracker (`src/session/cost-tracker.ts`), worktree manager (`src/session/worktree-manager.ts`), output persistence (`src/session/output-persistence.ts`). Schema: `src/schemas/session.ts`.

Plan state is tracked in `.state.md` files alongside plan files via `src/state/` (reader, writer, lock).

### TUI components

Shell-level components live in `src/tui/components/`. Most follow a `<name>.tsx` + `<name>-logic.ts` pattern separating rendering from derivation.

| Layer | Key files |
|-------|-----------|
| Session sidebar | `session-sidebar.tsx`, `sidebar-logic.ts` |
| Starter chooser | `starter-chooser.tsx` |
| Plan confirmation | `plan-confirmation.tsx`, `plan-confirmation-logic.ts` |
| Workflow panel | `workflow-panel.tsx`, `workflow-panel-logic.ts` |
| Action dispatcher | `action-dispatcher.ts` |
| Prompt (unified) | `unified-prompt.tsx`, `unified-prompt-logic.ts` |
| Question prompt | `question-prompt.tsx`, `question-prompt-logic.ts` |
| Start command | `start-command.ts` |
| Shell pipeline | `shell-pipeline.ts` |
| Session orchestrator | `session-orchestrator.ts` |
| Commands | `src/tui/config/commands.ts` |

### Structured output pipeline

```
worker stdout → NDJSONParser (line buffering + JSON parsing)
  → StructuredEventParser (engine routing + format normalization)
    → SubagentTraceParser (agent lifecycle tracking)
    → StructuredOutputBuilder (block accumulation)
      → setOutputBlocks() (batched flush → SolidJS reactivity)
```

System messages and stderr also go through the builder as text blocks. Raw mode bypasses the pipeline entirely.

| Layer | Key files |
|-------|-----------|
| Adapter factory | `src/tui/adapters/factory.ts` |
| Base adapter | `src/tui/adapters/base.ts` |
| OpenTUI adapter | `src/tui/adapters/opentui.ts` |
| Headless adapter | `src/tui/adapters/headless.ts` |
| NDJSON parser | `src/worker/ndjson-parser.ts` |
| Structured event parser | `src/tui/adapters/structured-event-parser.ts` |
| Subagent trace parser | `src/tui/adapters/subagent-tracing/parser.ts` |
| Structured output builder | `src/tui/adapters/structured-output-builder.ts` |
| Block renderer | `src/tui/routes/work/components/output-blocks/block-renderer.tsx` |
| Block types | `src/tui/routes/work/state/types.ts` (TextBlock, ToolBlock, AgentBlock, ContextGroupBlock, SystemBlock) |

The adapter factory (`createAutoAdapter`) selects `OpenTUIAdapter` when `process.stdout.isTTY`, otherwise `HeadlessAdapter`. Both implement `IWorkflowUI` via `BaseUIAdapter`.

### Work view

Work view lives under `src/tui/routes/work/`. Key entry: `components/work-shell.tsx`. Output blocks in `components/output-blocks/` (text, tool, agent, context-group, system). Modals in `components/modals/` (approval-gate, error-modal, stop-modal, quit-confirm-modal). State store in `context/ui-state/` (store, provider, types, actions/).

| Layer | Key files |
|-------|-----------|
| Keyboard handling | `hooks/use-work-keyboard.ts` |
| Status footer | `components/status-footer.tsx` |
| Telemetry bar | `components/telemetry-bar.tsx` |
| Output window | `components/output-window.tsx` |

### Shared context and utilities

Provider nesting order (outermost → innermost): `ExitProvider → ToastProvider → ThemeProvider → DialogProvider → SessionProvider → FlywheelShell`.

| Layer | Key files |
|-------|-----------|
| Exit provider | `src/tui/exit.ts` |
| Session provider | `src/tui/shared/context/session.tsx` |
| Theme provider | `src/tui/shared/context/theme.tsx` |
| Toast provider | `src/tui/shared/context/toast.tsx` |
| Dialog provider | `src/tui/shared/context/dialog.tsx` |
| Escape logic | `src/tui/utils/escape-handler.ts` |
| Command parser | `src/tui/utils/command-parser.ts` |
| Modal keyboard hook | `src/tui/shared/hooks/use-modal-keyboard.ts` |

## Execution data flow

```
User input → FlywheelShell.handlePromptInput()
  → parseCommand() → handleCommand()
    → ActionDispatcher routes to launchWorkWithPipeline() / launchGenericWithPipeline()
      → creates EventBus + WorkflowPipeline + QuestionService
        → WorkflowPipeline.run() → StageRunner per stage
          → ExecutionLoop.run() → PhaseExecutor.execute()
            → engine.buildCommand() → spawner.spawn() → worker process
              → emitter.workerOutput() → EventBus.emit()
                → BaseUIAdapter.handleEvent() → structured output pipeline → TUI render
```

## TUI states

### View modes (shell)

The shell has four view modes defined as `AppState` in `src/tui/components/shell-modes.ts:27`:

```ts
type AppState = "idle" | "working" | "completed" | "importing"
```

- **idle** -- Initial state. Shows starter chooser (recent sessions, commands), session sidebar (left), branding header.
- **working** -- Active workflow. Shows session sidebar (left), output window (center), workflow panel (right), prompt line (bottom), status footer.
- **completed** -- Workflow finished/stopped/failed. Shows summary, option to re-run or start new session.
- **importing** -- Plan import flow. Shows plan confirmation UI for reviewing and approving an imported plan.

Transitions: `idle → working` (start), `idle → importing` (plan import), `working → completed` (ends/stops/error), `completed → working` (re-run), `completed → idle` (`/new`), `importing → idle` (cancel), `importing → working` (confirm).

Escape: `idle` exits TUI (or QuitModal if background sessions), `working` uses double-Esc (first shows hint, second stops), `completed` returns to idle, `importing` cancels. Ctrl+C: `idle`/`importing` exit, `working` stops workflow, `completed` returns to idle.

The sidebar and panel columns collapse responsively: sidebar hides below 90 columns, panel hides below 120 columns. Sidebar width: 25 cols, panel width: 38 cols.

### Prompt modes

The unified prompt has four modes resolved from `AppState` and approval state:

| Mode | Placeholder | When |
|------|-------------|------|
| `command` | "Type a / command..." | Idle, completed |
| `active` | "Enter to continue, or type to steer..." | Working with approval pending |
| `passive` | "Phase executing..." | Working, no approval |
| `disabled` | "Import in progress..." | Importing |

### Session lifecycle states

Sessions have 11 lifecycle states managed by the state machine in `src/session/state-machine.ts`:

```
new -> plan:draft | plan:imported
plan:draft -> plan:imported | plan:needs-fix | trashed
plan:imported -> plan:approved | plan:needs-fix | trashed
plan:approved -> work:active | trashed
plan:needs-fix -> plan:imported | plan:approved | trashed
work:active -> work:paused | work:review | completed | trashed
work:paused -> work:active | trashed | archived
work:review -> work:active | completed | trashed
completed -> archived | trashed | work:active
archived -> (terminal)
trashed -> (terminal)
```

Common paths:
- **Happy path:** `new -> plan:imported -> plan:approved -> work:active -> work:review -> completed -> archived`
- **Draft path:** `new -> plan:draft -> plan:needs-fix -> plan:imported -> plan:approved -> work:active -> completed`
- **Pause/resume:** `work:active -> work:paused -> work:active -> completed`
- **Re-open:** `completed -> work:active -> completed -> archived`

Only `work:paused` is considered resumable (`isResumable()` returns true).

## Slash commands

Eleven commands are recognized. Six correspond to executable `WorkflowType`s; five are UI-only.

| Command | Description | WorkflowType? | Arg |
|---------|-------------|:---:|-----|
| `/start` | Guided workflow launcher (recommended entry point) | no | `description` |
| `/work` | Run a plan (paste path or pick from recent) | yes | `planPath` |
| `/plan` | Create a new plan from description | yes | `description` |
| `/review` | Review current changes | yes | — |
| `/ship` | Commit, PR, and compound learnings | yes | — |
| `/debug` | Debug a failing test or issue | yes | `description` |
| `/research` | Research a topic in the codebase | yes | `topic` |
| `/config` | Edit flywheel.toml | no | — |
| `/help` | Show available commands | no | — |
| `/new` | Start fresh from idle screen | no | — |
| `/exit` | Exit flywheel | no | — |

**Prefer `/start`** for launching workflows. It provides a guided question flow: collects a description (if not provided as an argument), lets you pick a pipeline mode (plan-only, plan+work, plan+work+review, full), then starts the appropriate pipeline. Use `/start <description>` to skip the description question and go straight to the mode picker.

Any input starting with `/` that doesn't match one of these is treated as a file path (not as an unknown command error).

The home screen help bar shows a subset: `/start`, `/work`, `/plan`, `/review`, `/ship`.

## Configuration

Config is loaded from TOML (`flywheel.toml`) with env var overrides. Schema in `src/config/loader.ts`.

| Field | Type | Default | Env var |
|-------|------|---------|---------|
| `engine` | string | `"claude"` | `FLYWHEEL_ENGINE` |
| `model` | string? | — | `FLYWHEEL_MODEL` |
| `dispatcher.model` | string? | — | `FLYWHEEL_DISPATCHER_MODEL` |
| `worker.model` | string? | — | `FLYWHEEL_WORKER_MODEL` |
| `max_retries` | int 0-10 | `3` | `FLYWHEEL_MAX_RETRIES` |
| `timeout_minutes` | int 1-120 | `60` | `FLYWHEEL_TIMEOUT_MINUTES` |
| `project_cwd` | string? | — | `FLYWHEEL_PROJECT_CWD` |
| `skip_approval_gates` | bool | `false` | `FLYWHEEL_SKIP_APPROVAL_GATES` |
| `use_dispatcher` | bool | `true` | `FLYWHEEL_USE_DISPATCHER` |
| `skip_evaluation` | bool | `false` | — |
| `interactive_consolidation` | bool | `false` | `FLYWHEEL_INTERACTIVE_CONSOLIDATION` |
| `auto_ship` | bool | `false` | `FLYWHEEL_AUTO_SHIP` |
| `auto_chain` | bool | `true` | `FLYWHEEL_AUTO_CHAIN` |
| `worktree.enabled` | bool | `false` | `FLYWHEEL_WORKTREE_ENABLED` |
| `worktree.auto_remove` | bool | `false` | `FLYWHEEL_WORKTREE_AUTO_REMOVE` |
| `worktree.grace_period_ms` | int ≥0 | `300000` | — |

Precedence: env vars > config file > defaults.
