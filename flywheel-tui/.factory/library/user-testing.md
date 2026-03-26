# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

**What belongs here:** How to test the TUI, what tools to use, concurrency limits.

---

## Validation Surface

**Primary surface:** Terminal TUI via tmux
**Tool:** tmux screen capture and keystroke injection
**No browser, no API endpoints** — everything tested through terminal interaction

## Setup

```bash
# Start TUI in tmux
tmux kill-session -t flywheel 2>/dev/null
tmux new-session -d -s flywheel -x 120 -y 40 \
  'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'
sleep 3

# Capture screen
tmux capture-pane -t flywheel -p

# Send keystrokes
tmux send-keys -t flywheel '/start test' Enter

# Cleanup
tmux send-keys -t flywheel '/exit' Enter
sleep 1
tmux kill-session -t flywheel 2>/dev/null
```

## Terminal Sizes

- Standard: 120x40 (shows sidebar + panel)
- Narrow: 80x40 (sidebar hidden, panel hidden)
- Sidebar threshold: 90 cols
- Panel threshold: 120 cols

## Validation Concurrency

**Machine:** 36 GB RAM, 11 cores
**Per TUI instance:** ~300 MB RAM, 2 processes
**Baseline usage:** ~12 GB
**Usable headroom (70%):** ~16.8 GB
**Max concurrent validators:** 5

## Check Logs After Testing

```bash
ls -t .flywheel/log/*.log | head -1 | xargs cat | grep -E '^(ERROR|WARN)'
```

## Flow Validator Guidance: Terminal (bun test)

**Surface:** Unit and integration tests run via `bun test` in terminal.
**Isolation:** Each `bun test <file>` invocation runs in its own process with independent state. No shared mutable state between test files. Multiple test files can run concurrently safely.
**Boundaries:**
- Do NOT modify source files during testing — only read and run tests
- Do NOT start the TUI or any external services — these are pure unit/integration tests
- Each validator should run specific test files matching its assertion group
- Verify test pass/fail counts and check for specific test names matching assertions
**Concurrency:** Up to 5 validators can run `bun test` concurrently without interference (each is ~500MB RAM, total ~2.5GB well within 16.8GB headroom)
