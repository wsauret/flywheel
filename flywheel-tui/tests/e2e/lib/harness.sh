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
UAT_DIR=""
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

  # Create isolated temp dir per docs/tmux-uat-guide.md
  # Workers create real files — never run in the project directory.
  UAT_DIR=$(mktemp -d /tmp/flywheel-uat-XXXXXX)
  if [ -f "$PROJECT_DIR/flywheel.toml" ]; then
    cp "$PROJECT_DIR/flywheel.toml" "$UAT_DIR/"
  fi

  # Kill only THIS test's tmux session if it exists from a prior run
  tmux kill-session -t "$SESSION" 2>/dev/null || true

  echo "[$module_name] Starting tests… (UAT_DIR=$UAT_DIR)"
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

assert_contains_ci() {
  local file="$LOG_DIR/$1"
  if grep -qi "$2" "$file" 2>/dev/null; then
    echo "PASS  $3 — found '$2' in $1 (case-insensitive)" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $3 — missing '$2' in $1 (case-insensitive)" >> "$SUMMARY"
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

# Wait until the TUI has an active chat as foreground.
# Detects "/new for fresh chat" in the prompt — this only appears when
# a chat session is foreground and the agent is idle (ready for input).
# The generic "Send a message..." prompt appears when NO session is foreground.
wait_for_chat() {
  local max_wait="${1:-25}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    local screen
    screen=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
    if echo "$screen" | grep -q "/new for fresh chat"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ─── App Lifecycle ────────────────────────────────────────────────────────────

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# Build env prefix string from optional args (e.g. "FLYWHEEL_MODEL=haiku" "FOO=1")
# Automatically injects FLYWHEEL_ENGINE when FLYWHEEL_E2E_ENGINE is set (via --engine flag).
_build_env_prefix() {
  local prefix="FLYWHEEL_PROJECT_CWD=$UAT_DIR"
  if [ -n "${FLYWHEEL_E2E_ENGINE:-}" ]; then
    prefix="$prefix FLYWHEEL_ENGINE=$FLYWHEEL_E2E_ENGINE"
  fi
  for arg in "$@"; do
    prefix="$prefix $arg"
  done
  echo "$prefix"
}

# Start the TUI in a fresh tmux session.
# Optional args are passed as env vars: start_app "FLYWHEEL_MODEL=haiku" "FOO=1"
start_app() {
  tmux new-session -d -s "$SESSION" -x 120 -y 40
  local env_prefix
  env_prefix=$(_build_env_prefix "$@")
  send_keys "cd $PROJECT_DIR && $env_prefix bun run dev 2>$STDERR_LOG" Enter
  wait_for_chat 30
  capture "00-boot.log"
}

stop_app() {
  send_keys C-c
  sleep "$WAIT_SHORT"
  capture "99-exit.log"
}

# Restart the TUI in the same tmux session.
# Optional args are passed as env vars: restart_app "FLYWHEEL_MODEL=haiku"
restart_app() {
  send_keys C-c
  sleep 5
  send_keys C-c
  sleep 10
  local env_prefix
  env_prefix=$(_build_env_prefix "$@")
  send_keys "$env_prefix bun run dev 2>>$STDERR_LOG" Enter
  sleep "$WAIT_MEDIUM"
}
