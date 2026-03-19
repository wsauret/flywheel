# Flywheel CLI — Agent Instructions

## Project overview

Flywheel CLI is a terminal UI application that executes workflow plans. It spawns AI worker processes (Claude or OpenCode), runs plan phases sequentially, and provides a rich TUI built with OpenTUI + SolidJS.

**Runtime:** Bun (not Node)
**TUI framework:** OpenTUI (`@opentui/core` + `@opentui/solid`) with SolidJS signals
**Important:** SolidJS must resolve with the `"browser"` export condition. The `bin/flywheel` wrapper handles this with `bun --conditions=browser`.

## Running unit tests

```bash
cd flywheel-tui
bun test                   # all tests
bun test tests/foo.test.ts # single file
```

Unit tests do NOT render OpenTUI components, so they don't need the `--conditions=browser` flag.

## E2E pipeline test

A full TUI-level end-to-end test lives at `tests/e2e/tui-pipeline.sh`. It starts the TUI in tmux, sends a `/plan` command, and monitors state transitions through plan → work → review. This test uses real API calls.

```bash
# Run the e2e pipeline test (takes several minutes, requires API key)
./tests/e2e/tui-pipeline.sh

# Run and attach to watch it live
./tests/e2e/tui-pipeline.sh --attach
```

The script:
1. Starts flywheel in a tmux session (`flywheel-e2e`)
2. Sends `/plan <simple feature description>` to trigger the full pipeline
3. Polls the screen every 10s, logging state transitions to `tests/e2e/tui-pipeline.log`
4. Passes if the `work` stage starts (plan→work chaining works)
5. Fails if it stalls at idle after plan, crashes, or times out (15 min)
6. Cleans up the tmux session and sandbox files on exit

Use this test after modifying the pipeline, stage runner, event bus, or workflow chaining logic.

## Testing the TUI with tmux

Always do extensive UAT after any change to confirm that everything works. Since the TUI is a full-screen interactive application, you need to use tmux to run the TUI in a detached session, send keystrokes to it, and read its screen output.

**When someone asks you to "test the TUI", "verify the UI works", or "make sure your changes work in the actual app", this is what they mean.** Do not skip this step! Always do UAT after making changes.

A test plan is available at `tests/fixtures/two-phase-plan.md` if you need to test the `work` workflow.

### Prerequisites

tmux must be installed (e.g., `brew install tmux` on macOS).

### Setup

Kill any existing session, then start the TUI in a detached tmux session:

```bash
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 120 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2
```

The `-x 120 -y 40` sets the terminal to 120 columns by 40 rows, which is a reasonable default. Adjust if you need to test layout at different sizes.

### Reading the screen

Capture the current screen contents as plain text:

```bash
tmux capture-pane -t flywheel -p
```

This returns exactly what a user would see (minus colors). Use it to:
- Verify the correct view is displayed (idle screen, working view, modal, etc.)
- Check that text, labels, and prompts are correct
- Detect layout issues (overflow, wrapping, misalignment)

To check just the bottom of the screen (prompt area):

```bash
tmux capture-pane -t flywheel -p | tail -5
```

### Sending input

Type text into the prompt:

```bash
tmux send-keys -t flywheel 'some text' Enter
```

Send special keys:

```bash
tmux send-keys -t flywheel Escape      # Escape
tmux send-keys -t flywheel Tab         # Tab
tmux send-keys -t flywheel Up          # Arrow up
tmux send-keys -t flywheel Down        # Arrow down
tmux send-keys -t flywheel Left        # Arrow left
tmux send-keys -t flywheel Right       # Arrow right
tmux send-keys -t flywheel BSpace      # Backspace
tmux send-keys -t flywheel C-u         # Ctrl+U (clear input line)
tmux send-keys -t flywheel C-c         # Ctrl+C (kills the process)
tmux send-keys -t flywheel C-s         # Ctrl+S (skip phase)
tmux send-keys -t flywheel C-t         # Ctrl+T (toggle theme)
```

### Timing

After sending input, wait before reading the screen. The TUI re-renders in milliseconds, but a short sleep ensures the frame is complete:

```bash
tmux send-keys -t flywheel '/help' Enter
sleep 1
tmux capture-pane -t flywheel -p
```

Use `sleep 0.5` for simple keystrokes, `sleep 1-2` after actions that trigger state transitions (starting a workflow, stopping, modal open/close), and `sleep 3-5` if waiting for an external process to start.

### Common test sequences

**Verify launcher screen renders correctly:**

