#!/usr/bin/env bash
#
# Shared test harness for TUI regression tests.
# Source this file from each module test script.
#
# Provides: helpers (capture, send_keys, assert_*), app lifecycle (start/stop/restart),
# and the tmux session management.
#
# Usage in module tests:
#   source "$(dirname "$0")/lib/harness.sh"
#   init_harness "module-name"
#   start_app
#   ... test code ...
#   finish_harness
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="flywheel-uat-$$"
WAIT_SHORT=3
WAIT_MEDIUM=10
WAIT_RESPONSE=18

PASS_COUNT=0
FAIL_COUNT=0

init_harness() {
  local module_name="${1:?module name required}"
  local base_dir="${2:-$PROJECT_DIR/tests/e2e/results/$(date +%Y%m%d-%H%M%S)}"

  LOG_DIR="$base_dir/$module_name"
  STDERR_LOG="$LOG_DIR/stderr.log"
  SUMMARY="$LOG_DIR/summary.log"

  mkdir -p "$LOG_DIR"
  echo "Module: $module_name — $(date)" > "$SUMMARY"
  echo "Log directory: $LOG_DIR" >> "$SUMMARY"
  echo "---" >> "$SUMMARY"

  # Kill any leftover UAT sessions
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^flywheel-uat-' || true); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done

  echo "[$module_name] Starting tests…"
}

finish_harness() {
  echo "---" >> "$SUMMARY"
  echo "PASS: $PASS_COUNT" >> "$SUMMARY"
  echo "FAIL: $FAIL_COUNT" >> "$SUMMARY"
  echo "TOTAL: $((PASS_COUNT + FAIL_COUNT))" >> "$SUMMARY"

  echo ""
  echo "  $PASS_COUNT passed, $FAIL_COUNT failed — $LOG_DIR"
  echo ""
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

capture() {
  local file="$LOG_DIR/$1"
  sleep "${2:-1}"
  tmux capture-pane -t "$SESSION" -p > "$file" 2>/dev/null || true
  echo "  captured → $1"
}

send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

send_text() {
  send_keys "$1" Enter
}

wait_and_capture() {
  sleep "$1"
  capture "$2"
}

assert_contains() {
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

nav_down() {
  local n="${1:-1}"
  for i in $(seq 1 "$n"); do
    send_keys Down
    sleep 0.15
  done
  sleep 0.3
}

# ─── App Lifecycle ────────────────────────────────────────────────────────────

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
