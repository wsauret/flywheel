#!/usr/bin/env bash
#
# TUI Regression Tests — Automated UAT via tmux
#
# Runs the flywheel TUI in a tmux session and exercises every major user flow,
# capturing pane output after each action for offline examination.
#
# Usage:
#   ./tests/e2e/tui-regression.sh [--log-dir <path>]
#
# Outputs:
#   <log-dir>/T-XX-<name>.log   — captured pane after each step
#   <log-dir>/stderr.log        — TUI stderr
#   <log-dir>/summary.log       — PASS/FAIL per test
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="flywheel-uat-$$"
LOG_DIR="${1:-$PROJECT_DIR/tests/e2e/results/$(date +%Y%m%d-%H%M%S)}"
STDERR_LOG="$LOG_DIR/stderr.log"
SUMMARY="$LOG_DIR/summary.log"
WAIT_SHORT=3      # seconds — short UI settle
WAIT_MEDIUM=8     # seconds — agent startup
WAIT_RESPONSE=18  # seconds — wait for model response

mkdir -p "$LOG_DIR"
echo "TUI Regression Run — $(date)" > "$SUMMARY"
echo "Log directory: $LOG_DIR" >> "$SUMMARY"
echo "---" >> "$SUMMARY"

PASS_COUNT=0
FAIL_COUNT=0

# ─── Helpers ───────────────────────────────────────────────────────────────────

capture() {
  # $1 = log file name (without dir)
  local file="$LOG_DIR/$1"
  sleep "${2:-1}"
  tmux capture-pane -t "$SESSION" -p > "$file" 2>/dev/null || true
  echo "  captured → $1"
}

send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

send_text() {
  # Send literal text then Enter
  send_keys "$1" Enter
}

wait_and_capture() {
  # $1 = wait seconds, $2 = log file name
  sleep "$1"
  capture "$2"
}

assert_contains() {
  # $1 = log file, $2 = pattern, $3 = test id
  local file="$LOG_DIR/$1"
  if grep -q "$2" "$file" 2>/dev/null; then
    echo "PASS  $3 — found '$2' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $3 — missing '$2' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_not_contains() {
  # $1 = log file, $2 = pattern, $3 = test id
  local file="$LOG_DIR/$1"
  if grep -q "$2" "$file" 2>/dev/null; then
    echo "FAIL  $3 — unexpected '$2' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  else
    echo "PASS  $3 — correctly absent '$2' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  fi
}

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

start_app() {
  tmux new-session -d -s "$SESSION" -x 120 -y 40
  send_keys "cd $PROJECT_DIR && bun run dev 2>$STDERR_LOG" Enter
  sleep "$WAIT_MEDIUM"
  capture "00-boot.log"
}

stop_app() {
  send_keys C-c
  sleep "$WAIT_SHORT"
  capture "99-exit.log"
}

restart_app() {
  send_keys C-c
  sleep "$WAIT_SHORT"
  send_keys "bun run dev 2>>$STDERR_LOG" Enter
  sleep "$WAIT_MEDIUM"
}

nav_down() {
  # Navigate down N times in modal
  local n="${1:-1}"
  for i in $(seq 1 "$n"); do
    send_keys Down
    sleep 0.15
  done
  sleep 0.3
}

# ─── Start ─────────────────────────────────────────────────────────────────────

echo "Starting TUI regression tests…"
echo "Log dir: $LOG_DIR"

start_app

# ═══════════════════════════════════════════════════════════════════════════════
# T-01: Basic Chat Round Trip
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-01: Basic Chat Round Trip"

send_text "say exactly: test reply alpha"
wait_and_capture "$WAIT_RESPONSE" "T-01a-first-message.log"
assert_contains "T-01a-first-message.log" "test reply alpha" "T-01a" || true

send_text "say exactly: test reply beta"
wait_and_capture "$WAIT_RESPONSE" "T-01b-second-message.log"
assert_contains "T-01b-second-message.log" "test reply beta" "T-01b" || true
assert_contains "T-01b-second-message.log" "test reply alpha" "T-01b-history" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-02: New Chat (Ctrl+N)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-02: New Chat (Ctrl+N)"