```bash
tmux capture-pane -t flywheel -p
# Expect: branding header, FLYWHEEL ASCII art, starter chooser (recent sessions, commands),
#         session sidebar (left column, if terminal >= 90 cols), prompt
```

**Test a slash command:**

```bash
tmux send-keys -t flywheel '/help' Enter
sleep 1
tmux capture-pane -t flywheel -p
```

**Start a workflow with a test plan:**

```bash
tmux send-keys -t flywheel 'tests/fixtures/two-phase-plan.md' Enter
sleep 3
tmux capture-pane -t flywheel -p
# Expect: working view with session sidebar (left), output window (center),
#         workflow panel (right, if terminal >= 120 cols), prompt line (bottom), status footer
```

**Stop a running workflow (Escape -> confirm):**

```bash
tmux send-keys -t flywheel Escape
sleep 1
tmux capture-pane -t flywheel -p   # should show stop confirmation modal
tmux send-keys -t flywheel 'y'
sleep 1
tmux capture-pane -t flywheel -p   # should return to completed/idle view
```

**Return to launcher from any state:**

```bash
tmux send-keys -t flywheel '/new' Enter
sleep 1
tmux capture-pane -t flywheel -p
```

**Test session sidebar (shows recent sessions):**

```bash
# Start a workflow, then stop it, then /new — the sidebar should list the session
tmux send-keys -t flywheel 'tests/fixtures/two-phase-plan.md' Enter
sleep 3
tmux send-keys -t flywheel Escape
sleep 1
tmux send-keys -t flywheel 'y'
sleep 1
tmux send-keys -t flywheel '/new' Enter
sleep 1
tmux capture-pane -t flywheel -p
# Expect: sidebar shows the previous session with its lifecycle state
```

**Test plan import flow:**

```bash
# Paste a plan path to trigger import -> confirmation UI
tmux send-keys -t flywheel 'tests/fixtures/two-phase-plan.md' Enter
sleep 2
tmux capture-pane -t flywheel -p
# Expect: plan confirmation view (importing mode) or working view
```

**Test responsive layout (narrow terminal):**

```bash
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 80 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2
tmux capture-pane -t flywheel -p
# Expect: sidebar hidden (< 90 cols), panel hidden (< 120 cols)
```

**Clean up when done:**

```bash
tmux kill-session -t flywheel 2>/dev/null
```

### Restarting after a crash or exit

If the TUI exits (via Escape on empty input, Ctrl+C, or a crash), the tmux session is destroyed because it was the only process. Just recreate it:

```bash
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 120 -y 40 \
  'cd /path/to/flywheel-tui && bin/flywheel'
sleep 2
```

### What to verify after making TUI changes

After modifying any file under `src/tui/`, always:

1. Run `bun test` to ensure unit tests pass
2. Start the TUI in tmux
3. Verify the launcher screen renders correctly (branding, sidebar, starter chooser, prompt)
4. Test the specific feature you changed
5. Test adjacent interactions (e.g., if you changed a modal, also test opening and closing it, keyboard shortcuts within it, and that the view behind it restores correctly)
6. Clean up the tmux session

## Architecture quick reference

### Core layers

| Layer | Key files |
|-------|-----------|
| CLI entry | `src/cli/index.ts` |
| TUI launcher | `src/tui/launcher.ts`, `src/tui/app.tsx` |
| Shell (mode routing) | `src/tui/components/flywheel-shell.tsx` |
| Shell modes (state machine) | `src/tui/components/shell-modes.ts` |
| WorkController | `src/controller/work.ts` |
| Engine registry | `src/engines/core/registry.ts` |

### Session management

| Layer | Key files |
|-------|-----------|
| Session state machine | `src/session/state-machine.ts` |
| Session persistence | `src/session/persistence.ts` |
| Session manager | `src/session/manager.ts` |
| Cost tracker | `src/session/cost-tracker.ts` |
| Worktree manager | `src/session/worktree-manager.ts` |
| Session schema | `src/schemas/session.ts` |

### TUI components

| Layer | Key files |
|-------|-----------|
| Session sidebar | `src/tui/components/session-sidebar.tsx` |
| Session header | `src/tui/components/session-header.tsx` |
| Starter chooser | `src/tui/components/starter-chooser.tsx` |
| Plan confirmation | `src/tui/components/plan-confirmation.tsx` |
| Workflow panel | `src/tui/components/workflow-panel.tsx` |
| Action dispatcher | `src/tui/components/action-dispatcher.ts` |
| Prompt placeholders | `src/tui/components/prompt-placeholders.ts` |
| Workflow session | `src/tui/components/workflow-session.ts` |
| Idle prompt | `src/tui/components/prompt/index.tsx` |
| Commands | `src/tui/config/commands.ts`, `src/tui/routes/home/hooks/use-home-commands.ts` |

