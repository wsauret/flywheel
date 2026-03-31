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

**Git rules:**
- **Never use `git stash`** — multiple processes work on this repo concurrently. Stashing can lose or conflict with their work.
- **Fix failing tests, don't prove they're pre-existing.** If you find a failing test, fix it. Don't waste time trying to show it was already broken.
- Always commit your changes alongside other processes' work.

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