send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-02a-new-chat.log"
assert_not_contains "T-02a-new-chat.log" "test reply alpha" "T-02a-cleared" || true
assert_contains "T-02a-new-chat.log" "bg" "T-02a-background" || true

send_text "say exactly: new chat gamma"
wait_and_capture "$WAIT_RESPONSE" "T-02b-new-msg.log"
assert_contains "T-02b-new-msg.log" "new chat gamma" "T-02b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-03: End Chat and Restart (Ctrl+W)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-03: End Chat and Restart (Ctrl+W)"

send_keys C-w
wait_and_capture "$WAIT_MEDIUM" "T-03a-after-ctrl-w.log"
assert_not_contains "T-03a-after-ctrl-w.log" "new chat gamma" "T-03a-cleared" || true

send_text "say exactly: after ctrl-w zeta"
wait_and_capture "$WAIT_RESPONSE" "T-03b-new-msg.log"
assert_contains "T-03b-new-msg.log" "after ctrl-w zeta" "T-03b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-04: Session Modal Open/Close
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-04: Session Modal Navigation"

send_keys C-b
wait_and_capture 1 "T-04a-modal-open.log"
assert_contains "T-04a-modal-open.log" "Sessions" "T-04a-open" || true

send_keys Down Down
sleep 0.3
capture "T-04b-modal-nav.log"

send_keys Escape
wait_and_capture 1 "T-04c-modal-close.log"
assert_not_contains "T-04c-modal-close.log" "Sessions" "T-04c-closed" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-05: Multi-Chat Switch
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-05: Multi-Chat Switch"

# Current chat has "after ctrl-w zeta". Background it and make a new one.
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat B delta"
wait_and_capture "$WAIT_RESPONSE" "T-05a-chatB.log"
assert_contains "T-05a-chatB.log" "chat B delta" "T-05a" || true

# Open modal and switch to first chat (should be 2nd item since chatB is newest)
send_keys C-b
sleep 1
send_keys Down  # navigate to the previous chat
sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-05b-switch-back.log"
assert_contains "T-05b-switch-back.log" "after ctrl-w zeta" "T-05b-old-output" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-09: Send Message After Switch
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-09: Send Message After Switch"

send_text "say exactly: switched back epsilon"
wait_and_capture "$WAIT_RESPONSE" "T-09a-msg-after-switch.log"
assert_contains "T-09a-msg-after-switch.log" "switched back epsilon" "T-09a" || true

# Switch to Chat B and verify it works too
send_keys C-b
sleep 1
send_keys Enter  # first item should be chat B (most recently active)
sleep "$WAIT_SHORT"
send_text "say exactly: chatB still works"
wait_and_capture "$WAIT_RESPONSE" "T-09b-chatB-msg.log"
assert_contains "T-09b-chatB-msg.log" "chatB still works" "T-09b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-06: View Completed Session
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-06: View Completed Session"

# End current chat to create a completed session
send_keys C-w
sleep "$WAIT_MEDIUM"

# Open modal, navigate to completed section
send_keys C-b
sleep 1
capture "T-06a-modal-with-completed.log"
assert_contains "T-06a-modal-with-completed.log" "Completed" "T-06a-has-completed" || true

# Find and select a completed session — navigate past active sessions
# Count active items from the log to know how far to navigate
ACTIVE_COUNT=$(grep -c '^\s*\[chat\]' "$LOG_DIR/T-06a-modal-with-completed.log" 2>/dev/null || echo "5")
# Navigate to first completed (past all active items — use a safe high number)
nav_down 10
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-06b-viewing.log"
assert_contains "T-06b-viewing.log" "Viewing session" "T-06b-viewing" || true

# Dismiss with Esc
send_keys Escape
wait_and_capture 1 "T-06c-dismissed.log"
assert_not_contains "T-06c-dismissed.log" "Viewing session" "T-06c-restored" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-07: Delete Session (D+D confirmation)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-07: Delete Session"

