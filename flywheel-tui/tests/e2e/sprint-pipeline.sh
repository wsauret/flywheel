#!/usr/bin/env bash
#
# Sprint Pipeline E2E Test
#
# Tests sprint mode end-to-end in the actual TUI via tmux.
# Uses real API calls; takes several minutes per test.
#
# Usage:
#   ./tests/e2e/sprint-pipeline.sh                # run all tests
#   ./tests/e2e/sprint-pipeline.sh --test 1       # run specific test (1-4)
#   ./tests/e2e/sprint-pipeline.sh --attach       # attach to watch live
#
# Prerequisites: tmux, valid API key (ANTHROPIC_API_KEY etc.)
#
# To kill a running test:
#   pkill -f sprint-pipeline.sh; tmux kill-session -t sprint-e2e
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION="sprint-e2e"
LOG_FILE="$SCRIPT_DIR/sprint-pipeline.log"
POLL_INTERVAL=10

# Sonnet is reliable for sprint tasks; haiku may not follow instructions well.
export FLYWHEEL_MODEL="${FLYWHEEL_MODEL:-sonnet}"

# ── Helpers ──

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

capture() { tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo ""; }

# Sprint-specific state detection.
# Recognizes sprint iteration counters, system messages, and standard states.
detect_sprint_state() {
  local screen="$1"

  if echo "$screen" | grep -q "no server running\|session not found"; then
    echo "CRASHED"; return
  fi

  if echo "$screen" | grep -q "Type a / command\|/work.*Run a plan"; then
    echo "LAUNCHER"; return
  fi

  # Sprint-specific patterns (from opentui adapter system messages)
  if echo "$screen" | grep -q "Sprint escalating"; then
    echo "sprint:escalated"; return
  fi

  if echo "$screen" | grep -q "Sprint completed\|Sprint stopped"; then
    echo "sprint:completed"; return
  fi

  # Telemetry bar shows "Sprint N/M" during active iteration
  local sprint_iter=""
  sprint_iter=$(echo "$screen" | grep -o "Sprint [0-9]*/[0-9]*" | head -1 || true)
  if [ -n "$sprint_iter" ]; then
    echo "sprint:running ($sprint_iter)"; return
  fi

  # Sprint started system message
  if echo "$screen" | grep -q "Sprint started"; then
    echo "sprint:started"; return
  fi

  # Fallback: standard pipeline states
  local wf="" status=""
  if echo "$screen" | grep -q "plan •"; then wf="plan"
  elif echo "$screen" | grep -q "review •"; then wf="review"
  elif echo "$screen" | grep -q "docs/plans/\|work •"; then wf="work"
  elif echo "$screen" | grep -q "sprint •"; then wf="sprint"
  fi

  if echo "$screen" | grep -q "Completed"; then status="completed"
  elif echo "$screen" | grep -q "[Rr]unning"; then status="running"
  elif echo "$screen" | grep -q "Workflow idle"; then status="idle"
  fi

  if [ -n "$wf" ] && [ -n "$status" ]; then
    echo "${wf}:${status}"
  elif [ -n "$status" ]; then
    echo "unknown:${status}"
  else
    echo "UNKNOWN"
  fi
}

