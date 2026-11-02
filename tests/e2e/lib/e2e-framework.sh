#!/usr/bin/env bash
#
# Shared E2E framework for TUI regression tests.
# Source this file from each module test script.
#
# Provides: helpers (capture, send_keys, assert_*), app lifecycle (start/stop/restart),
# and the tmux session management.
#
# Usage in module tests:
#   source "$(dirname "$0")/lib/e2e-framework.sh"
#   init_e2e "module-name"
#   start_app
#   ... test code ...
#   finish_e2e
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

init_e2e() {
  local module_name="${1:?module name required}"
  local base_dir="${2:-$PROJECT_DIR/tests/e2e/results/$(date +%Y%m%d-%H%M%S)}"

  LOG_DIR="$base_dir/$module_name"
  STDERR_LOG="$LOG_DIR/stderr.log"
  SUMMARY="$LOG_DIR/summary.log"

  mkdir -p "$LOG_DIR"
  echo "Module: $module_name — $(date)" > "$SUMMARY"
  echo "Log directory: $LOG_DIR" >> "$SUMMARY"
  echo "---" >> "$SUMMARY"

  # Create isolated temp dir per src/orchestration/modules/development/definitions/skills/flywheel-uat/SKILL.md
  # Workers create real files — never run in the project directory.
  UAT_DIR=$(mktemp -d /tmp/flywheel-uat-XXXXXX)
  # Isolate ~/.flywheel/ — without redirecting HOME, the TUI would read and
  # mutate the developer's real global config, auth tokens, and models cache.
  mkdir -p "$UAT_DIR/.flywheel"
  if [ -f "$PROJECT_DIR/flywheel.toml" ]; then
    cp "$PROJECT_DIR/flywheel.toml" "$UAT_DIR/.flywheel/flywheel.toml"
  fi

  # Kill only THIS test's tmux session if it exists from a prior run
  tmux kill-session -t "$SESSION" 2>/dev/null || true

  echo "[$module_name] Starting tests… (UAT_DIR=$UAT_DIR)"
}

install_e2e_workflow() {
  # Tools execute in a package below the project root, so the two directory
  # authorities differ for every module that installs this workflow (ARCH-DIRECTORIES-001).
  FLYWHEEL_E2E_EXECUTION_DIR="$UAT_DIR/packages/app"
  mkdir -p "$FLYWHEEL_E2E_EXECUTION_DIR"
  export FLYWHEEL_E2E_EXECUTION_DIR
  bun --conditions=browser -e '
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const { patchRootField } = await import(process.argv[1] + "/src/orchestration/config/writer.ts");
    const path = process.argv[2];
    const source = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, patchRootField(source, "require_workflow_confirmation", false));
  ' "$PROJECT_DIR" "$UAT_DIR/.flywheel/flywheel.toml"
  cat > "$FLYWHEEL_E2E_EXECUTION_DIR/e2e-work.workflow.yaml" <<'YAML'
id: e2e-work
name: E2E Work
description: One direct E2E work phase.
phases:
  - phase: work
    brief: |
      Complete the launch request directly in this sandbox. Keep the implementation minimal and exact.
      If the request names a file path, create or edit that path exactly as requested.
      Run a concrete verification command when possible, then call handoff with a summary and commands_run.
YAML
}

