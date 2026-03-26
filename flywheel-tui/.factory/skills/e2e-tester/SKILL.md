---
name: e2e-tester
description: Writes and runs comprehensive E2E tests via tmux, covering all workflow configurations and edge cases
---

# E2E Tester

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features that involve writing or running end-to-end tests for the TUI. These tests exercise the full stack: user input → queue creation → step execution → TUI rendering → session persistence.

## Required Skills

None. (tmux testing done via Execute tool)

## File Writing Rule (CRITICAL)

**Never write files longer than 100 lines in a single Create tool call.** Split large files: create the first ~100 lines with Create, then use sequential Edit calls to append remaining sections. This applies to all file types (.ts, .tsx, .test.ts, .sh, .md). If a write fails or is cancelled, break it into smaller pieces — do NOT retry the same large write.

## Work Procedure

1. **Read the feature description.** Understand which scenarios to test and what pass/fail criteria apply.

2. **Read existing E2E patterns.** Check `tests/e2e/tui-pipeline.sh` for the existing tmux-based test pattern. Follow the same structure but adapted for queue-based execution.

3. **Write the E2E test script.** Create bash scripts in `tests/e2e/` that:
   - Start TUI in tmux with specific dimensions
   - Send keystrokes to exercise a workflow
   - Capture screen at key points
   - Assert expected content in captures
   - Check log files for errors
   - Clean up tmux session

4. **Test helper pattern:**
   ```bash
   #!/bin/bash
   set -euo pipefail
   
   PASS=0; FAIL=0
   assert_contains() {
     if echo "$1" | grep -q "$2"; then
       ((PASS++)); echo "  ✓ Found: $2"
     else
       ((FAIL++)); echo "  ✗ Missing: $2"
     fi
   }
   
   # Start TUI
   tmux kill-session -t test 2>/dev/null || true
   tmux new-session -d -s test -x 120 -y 40 \
     'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'
   sleep 3
   
   # Test...
   SCREEN=$(tmux capture-pane -t test -p)
   assert_contains "$SCREEN" "FLYWHEEL"
   
   # Cleanup
   tmux kill-session -t test 2>/dev/null || true
   echo "Results: $PASS passed, $FAIL failed"
   [ $FAIL -eq 0 ] || exit 1
   ```

5. **Run each test and verify it passes.** Fix any bugs found. If bugs require code changes beyond the test script, document them in discoveredIssues.

6. **Run full test suite** to ensure E2E tests didn't break anything:
   ```bash
   bun test
   bun run typecheck
   ```

7. **Commit test scripts and any bug fixes.**

## Example Handoff

```json
{
  "salientSummary": "Created E2E test for sprint workflow via tmux. Tests sprint start → verify fail → retry → verify pass → completion. Found and fixed a bug where sprint iteration count wasn't displayed in telemetry bar. All 3 E2E scenarios pass. bun test (52 passing), typecheck (0 errors).",
  "whatWasImplemented": "tests/e2e/test-sprint-queue.sh (sprint iteration E2E), tests/e2e/test-queue-basic.sh (basic queue lifecycle E2E), fixed src/tui/routes/work/components/telemetry-bar.tsx (sprint iteration display)",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "./tests/e2e/test-queue-basic.sh", "exitCode": 0, "observation": "8 assertions passed: idle screen, /start wizard, queue execution, completion" },
      { "command": "./tests/e2e/test-sprint-queue.sh", "exitCode": 0, "observation": "6 assertions passed: sprint start, verify fail, retry, verify pass, completion" },
      { "command": "bun test", "exitCode": 0, "observation": "52 tests passing" },
      { "command": "bun run typecheck", "exitCode": 0, "observation": "No type errors" }
    ],
    "interactiveChecks": [
      { "action": "Ran sprint E2E test with --attach flag", "observed": "Watched full sprint cycle: work step executed, verify failed, retry pair inserted, second verify passed, queue completed" }
    ]
  },
  "tests": { "added": [] },
  "discoveredIssues": [
    { "severity": "p3", "description": "Sprint iteration display format inconsistent with telemetry bar style — uses 'Sprint 2/5' instead of 'Iteration 2/5'. Minor cosmetic issue." }
  ]
}
```

## When to Return to Orchestrator

- TUI crashes on startup — cannot run E2E tests
- E2E test reveals a fundamental architectural issue (not just a bug)
- Cannot test a scenario because the feature isn't implemented yet
- Test requires real API calls that would incur cost