# Check log file for ERROR entries. Returns 0 if clean, 1 if errors found.
check_log_errors() {
  local log_dir="$PROJECT_DIR/.flywheel/log"
  local latest
  latest=$(ls -t "$log_dir"/*.log 2>/dev/null | head -1 || true)
  if [ -z "$latest" ]; then
    log "  No log file found in $log_dir"
    return 0
  fi
  local errors
  errors=$(grep -c "^ERROR" "$latest" 2>/dev/null || echo "0")
  if [ "$errors" -gt 0 ]; then
    log "  WARN: $errors ERROR entries found in $latest"
    grep "^ERROR" "$latest" | head -5 | while read -r line; do
      log "    $line"
    done
    return 1
  fi
  log "  Log clean: 0 ERROR entries"
  return 0
}

cleanup() {
  log "Cleaning up..."
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$PROJECT_DIR/tests/sandbox" 2>/dev/null || true
}

trap cleanup EXIT

# Start TUI in tmux with optional env overrides.
# Usage: start_tui [ENV_VAR=value ...]
start_tui() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  sleep 0.5
  local env_prefix=""
  for arg in "$@"; do
    env_prefix="$env_prefix export $arg &&"
  done
  tmux new-session -d -s "$SESSION" -x 120 -y 40 \
    "cd $PROJECT_DIR && $env_prefix bin/flywheel"
  sleep 3
}

# Wait for launcher to be ready. Returns 0 on success, 1 on timeout.
wait_for_launcher() {
  local max_wait="${1:-15}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    local screen state
    screen=$(capture)
    state=$(detect_sprint_state "$screen")
    if [ "$state" = "LAUNCHER" ]; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Launch a sprint via /start command. Sends description, selects Sprint mode (option 5).
# Usage: start_sprint "task description"
start_sprint() {
  local desc="$1"
  log "  Sending: /start $desc"
  tmux send-keys -t "$SESSION" "/start $desc" Enter
  sleep 3

  # Select Sprint mode — option 5
  log "  Selecting Sprint mode (option 5)"
  tmux send-keys -t "$SESSION" "5"
  sleep 3
}

# ── Test Results ──

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass_test() {
  local name="$1"
  TESTS_PASSED=$((TESTS_PASSED + 1))
  log ""
  log "=== PASS: $name ==="
  log ""
}

fail_test() {
  local name="$1" reason="$2"
  TESTS_FAILED=$((TESTS_FAILED + 1))
  log ""
  log "=== FAIL: $name — $reason ==="
  capture >> "$LOG_FILE"
  log ""
}

# ──────────────────────────────────────────────────────────────────
# Test 1: Trivial sprint completes (VAL-E2E-001, VAL-E2E-005, VAL-TUI-003)
# ──────────────────────────────────────────────────────────────────
test_trivial_sprint() {
  local test_name="Test 1: Trivial sprint completes"
  local timeout=300  # 5 minutes
  TESTS_RUN=$((TESTS_RUN + 1))
  log "── $test_name ──"

  start_tui
  if ! wait_for_launcher; then
    fail_test "$test_name" "TUI did not reach launcher"
    return
  fi
  log "  Launcher ready."

  start_sprint "add a hello world function in tests/sandbox/hello.ts that exports greet(name) returning Hello name"

  local start_time elapsed screen state prev_state=""
  local seen_sprint_iter=0 seen_telemetry_bar=0
  start_time=$(date +%s)

  while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail_test "$test_name" "TIMEOUT after ${elapsed}s (last: $prev_state)"
      return
    fi

    screen=$(capture)
    state=$(detect_sprint_state "$screen")

    if [ "$state" != "$prev_state" ]; then
      log "  State: $state (${elapsed}s)"
      prev_state="$state"
    fi

    # VAL-TUI-003: Check for Sprint N/M in telemetry bar
    if echo "$screen" | grep -q "Sprint [0-9]*/[0-9]*"; then
      if [ "$seen_telemetry_bar" -eq 0 ]; then
        local bar_text
        bar_text=$(echo "$screen" | grep -o "Sprint [0-9]*/[0-9]*" | head -1)
        log "  VAL-TUI-003: Telemetry bar shows '$bar_text'"
        seen_telemetry_bar=1
      fi
      seen_sprint_iter=1
    fi

    case "$state" in
      CRASHED)
        fail_test "$test_name" "TUI crashed"
        return
        ;;
      sprint:completed|*:completed|*:idle|LAUNCHER)
        if [ "$seen_sprint_iter" -eq 1 ]; then
          # VAL-E2E-005: Check logs for errors
          if check_log_errors; then
            if [ "$seen_telemetry_bar" -eq 1 ]; then
              pass_test "$test_name (VAL-E2E-001, VAL-E2E-005, VAL-TUI-003)"
            else
              pass_test "$test_name (VAL-E2E-001, VAL-E2E-005)"
              log "  NOTE: VAL-TUI-003 not captured (telemetry bar text)"
            fi
          else
            fail_test "$test_name" "ERROR entries in log (VAL-E2E-005)"
          fi
          return
        fi
        # Sprint completed but we never saw an iteration — wait a bit more
        if [ "$elapsed" -gt 30 ]; then
          fail_test "$test_name" "Completed without seeing sprint iteration"
          return
        fi
        ;;
    esac

    sleep "$POLL_INTERVAL"
  done
}