send_keys C-b
sleep 1
# Navigate to completed section
nav_down 10
capture "T-07a-before-delete.log"

# Press D first time — confirmation prompt
send_keys d
sleep 0.5
capture "T-07b-confirm-prompt.log"
assert_contains "T-07b-confirm-prompt.log" "confirm" "T-07b-confirm" || true

# Press D again — delete
send_keys d
sleep 1
capture "T-07c-after-delete.log"

send_keys Escape
sleep 1

# ═══════════════════════════════════════════════════════════════════════════════
# T-08: Interrupt Chat (Esc)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-08: Interrupt Chat (Esc)"

send_text "write a 1000 word essay about the history of mathematics"
sleep 4  # let agent start generating
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-08a-interrupted.log"
assert_contains "T-08a-interrupted.log" "Interrupted" "T-08a-interrupt" || true

# Verify chat still alive — send another message
send_text "say exactly: after interrupt theta"
wait_and_capture "$WAIT_RESPONSE" "T-08b-after-interrupt.log"
assert_contains "T-08b-after-interrupt.log" "after interrupt theta" "T-08b-alive" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-10: Rapid Ctrl+N Spam
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-10: Rapid Ctrl+N Spam"

send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-10a-after-spam.log"
# Should not crash — just verify the app is still running
assert_contains "T-10a-after-spam.log" "Send a message" "T-10a-alive" || true

send_text "say exactly: survived spam iota"
wait_and_capture "$WAIT_RESPONSE" "T-10b-msg.log"
assert_contains "T-10b-msg.log" "survived spam iota" "T-10b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-11: Message During Startup (buffering)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-11: Message During Startup"

send_keys C-n
sleep 0.1
# Type immediately before chat is ready
send_text "say exactly: buffered lambda"
wait_and_capture "$WAIT_RESPONSE" "T-11a-buffered.log"
assert_contains "T-11a-buffered.log" "buffered lambda" "T-11a" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-12: View → Delete → Restore
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-12: View → Delete → Restore"

# First, create a completed session
send_text "say exactly: marker for T12"
wait_and_capture "$WAIT_RESPONSE" "T-12-setup.log"
send_keys C-w
sleep "$WAIT_MEDIUM"

# Send a message in new chat to identify it
send_text "say exactly: active chat T12"
wait_and_capture "$WAIT_RESPONSE" "T-12a-active.log"

# View the completed session
send_keys C-b
sleep 1
nav_down 15  # navigate far enough to reach completed
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-12b-viewing.log"

# Delete the viewed session
send_keys C-b
sleep 1
nav_down 15
send_keys d
sleep 0.3
send_keys d
wait_and_capture 1 "T-12c-after-delete.log"
send_keys Escape
sleep 1

# Should have restored to active chat
capture "T-12d-restored.log"
assert_contains "T-12d-restored.log" "active chat T12" "T-12d-restore" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-17: Modal While Agent Active
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-17: Modal While Agent Active"

send_text "write a 500 word essay about space exploration"
sleep 2
send_keys C-b
wait_and_capture 1 "T-17a-modal-during-active.log"
assert_contains "T-17a-modal-during-active.log" "Sessions" "T-17a-modal" || true

send_keys Escape
wait_and_capture "$WAIT_RESPONSE" "T-17b-after-modal.log"
# Agent should have continued — look for some essay content
assert_contains "T-17b-after-modal.log" "space" "T-17b-continued" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-18: Archive Session
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-18: Archive Session"

# Create a completed session
send_keys C-w
sleep "$WAIT_MEDIUM"

send_keys C-b
sleep 1
nav_down 15  # to completed section
send_keys a
sleep 1
capture "T-18a-archived.log"
assert_contains "T-18a-archived.log" "Archived" "T-18a" || true
send_keys Escape
sleep 1

# ═══════════════════════════════════════════════════════════════════════════════
# T-19: Esc in Idle Chat (interrupt, not kill)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-19: Esc in Idle Chat"

send_text "say exactly: before esc test"
wait_and_capture "$WAIT_RESPONSE" "T-19a-before.log"