### Structured output pipeline

Worker output flows through a multi-stage pipeline before reaching the TUI:

```
worker stdout → NDJSONParser (line buffering + JSON parsing)
  → StructuredEventParser (engine routing + format normalization)
    → SubagentTraceParser (agent lifecycle tracking)
    → StructuredOutputBuilder (block accumulation)
      → setOutputBlocks() (batched flush → SolidJS reactivity)
```

System messages (worker:spawned, step:started, etc.) and stderr also go through the builder as text blocks. Raw mode bypasses the pipeline entirely.

| Layer | Key files |
|-------|-----------|
| OpenTUI adapter | `src/tui/adapters/opentui.ts` |
| NDJSON parser | `src/worker/ndjson-parser.ts` |
| Structured event parser | `src/tui/adapters/structured-event-parser.ts` |
| Subagent trace parser | `src/tui/adapters/subagent-tracing/parser.ts` |
| Structured output builder | `src/tui/adapters/structured-output-builder.ts` |
| Output formatter (legacy) | `src/tui/adapters/output-formatter.ts` |
| Block renderer | `src/tui/routes/work/components/output-blocks/block-renderer.tsx` |
| Block types | `src/tui/routes/work/state/types.ts` (TextBlock, ToolBlock, AgentBlock, ContextGroupBlock, SystemBlock) |

### Work view

| Layer | Key files |
|-------|-----------|
| Work shell | `src/tui/routes/work/components/work-shell.tsx` |
| Output window | `src/tui/routes/work/components/output-window.tsx` |
| Work prompt | `src/tui/routes/work/components/prompt-line/index.tsx` |
| Keyboard handling | `src/tui/routes/work/hooks/use-work-keyboard.ts` |
| Modals | `src/tui/routes/work/components/modals/` |
| Status footer | `src/tui/routes/work/components/status-footer.tsx` |

### Controllers and context

| Layer | Key files |
|-------|-----------|
| Plan import | `src/controller/plan-import.ts` |
| Session provider | `src/tui/shared/context/session.tsx` |
| Escape logic | `src/tui/utils/escape-handler.ts` |
| Toast system | `src/tui/shared/context/toast.tsx`, `src/tui/shared/ui/toast.tsx` |
| Theme system | `src/tui/shared/context/theme.tsx` |

## TUI states

### View modes (shell)

The shell has four view modes: `launcher`, `working`, `completed`, and `importing`.

- **launcher** -- Initial state. Shows starter chooser (recent sessions, commands), session sidebar (left), branding header.
- **working** -- Active workflow. Shows session sidebar (left), output window (center), workflow panel (right), prompt line (bottom), status footer.
- **completed** -- Workflow finished/stopped/failed. Shows summary, option to re-run or start new session.
- **importing** -- Plan import flow. Shows plan confirmation UI for reviewing and approving an imported plan.

View mode transitions:

- `launcher -> working` (start workflow)
- `launcher -> importing` (begin plan import)
- `working -> completed` (workflow ends, user stops, or error)
- `completed -> working` (re-run or resume)
- `completed -> launcher` (`/new` command)
- `completed -> importing` (import new plan)
- `importing -> launcher` (cancel import)
- `importing -> working` (confirm import, start workflow)

Escape behavior per mode: `launcher` exits TUI, `working` uses double-Esc to stop, `completed` returns to launcher, `importing` cancels import.

The sidebar and panel columns collapse responsively: sidebar hides below 90 columns, panel hides below 120 columns.

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

## Slash commands

Ten commands are recognized: `/work`, `/plan`, `/review`, `/ship`, `/debug`, `/research`, `/config`, `/help`, `/new`, `/exit`. The primary UX is contextual actions dispatched via the action dispatcher based on current session state. Slash commands provide direct access to specific workflows.

| Command | Description |
|---------|-------------|
| `/work` | Run a plan (paste path or pick from recent) |
| `/plan` | Create a new plan from description |
| `/review` | Review current changes |
| `/ship` | Commit, PR, and compound learnings |
| `/debug` | Debug a failing test or issue |
| `/research` | Research a topic in the codebase |
| `/config` | Edit flywheel.yaml |
| `/help` | Show available commands |
| `/new` | Start fresh from launcher screen |
| `/exit` | Exit flywheel |

Any input starting with `/` that doesn't match one of these is treated as a file path (not as an unknown command error).