# ──────────────────────────────────────────────────────────────────
# Test 2: Sprint retry/iteration (VAL-E2E-002)
# ──────────────────────────────────────────────────────────────────
test_sprint_retry() {
  local test_name="Test 2: Sprint retry shows iteration > 1"
  local timeout=600  # 10 minutes — needs multiple iterations
  TESTS_RUN=$((TESTS_RUN + 1))
  log "── $test_name ──"

  start_tui
  if ! wait_for_launcher; then
    fail_test "$test_name" "TUI did not reach launcher"
    return
  fi
  log "  Launcher ready."

  # Use a task that's likely to need verification retries
  start_sprint "create tests/sandbox/fizzbuzz.ts with a fizzbuzz function and tests/sandbox/fizzbuzz.test.ts with 10 unit tests covering edge cases including 0 negative and large numbers"

  local start_time elapsed screen state prev_state=""
  local max_iter_seen=0
  start_time=$(date +%s)

  while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if [ "$elapsed" -ge "$timeout" ]; then
      if [ "$max_iter_seen" -gt 1 ]; then
        pass_test "$test_name (VAL-E2E-002) — saw iteration $max_iter_seen (timeout ok)"
      else
        fail_test "$test_name" "TIMEOUT: max iteration seen = $max_iter_seen"
      fi
      return
    fi

    screen=$(capture)
    state=$(detect_sprint_state "$screen")

    if [ "$state" != "$prev_state" ]; then
      log "  State: $state (${elapsed}s)"
      prev_state="$state"
    fi

    # Extract iteration number from "Sprint N/M" or system messages
    local iter_num
    iter_num=$(echo "$screen" | grep -o "Sprint [0-9]*/[0-9]*" | head -1 | grep -o "[0-9]*/" | tr -d "/" || true)
    if [ -n "$iter_num" ] && [ "$iter_num" -gt "$max_iter_seen" ]; then
      max_iter_seen="$iter_num"
      log "  Iteration: $max_iter_seen"
    fi

    # Also check system messages like "Sprint iteration 2/5"
    local sys_iter
    sys_iter=$(echo "$screen" | grep -o "iteration [0-9]*/[0-9]*" | head -1 | grep -o "[0-9]*/" | tr -d "/" || true)
    if [ -n "$sys_iter" ] && [ "$sys_iter" -gt "$max_iter_seen" ]; then
      max_iter_seen="$sys_iter"
      log "  Iteration (system msg): $max_iter_seen"
    fi

    case "$state" in
      CRASHED)
        fail_test "$test_name" "TUI crashed"
        return
        ;;
      sprint:completed|sprint:escalated|*:completed|*:idle|LAUNCHER)
        if [ "$max_iter_seen" -gt 1 ]; then
          pass_test "$test_name (VAL-E2E-002) — saw iteration $max_iter_seen"
        else
          fail_test "$test_name" "Sprint ended with max iteration $max_iter_seen (need > 1)"
        fi
        return
        ;;
    esac

    sleep "$POLL_INTERVAL"
  done
}

# ──────────────────────────────────────────────────────────────────
# Test 3: User cancellation (VAL-E2E-004)
# ──────────────────────────────────────────────────────────────────
test_user_cancellation() {
  local test_name="Test 3: User cancellation stops sprint"
  local timeout=120  # 2 minutes — we just need sprint to start
  TESTS_RUN=$((TESTS_RUN + 1))
  log "── $test_name ──"

  start_tui
  if ! wait_for_launcher; then
    fail_test "$test_name" "TUI did not reach launcher"
    return
  fi
  log "  Launcher ready."

  start_sprint "create tests/sandbox/cancel-test.ts with a fibonacci function"

  # Wait for sprint to actually start running
  local start_time elapsed screen state
  local sprint_started=0
  start_time=$(date +%s)

  while [ "$sprint_started" -eq 0 ]; do
    elapsed=$(( $(date +%s) - start_time ))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail_test "$test_name" "Sprint never started (timeout)"
      return
    fi
    screen=$(capture)
    state=$(detect_sprint_state "$screen")
    log "  Waiting for sprint start: $state (${elapsed}s)"
    case "$state" in
      sprint:*|*:running)
        sprint_started=1
        log "  Sprint is running, sending Escape sequence"
        ;;
      CRASHED)
        fail_test "$test_name" "TUI crashed before sprint started"
        return
        ;;
    esac
    sleep 5
  done

  # Double Escape to stop
  tmux send-keys -t "$SESSION" Escape
  sleep 2
  tmux send-keys -t "$SESSION" Escape
  sleep 5

  screen=$(capture)
  state=$(detect_sprint_state "$screen")
  log "  After Escape: $state"

  # Verify sprint stopped — should be completed/paused/idle, not running
  case "$state" in
    *:completed|*:idle|LAUNCHER|sprint:completed)
      # Check no orphaned worker processes (claude/opencode)
      local orphans
      orphans=$(pgrep -f "claude.*sprint-e2e" 2>/dev/null | wc -l | tr -d " " || echo "0")
      if [ "$orphans" -gt 0 ]; then
        fail_test "$test_name" "$orphans orphaned worker process(es)"
      else
        pass_test "$test_name (VAL-E2E-004)"
      fi
      ;;
    CRASHED)
      fail_test "$test_name" "TUI crashed on cancellation"
      ;;
    *)
      # Wait a bit more for state transition
      sleep 10
      screen=$(capture)
      state=$(detect_sprint_state "$screen")
      log "  After extra wait: $state"
      case "$state" in
        *:completed|*:idle|LAUNCHER|sprint:completed)
          pass_test "$test_name (VAL-E2E-004)"
          ;;
        *)
          fail_test "$test_name" "Sprint still active after Escape: $state"
          ;;
      esac
      ;;
  esac
}