finish_e2e() {
  echo "---" >> "$SUMMARY"
  echo "PASS: $PASS_COUNT" >> "$SUMMARY"
  echo "FAIL: $FAIL_COUNT" >> "$SUMMARY"
  echo "TOTAL: $((PASS_COUNT + FAIL_COUNT))" >> "$SUMMARY"

  echo ""
  echo "  $PASS_COUNT passed, $FAIL_COUNT failed — $LOG_DIR"
  echo ""
  if [ "$FAIL_COUNT" -ne 0 ]; then
    exit 1
  fi
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

capture() {
  local file="$LOG_DIR/$1"
  sleep "${2:-1}"
  if tmux capture-pane -t "$SESSION" -p > "$file" 2>/dev/null; then
    echo "  captured → $1"
  else
    echo "  FAILED capture → $1 (tmux session '$SESSION' is gone)"
    return 1
  fi
}

send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

# Text and Enter must arrive in separate bursts: an Enter in the same burst
# is reclassified as a pasted newline and lands in the draft (see
# src/orchestration/modules/development/definitions/skills/flywheel-uat/SKILL.md).
send_text() {
  send_keys -l "$1"
  sleep 0.5
  send_keys Enter
}

wait_and_capture() {
  sleep "$1"
  capture "$2"
}

# Resize the tmux window for the current session (e.g. to test responsive
# layout at different terminal widths). Re-layout is driven by the app's
# resize handling.
resize_terminal() {
  local width="${1:?width required}"
  local height="${2:-40}"
  tmux resize-window -t "$SESSION" -x "$width" -y "$height" 2>/dev/null || true
  sleep 1
}

assert_contains() {
  local file="$LOG_DIR/$1"
  if grep -Fq "$2" "$file" 2>/dev/null; then
    echo "PASS  $3 — found '$2' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $3 — missing '$2' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_contains_regex() {
  local file="$LOG_DIR/$1"
  if grep -Eq "$2" "$file" 2>/dev/null; then
    echo "PASS  $3 — found /$2/ in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $3 — missing /$2/ in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_contains_ci() {
  local file="$LOG_DIR/$1"
  if grep -Fqi "$2" "$file" 2>/dev/null; then
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
  if grep -Fq "$2" "$file" 2>/dev/null; then
    echo "FAIL  $3 — unexpected '$2' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  else
    echo "PASS  $3 — correctly absent '$2' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  fi
}

assert_not_contains_regex() {
  local file="$LOG_DIR/$1"
  if grep -Eq "$2" "$file" 2>/dev/null; then
    echo "FAIL  $3 — unexpected /$2/ in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  else
    echo "PASS  $3 — correctly absent /$2/ in $1" >> "$SUMMARY"
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
# Detects "for fresh chat" in the prompt - this only appears when
# a chat session is foreground and the agent is idle (ready for input).
# The generic "Send a message..." prompt appears when NO session is foreground.
wait_for_chat() {
  local max_wait="${1:-25}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    local screen
    screen=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
    if echo "$screen" | grep -q "for fresh chat"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ─── App Lifecycle ────────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  # Kill the pane's entire process group BEFORE tmux kill-session. Otherwise
  # bun — a child of the pane's shell — gets reparented to init and lives on.
  # tmux gives us the shell's pid; ps gives us its pgid; one kill takes the
  # whole foreground tree (shell + bun + any claude subprocesses).
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    local pane_pid pgid
    pane_pid=$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)
    if [ -n "$pane_pid" ]; then
      pgid=$(ps -o pgid= -p "$pane_pid" 2>/dev/null | tr -d ' ')
      [ -n "$pgid" ] && [ "$pgid" != "0" ] && kill -TERM -"$pgid" 2>/dev/null || true
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
  # Remove the temp dir on success; preserve it on failure for forensics.
  if [ -n "${UAT_DIR:-}" ] && [ -d "$UAT_DIR" ]; then
    if [ "$exit_code" -eq 0 ]; then
      rm -rf "$UAT_DIR" 2>/dev/null || true
    else
      echo "  UAT_DIR preserved for forensics: $UAT_DIR (exit=$exit_code)"
    fi
  fi
}
trap cleanup EXIT

# Build env prefix string from optional args (e.g. "FLYWHEEL_CHAT_MODEL=haiku" "FOO=1")
_build_env_prefix() {
  # Project identity is explicit (PI-INTERACTION-068), so the launch directory is free to
  # differ from the directory that owns durable project state.
  local prefix="FLYWHEEL_PROJECT_ROOT=$UAT_DIR FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='${FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS:-1}'"
  for arg in "$@"; do
    prefix="$prefix $arg"
  done
  echo "$prefix"
}

# Start the TUI in a fresh tmux session.
# Optional args are passed as env vars: start_app "FLYWHEEL_CHAT_MODEL=haiku" "FOO=1"
start_app() {
  tmux new-session -d -s "$SESSION" -x 120 -y 40
  local env_prefix
  env_prefix=$(_build_env_prefix "$@")
  if [ -n "${FLYWHEEL_E2E_EXECUTION_DIR:-}" ]; then
    send_keys "cd $FLYWHEEL_E2E_EXECUTION_DIR && HOME=$UAT_DIR $env_prefix bun --conditions=browser run $PROJECT_DIR/src/cli/index.ts 2>$STDERR_LOG" Enter
  else
    send_keys "cd $PROJECT_DIR && $env_prefix bun run dev 2>$STDERR_LOG" Enter
  fi
  wait_for_chat 30
  capture "00-boot.log"
}

stop_app() {
  send_text "/exit"
  sleep "$WAIT_SHORT"
  capture "99-exit.log"
}

# Restart the TUI in the same tmux session.
# Optional args are passed as env vars: restart_app "FLYWHEEL_CHAT_MODEL=haiku"
restart_app() {
  send_text "/exit"
  sleep 10
  local env_prefix
  env_prefix=$(_build_env_prefix "$@")
  if [ -n "${FLYWHEEL_E2E_EXECUTION_DIR:-}" ]; then
    send_keys "cd $FLYWHEEL_E2E_EXECUTION_DIR && HOME=$UAT_DIR $env_prefix bun --conditions=browser run $PROJECT_DIR/src/cli/index.ts 2>>$STDERR_LOG" Enter
  else
    send_keys "$env_prefix bun run dev 2>>$STDERR_LOG" Enter
  fi
  sleep "$WAIT_MEDIUM"
}
