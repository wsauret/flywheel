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
- **Max concurrent:** 5 instances

## Validation Concurrency

### Unit Test Surface
- **Max concurrent validators:** 5
- **Resource cost per validator:** Minimal (~50MB for bun test process)
- **Isolation:** Each validator reads test output independently; tests share no mutable state
- **Rationale:** Unit tests are read-only analysis of test output. No shared state concerns.

## Flow Validator Guidance: Unit Tests

### Isolation rules
- Validators examine test output from `bun test` — they do NOT modify source code
- Each validator runs the specific test file(s) for its assertion group
- No shared mutable state between validators

### Verification approach
1. Run the specific test file(s) for the assertion group
2. Match test names to assertion IDs (tests are prefixed with `VAL-QUEUE-NNN:` or use descriptive names mapping to assertions)
3. For each assertion, verify at least one test directly exercises the specified behavior
4. Report pass/fail per assertion with evidence (test output excerpt)

### Boundaries
- Do not modify any source files
- Do not modify test files
- Only read and analyze test output