# ──────────────────────────────────────────────────────────────────
# Test 4: Escalation (VAL-E2E-003)
# ──────────────────────────────────────────────────────────────────
test_escalation() {
  local test_name="Test 4: Sprint escalation to plan"
  local timeout=900  # 15 minutes — needs sprint to exhaust + plan to start
  TESTS_RUN=$((TESTS_RUN + 1))
  log "── $test_name ──"

  # Force low max_iterations so escalation triggers quickly
  start_tui "FLYWHEEL_SPRINT_MAX_ITERATIONS=2" "FLYWHEEL_SPRINT_ESCALATE_TO_FULL=true"
  if ! wait_for_launcher; then
    fail_test "$test_name" "TUI did not reach launcher"
    return
  fi
  log "  Launcher ready."

  # A complex task that sprint with 2 iterations likely cannot complete
  start_sprint "refactor the entire cron parser module to support 7-field cron expressions with seconds and year fields and add comprehensive unit tests covering all edge cases"

  local start_time elapsed screen state prev_state=""
  local seen_escalation=0 seen_plan=0
  start_time=$(date +%s)

  while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if [ "$elapsed" -ge "$timeout" ]; then
      if [ "$seen_escalation" -eq 1 ]; then
        pass_test "$test_name (VAL-E2E-003) — escalation seen (plan stage timeout ok)"
      else
        fail_test "$test_name" "TIMEOUT: escalation=$seen_escalation plan=$seen_plan"
      fi
      return
    fi

    screen=$(capture)
    state=$(detect_sprint_state "$screen")

    if [ "$state" != "$prev_state" ]; then
      log "  State: $state (${elapsed}s)"
      prev_state="$state"
    fi

    # Check for escalation indicators
    if echo "$screen" | grep -qi "escalat"; then
      if [ "$seen_escalation" -eq 0 ]; then
        log "  Escalation detected!"
        seen_escalation=1
      fi
    fi

    # Check for plan stage after escalation
    if [ "$seen_escalation" -eq 1 ]; then
      if echo "$screen" | grep -q "plan •\|Creating plan"; then
        seen_plan=1
        log "  Plan stage started after escalation."
        pass_test "$test_name (VAL-E2E-003)"
        return
      fi
    fi

    case "$state" in
      CRASHED)
        fail_test "$test_name" "TUI crashed"
        return
        ;;
      sprint:escalated)
        seen_escalation=1
        log "  Escalation state detected"
        ;;
      *:completed|*:idle|LAUNCHER)
        if [ "$seen_escalation" -eq 1 ]; then
          pass_test "$test_name (VAL-E2E-003) — escalated then completed"
        else
          fail_test "$test_name" "Sprint ended without escalation"
        fi
        return
        ;;
    esac

    sleep "$POLL_INTERVAL"
  done
}

# ── Main ──

: > "$LOG_FILE"

log "=== Sprint Pipeline E2E Test ==="
log "Project: $PROJECT_DIR"
log ""

# Parse arguments
RUN_TEST=""
ATTACH=false
while [ $# -gt 0 ]; do
  case "$1" in
    --test) RUN_TEST="$2"; shift 2 ;;
    --attach) ATTACH=true; shift ;;
    *) log "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ "$ATTACH" = true ]; then
  log "(--attach mode: will attach to tmux for first test)"
fi

if [ -n "$RUN_TEST" ]; then
  case "$RUN_TEST" in
    1) test_trivial_sprint ;;
    2) test_sprint_retry ;;
    3) test_user_cancellation ;;
    4) test_escalation ;;
    *) log "Unknown test: $RUN_TEST (valid: 1-4)"; exit 1 ;;
  esac
else
  test_trivial_sprint
  test_sprint_retry
  test_user_cancellation
  test_escalation
fi

# ── Summary ──

log ""
log "=== Sprint E2E Summary ==="
log "Tests run: $TESTS_RUN"
log "Passed:    $TESTS_PASSED"
log "Failed:    $TESTS_FAILED"
log ""

if [ "$TESTS_FAILED" -gt 0 ]; then
  log "RESULT: FAIL"
  exit 1
else
  log "RESULT: PASS"
  exit 0
fi
