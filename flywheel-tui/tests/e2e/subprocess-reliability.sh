#!/usr/bin/env bash
# Module: Subprocess Reliability — self-review injection, native verification,
# observer wiring (doom loop, tool failure, no-action), post-turn hook
source "$(dirname "$0")/lib/harness.sh"
init_harness "subprocess-reliability" "$@"
start_app

# ── SR-01: /work self-review injection + observer firing ──
echo "SR-01: Self-Review + Observer Injection"
send_text '/work "create tests/fixtures/e2e-sr01.txt containing sr01-passed then run bun run test tests/crash-recovery.test.ts"'

# 15s: Dispatcher running, worker starting
sleep 15
capture "SR-01a-dispatcher.log"

# 60s: Worker running, tools executing
sleep 45
capture "SR-01b-worker-running.log"

# 120s: Self-review injected, worker responding to checklist
sleep 60
capture "SR-01c-self-review.log"

# 180s: Should be complete by now
sleep 60
capture "SR-01d-final.log"

# Capture scrollback for full output
tmux capture-pane -t "$SESSION" -p -S -500 > "$LOG_DIR/SR-01e-scrollback.log" 2>/dev/null || true

# Step completed — "✓ Execute work" or "✓ 1/1 steps"
assert_contains "SR-01d-final.log" "✓" "SR-01d-step-completed" || true

# Self-review evidence: the worker either enumerates the 6 items, or mentions
# "review" in its handoff/output, or shows verification.tests_passed.
# LLM responses vary — check multiple signals.
assert_contains "SR-01e-scrollback.log" "review\|verification\|tests_passed\|Evaluator.*passed" "SR-01e-self-review-evidence" || true

# No-action observer may have fired (depends on timing)
# This is informational — not a hard assertion
grep -q "No tool calls were made" "$LOG_DIR/SR-01e-scrollback.log" 2>/dev/null \
  && echo "INFO  SR-01f-no-action-observer-fired — observer injected message" >> "$SUMMARY" \
  || echo "INFO  SR-01f-no-action-observer-silent — no idle turn detected" >> "$SUMMARY"

# Worker created the file
if [ -f "$PROJECT_DIR/tests/fixtures/e2e-sr01.txt" ]; then
  echo "PASS  SR-01g-file-created — tests/fixtures/e2e-sr01.txt exists" >> "$SUMMARY"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  SR-01g-file-created — file missing" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Completion status line: "✓ 1/1 steps"
assert_contains "SR-01e-scrollback.log" "1/1 steps" "SR-01h-completion-status" || true

send_keys C-n; sleep "$WAIT_MEDIUM"

# ── SR-02: Chat with observers — no false positives ──
echo "SR-02: Chat with Observers Active"
send_text "What is 13 * 7? Reply with just the number."
wait_and_capture "$WAIT_RESPONSE" "SR-02a-chat.log"
assert_contains "SR-02a-chat.log" "91" "SR-02a-correct-answer" || true

# No observer noise in chat mode (observers are workflow-only)
assert_not_contains "SR-02a-chat.log" "Doom loop" "SR-02b-no-doom-loop" || true
assert_not_contains "SR-02a-chat.log" "No tool calls were made" "SR-02c-no-observer-noise" || true

send_keys C-n; sleep "$WAIT_MEDIUM"

# ── SR-03: /work with pause and resume ──
echo "SR-03: Workflow Pause and Resume"
send_text '/work "create tests/fixtures/e2e-sr03.txt with sr03-passed"'
sleep 20
capture "SR-03a-working.log"

# Pause
send_keys Escape
wait_and_capture 5 "SR-03b-paused.log"

# Resume
send_text "keep going"
sleep 5
capture "SR-03c-resumed.log"

# Wait for completion
sleep 120
capture "SR-03d-completed.log"
tmux capture-pane -t "$SESSION" -p -S -500 > "$LOG_DIR/SR-03e-scrollback.log" 2>/dev/null || true

# SR-03: self-review evidence (injection + worker response)
assert_contains "SR-03e-scrollback.log" "review\|verification\|tests_passed\|Evaluator.*passed" "SR-03e-self-review-evidence" || true

if [ -f "$PROJECT_DIR/tests/fixtures/e2e-sr03.txt" ]; then
  echo "PASS  SR-03f-file-after-resume — file exists after pause/resume" >> "$SUMMARY"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  SR-03f-file-after-resume — file missing after pause/resume" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

send_keys C-n; sleep "$WAIT_MEDIUM"

# ── SR-04: Chat after workflow — no state leaks ──
echo "SR-04: Chat After Workflow"
send_text "say exactly: sr04-post-workflow-chat"
wait_and_capture "$WAIT_RESPONSE" "SR-04a-chat-after.log"
assert_contains "SR-04a-chat-after.log" "sr04-post-workflow-chat" "SR-04a-chat-works-after-workflow" || true
assert_not_contains "SR-04a-chat-after.log" "running\|⠧\|⠙\|Doom loop" "SR-04b-no-workflow-leaks" || true

# ── Cleanup test artifacts ──
rm -f "$PROJECT_DIR/tests/fixtures/e2e-sr01.txt"
rm -f "$PROJECT_DIR/tests/fixtures/e2e-sr03.txt"

stop_app
finish_harness
