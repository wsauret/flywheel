---
title: "User Testing Guide"
summary: "Testing tools, surfaces, and setup for flywheel-tui validation"
tags: [testing, validation, user-testing]
---

## Testing Surfaces

### Unit Tests (bun test)
- **Tool:** `bun test` (Bun's built-in test runner)
- **Location:** `tests/` directory
- **Pattern:** `tests/<module>.test.ts`
- **No services required** — pure unit tests with mocks

### TUI (tmux)
- **Tool:** tmux with `tuistory` skill for automation
- **Setup:** `tmux new-session -d -s flywheel -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'`
- **Resource cost:** ~300MB per TUI instance
- **Max concurrent:** 3 instances (reduced from 5 due to other droid processes running)

### Static Analysis (rg/grep)
- **Tool:** `rg` (ripgrep) for dead-code verification
- **No services required** — pure filesystem scanning

## Validation Concurrency

### Unit Test Surface
- **Max concurrent validators:** 3
- **Resource cost per validator:** Minimal (~50MB for bun test process)
- **Isolation:** Each validator reads test output independently; tests share no mutable state
- **Rationale:** Unit tests are read-only analysis of test output. No shared state concerns.

### TUI Surface
- **Max concurrent validators:** 2
- **Resource cost per validator:** ~300MB per TUI instance
- **Isolation:** Each validator uses a DIFFERENT tmux session name (e.g., flywheel-v1, flywheel-v2)
- **Rationale:** TUI instances share no state. Different tmux sessions are fully independent.
- **CRITICAL:** Each validator must use its own unique tmux session name. Never share tmux sessions.

### Static Analysis Surface
- **Max concurrent validators:** 3
- **Resource cost per validator:** Minimal (~20MB for rg process)
- **Isolation:** Pure read-only filesystem scanning. No shared state.

## Flow Validator Guidance: Unit Tests

### Isolation rules
- Validators examine test output from `bun test` — they do NOT modify source code
- Each validator runs the specific test file(s) for its assertion group
- No shared mutable state between validators

### Verification approach
1. Run the specific test file(s) for the assertion group
2. Match test names to assertion IDs (tests are prefixed with `VAL-SHELL-NNN:` or use descriptive names mapping to assertions)
3. For each assertion, verify at least one test directly exercises the specified behavior
4. Report pass/fail per assertion with evidence (test output excerpt)

### Boundaries
- Do not modify any source files
- Do not modify test files
- Only read and analyze test output

## Flow Validator Guidance: TUI

### Isolation rules
- Each validator gets a unique tmux session name (e.g., `flywheel-v1`, `flywheel-v2`)
- Validators MUST NOT use the session name `flywheel` — that's reserved for manual use
- Each validator must kill its tmux session after testing

### Verification approach
1. Start TUI in tmux: `tmux new-session -d -s <session-name> -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'`
2. Wait 3 seconds for startup
3. Send keystrokes and capture screen output
4. Verify expected TUI behavior against assertion spec
5. Check `.flywheel/log/` for errors after testing
6. Kill tmux session when done

### Key patterns
- Send text: `tmux send-keys -t <session> 'text' Enter`
- Capture screen: `tmux capture-pane -t <session> -p`
- Send Escape: `tmux send-keys -t <session> Escape`
- Send Ctrl+C: `tmux send-keys -t <session> C-c`
- Wait for state transitions: `sleep 2-5`

### Boundaries
- Do not modify any source files
- Only interact with the TUI via tmux
- Always cleanup tmux sessions after testing

## Flow Validator Guidance: Static Analysis

### Verification approach
1. Use `rg` (ripgrep) to search for patterns that should NOT exist
2. For dead-code assertions: `rg '<pattern>' src/` should return NO matches
3. For console.error assertions: `rg 'console\.(error|warn|debug)' src/ --glob '!*.test.*'`
4. For typecheck: `bun run typecheck` should exit 0
5. For test suite: `bun test` should exit 0 with all passing

### Boundaries
- Do not modify any source files
- Only read and scan source code
