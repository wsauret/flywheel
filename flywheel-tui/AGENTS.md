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

## Testing the TUI with tmux

The TUI is a full-screen interactive application. You cannot test it by running `bin/flywheel` directly in a Bash tool call because it takes over the terminal. Instead, use tmux to run the TUI in a detached session, send keystrokes to it, and read its screen output.

**When someone asks you to "test the TUI", "verify the UI works", or "make sure your changes work in the actual app", this is what they mean.** Do not skip this step!

Also, a test plan is available at `tests/fixtures/two-phase-plan.md` if you need to test the `work` workflow.

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

**Verify idle screen renders correctly:**

```bash
tmux capture-pane -t flywheel -p
# Expect: branding header, FLYWHEEL ASCII art, prompt "Paste a plan path to start, or /help"
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
# Expect: working view with "Plan Progress", output window, phase status
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

**Return to idle from any state:**

```bash
tmux send-keys -t flywheel '/new' Enter
sleep 1
tmux capture-pane -t flywheel -p
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
3. Verify the idle screen renders correctly (branding, prompt, layout)
4. Test the specific feature you changed
5. Test adjacent interactions (e.g., if you changed a modal, also test opening and closing it, keyboard shortcuts within it, and that the view behind it restores correctly)
6. Clean up the tmux session

## Architecture quick reference

| Layer | Key files |
|-------|-----------|
| CLI entry | `src/cli/index.ts` |
| TUI launcher | `src/tui/launcher.ts`, `src/tui/app.tsx` |
| Shell (idle/working) | `src/tui/components/flywheel-shell.tsx` |
| Idle prompt | `src/tui/components/prompt/index.tsx` |
| Commands | `src/tui/config/commands.ts`, `src/tui/routes/home/hooks/use-home-commands.ts` |
| Work view | `src/tui/routes/work/components/work-shell.tsx` |
| Output window | `src/tui/routes/work/components/output-window.tsx` |
| Work prompt | `src/tui/routes/work/components/prompt-line/index.tsx` |
| Keyboard handling | `src/tui/routes/work/hooks/use-work-keyboard.ts` |
| Modals | `src/tui/routes/work/components/modals/` |
| Status footer | `src/tui/routes/work/components/status-footer.tsx` |
| Escape logic | `src/tui/utils/escape-handler.ts` |
| Toast system | `src/tui/shared/context/toast.tsx`, `src/tui/shared/ui/toast.tsx` |
| Theme system | `src/tui/shared/context/theme.tsx` |
| Workflow session | `src/tui/components/workflow-session.ts` |
| WorkController | `src/controller/work.ts` |
| Engine registry | `src/engines/core/registry.ts` |

## TUI states

The shell has three states: `idle`, `working`, and `completed`.

- **idle** -- Initial state. Shows branding + ASCII art + command prompt.
- **working** -- Active workflow. Shows plan progress (left), output window (right), prompt line (bottom), status footer.
- **completed** -- Workflow finished/stopped/failed. Same branding as idle but prompt says "Enter to run again, or paste new path".

Transitions: `idle -> working` (submit a plan path), `working -> completed` (workflow ends, user stops, or error), `completed -> idle` (`/new` command), `completed -> working` (submit another path).

## Slash commands

Four commands are recognized: `/exit`, `/new`, `/stop`, `/help`. Any input starting with `/` that doesn't match one of these is treated as a file path (not as an unknown command error).