send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-19b-after-esc.log"

# Chat should still be alive — send another message
send_text "say exactly: after esc kappa"
wait_and_capture "$WAIT_RESPONSE" "T-19c-still-alive.log"
assert_contains "T-19c-still-alive.log" "after esc kappa" "T-19c" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-16: View Multiple Historical Sessions (priorState invariant)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-16: View Multiple Historical"

# Create 2 completed sessions
send_keys C-w
sleep "$WAIT_MEDIUM"
send_text "say exactly: session X"
sleep "$WAIT_RESPONSE"
send_keys C-w
sleep "$WAIT_MEDIUM"
send_text "say exactly: session Y"
sleep "$WAIT_RESPONSE"
send_keys C-w
sleep "$WAIT_MEDIUM"

# Send msg in active chat to identify it
send_text "say exactly: session Z active"
wait_and_capture "$WAIT_RESPONSE" "T-16a-active.log"
assert_contains "T-16a-active.log" "session Z active" "T-16a" || true

# View first completed
send_keys C-b
sleep 1
nav_down 15
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16b-view1.log"
assert_contains "T-16b-view1.log" "Viewing session" "T-16b-viewing" || true

# View second completed (without dismissing first)
send_keys C-b
sleep 1
nav_down 16  # one more past the previous
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16c-view2.log"

# Dismiss — should restore to active chat (session Z), not to first viewed session
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-16d-restored.log"
assert_contains "T-16d-restored.log" "session Z active" "T-16d-restore" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-20: View Historical → Switch to Live → Esc Doesn't Restore
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-20: View Historical → Switch Live → Esc"

# View a completed session
send_keys C-b
sleep 1
nav_down 15
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-20a-viewing.log"
assert_contains "T-20a-viewing.log" "Viewing session" "T-20a" || true

# Switch to the live session
send_keys C-b
sleep 1
send_keys Enter  # first item = active session
wait_and_capture "$WAIT_SHORT" "T-20b-switched.log"
assert_not_contains "T-20b-switched.log" "Viewing session" "T-20b-live" || true

# Esc should interrupt chat, NOT restore historical view
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-20c-esc.log"
assert_not_contains "T-20c-esc.log" "Viewing session" "T-20c-no-restore" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-BUG1: Stale Sessions After Restart (regression for BUG-1 fix)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-BUG1: Stale Session Recovery After Restart"

# Create multiple chats
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart A"
sleep "$WAIT_RESPONSE"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart B"
sleep "$WAIT_RESPONSE"

# Restart the app
restart_app
capture "T-BUG1a-after-restart.log"

# Open modal and check that old chats are NOT in Active section
send_keys C-b
wait_and_capture 1 "T-BUG1b-modal.log"
send_keys Escape
sleep 1

# The stale sessions should show as Completed, not Active
# (only the fresh boot chat should be Active)
# Count lines between "Active" and "Completed" headers
assert_contains "T-BUG1b-modal.log" "Completed" "T-BUG1b-has-completed" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-14: Exit Flow
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-14: Exit Flow (Ctrl+C)"

send_keys C-c
sleep "$WAIT_SHORT"
capture "T-14a-exited.log"
assert_not_contains "T-14a-exited.log" "flywheel" "T-14a-no-tui" || true

# Also test /exit — restart first
send_keys "bun run dev 2>>$STDERR_LOG" Enter
sleep "$WAIT_MEDIUM"
send_text "/exit"
sleep "$WAIT_SHORT"
capture "T-14b-slash-exit.log"

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo "---" >> "$SUMMARY"
echo "PASS: $PASS_COUNT" >> "$SUMMARY"
echo "FAIL: $FAIL_COUNT" >> "$SUMMARY"
echo "TOTAL: $((PASS_COUNT + FAIL_COUNT))" >> "$SUMMARY"

echo ""
echo "════════════════════════════════════════════"
echo "  RESULTS: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "  Logs:    $LOG_DIR"
echo "  Summary: $SUMMARY"
echo "════════════════════════════════════════════"
echo ""
cat "$SUMMARY"
