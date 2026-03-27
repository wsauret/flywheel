---
title: "User Testing Knowledge"
summary: "Testing conventions, tools, URLs, and concurrency guidance for Flywheel TUI"
tags: [testing, validation, tui, e2e]
---

# User Testing Knowledge

## Testing Surface

Flywheel TUI is a terminal application launched via `bin/flywheel` (requires `--conditions=browser` flag, handled by the wrapper script). All testing is done via tmux sessions.

## Tool: tuistory

The `tuistory` skill automates terminal UI testing via tmux. It supports:
- Starting tmux sessions at specific dimensions
- Sending keystrokes and text
- Capturing screen snapshots
- Waiting for text patterns to appear

## How to Start the TUI for Testing

```bash
tmux kill-session -t flywheel-bench 2>/dev/null
tmux new-session -d -s flywheel-bench -x 120 -y 40 \
  'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'
sleep 2
```

## Log Files

Log files are in `.flywheel/log/` with timestamps in UTC format. Check for errors:
```bash
ls -t .flywheel/log/*.log | head -1 | xargs grep -E '^(ERROR|WARN)'
```

## Validation Concurrency

### Surface: TUI (tuistory)
- **Max concurrent validators:** 1
- **Reason:** The TUI is a single-instance app that uses the full terminal. Only one tmux session can meaningfully interact with it at a time.

## Flow Validator Guidance: tuistory

### Isolation Rules
- Only one TUI instance can run at a time
- Always kill previous tmux sessions before starting: `tmux kill-session -t flywheel-bench 2>/dev/null`
- Clean git state between runs: `git checkout -- . && git clean -fd`
- The TUI writes to `.flywheel/log/` — logs persist between runs (rotation keeps last 10)

### Evidence Collection
- Use `tmux capture-pane -t flywheel-bench -p` to capture screenshots
- Save evidence to the designated evidence directory
- Check log files for ERROR/WARN lines after each run

### For Benchmark Validation
When validating benchmark assertions, the evidence is in committed reports and log files. Verify:
1. The benchmark report files exist and contain the required data
2. Log files from the runs show zero ERROR lines
3. Timing data is consistent between reports and logs

### Boundaries
- Do not modify source code
- Do not delete existing `.flywheel/` data
- Do not run parallel TUI instances
