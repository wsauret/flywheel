#!/usr/bin/env bash
#
# Shared test harness for flywheel plugin UAT.
# Source from each module script:
#
#   source "$(dirname "$0")/lib/harness.sh"
#   init_harness "uat-a-full-pipeline" "$@"
#   start_claude
#   send_prompt "/fly:plan ..."
#   wait_for_file "$UAT_DIR/.flywheel/plugin/active.json" 420
#   assert_session_valid
#   stop_claude
#   finish_harness
#
# Each module runs real `claude --dangerously-skip-permissions` in tmux inside
# an isolated /tmp workspace. Assertions primarily check filesystem artifacts
# via validate-session.sh.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
UAT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UAT_ROOT="$(cd "$UAT_LIB_DIR/.." && pwd)"
SESSION="fly-uat-$$"
UAT_DIR=""

# Timing defaults (claude + subagent invocations are slow).
WAIT_SHORT=4
WAIT_MEDIUM=15
WAIT_TRUST=6
WAIT_PLAN=420       # plan-creation with locators can take 3-5 min
WAIT_REVIEW=720     # 6 parallel reviewers + synthesizer
WAIT_WORK=1200      # multi-phase work-implementation

PASS_COUNT=0
FAIL_COUNT=0
ACTIVE_SESSION_DIR=""  # populated after first plan; validator target

init_harness() {
  local module_name="${1:?module name required}"
  local base_dir="${2:-$UAT_ROOT/results/$(date +%Y%m%d-%H%M%S)}"

  LOG_DIR="$base_dir/$module_name"
  STDERR_LOG="$LOG_DIR/stderr.log"
  SUMMARY="$LOG_DIR/summary.log"

  mkdir -p "$LOG_DIR"
  echo "Module: $module_name — $(date)" > "$SUMMARY"
  echo "Log directory: $LOG_DIR" >> "$SUMMARY"
  echo "---" >> "$SUMMARY"

  UAT_DIR=$(mktemp -d /tmp/flywheel-uat-XXXXXX)
  tmux kill-session -t "$SESSION" 2>/dev/null || true

  echo "[$module_name] Starting tests... (UAT_DIR=$UAT_DIR)"
}

finish_harness() {
  echo "---" >> "$SUMMARY"
  echo "PASS: $PASS_COUNT" >> "$SUMMARY"
  echo "FAIL: $FAIL_COUNT" >> "$SUMMARY"
  echo "TOTAL: $((PASS_COUNT + FAIL_COUNT))" >> "$SUMMARY"

  echo ""
  echo "  $PASS_COUNT passed, $FAIL_COUNT failed - $LOG_DIR"
  echo ""
  [ "$FAIL_COUNT" -eq 0 ]
}

# --- Helpers ----------------------------------------------------------------

capture() {
  local file="$LOG_DIR/$1"
  sleep "${2:-1}"
  tmux capture-pane -t "$SESSION" -p -S -200 > "$file" 2>/dev/null || true
}

send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

send_text() {
  send_keys "$1" Enter
}

# Send a prompt to claude's input box. Uses two Enters because the first
# sometimes just submits the input field rather than firing the prompt.
send_prompt() {
  send_keys "$1" Enter
  sleep 3
  send_keys Enter
}

# Wait until a given file exists. Polls every 5s.
# Usage: wait_for_file <path> <timeout_seconds>
wait_for_file() {
  local path="$1"
  local timeout="${2:-300}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ -f "$path" ]; then
      echo "  file appeared after ${waited}s: $(basename "$path")"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "  TIMEOUT waiting for $(basename "$path") (${timeout}s)"
  return 1
}

# Wait until a glob pattern resolves to ≥1 file.
# Usage: wait_for_glob <pattern> <timeout_seconds>
wait_for_glob() {
  local pattern="$1"
  local timeout="${2:-300}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    # ls returns 0 iff at least one match
    if ls $pattern >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "  TIMEOUT waiting for glob $pattern (${timeout}s)"
  return 1
}

# Wait until state.json reports all phases completed.
wait_for_work_complete() {
  local timeout="${1:-1200}"
  local waited=0
  local state="$ACTIVE_SESSION_DIR/state.json"
  while [ "$waited" -lt "$timeout" ]; do
    if [ -f "$state" ]; then
      # status=completed at the top-level AND all phases completed
      if jq -e '(.status == "completed") and (all(.phases[]; .status == "completed"))' "$state" > /dev/null 2>&1; then
        echo "  work complete after ${waited}s"
        return 0
      fi
    fi
    sleep 10
    waited=$((waited + 10))
  done
  echo "  TIMEOUT waiting for work completion (${timeout}s)"
  return 1
}

_record() {
  local tag="$1" name="$2" detail="$3"
  printf '%-5s %s - %s\n' "$tag" "$name" "$detail" >> "$SUMMARY"
}

pass() { PASS_COUNT=$((PASS_COUNT + 1)); _record "PASS" "$1" "$2"; echo "  PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); _record "FAIL" "$1" "$2"; echo "  FAIL: $1 - $2"; }

assert_file() {
  local name="$1" path="$2"
  if [ -f "$path" ]; then
    pass "$name" "file exists: $(basename "$path")"
  else
    fail "$name" "missing: $path"
  fi
}

assert_file_absent() {
  local name="$1" path="$2"
  if [ ! -f "$path" ]; then
    pass "$name" "absent as expected: $(basename "$path")"
  else
    fail "$name" "unexpected file: $path"
  fi
}

# Assert JSON field equals expected value.
# Usage: assert_json_eq <name> <file> <jq_expr> <expected>
assert_json_eq() {
  local name="$1" file="$2" expr="$3" expected="$4"
  local actual
  actual=$(jq -r "$expr" "$file" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    pass "$name" "$expr=$expected"
  else
    fail "$name" "$expr expected=$expected actual=$actual"
  fi
}

# Run validate-session.sh against the active session and record its PASS/FAIL
# results into THIS module's summary. Each validator line becomes one assertion.
assert_session_valid() {
  local session_dir="${1:-$ACTIVE_SESSION_DIR}"
  local name="${2:-session-validation}"
  local report="$LOG_DIR/validate.log"
  bash "$UAT_ROOT/validate-session.sh" "$session_dir" > "$report" 2>&1 || true

  local v_pass v_fail
  v_pass=$(grep -c '^PASS:' "$report" 2>/dev/null || echo 0)
  v_fail=$(grep -c '^FAIL:' "$report" 2>/dev/null || echo 0)

  # Roll each validator line into our summary as its own line-item.
  while IFS= read -r line; do
    case "$line" in
      PASS:*)
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "PASS  $name/validator - ${line#PASS: }" >> "$SUMMARY"
        ;;
      FAIL:*)
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "FAIL  $name/validator - ${line#FAIL: }" >> "$SUMMARY"
        ;;
    esac
  done < "$report"

  echo "  validator: $v_pass passed, $v_fail failed (see $report)"
  [ "$v_fail" -eq 0 ]
}

# Populate ACTIVE_SESSION_DIR from active.json (must exist first).
detect_active_session() {
  local active="$UAT_DIR/.flywheel/plugin/active.json"
  if [ ! -f "$active" ]; then
    fail "detect-active" "$active missing"
    return 1
  fi
  local sid
  sid=$(jq -r '.session_id' "$active")
  ACTIVE_SESSION_DIR="$UAT_DIR/.flywheel/plugin/sessions/$sid"
  echo "  active session: $sid"
  pass "active-pointer" "session_id=$sid"
}

# --- Claude lifecycle -------------------------------------------------------

cleanup() {
  local exit_code=$?
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    # Capture final screen for forensics before killing.
    tmux capture-pane -t "$SESSION" -p -S -300 > "$LOG_DIR/99-final.log" 2>/dev/null || true
    local pane_pid pgid
    pane_pid=$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)
    if [ -n "$pane_pid" ]; then
      pgid=$(ps -o pgid= -p "$pane_pid" 2>/dev/null | tr -d ' ')
      [ -n "$pgid" ] && [ "$pgid" != "0" ] && kill -TERM -"$pgid" 2>/dev/null || true
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
  # Preserve UAT_DIR on failure for forensics.
  if [ -n "${UAT_DIR:-}" ] && [ -d "$UAT_DIR" ]; then
    if [ "$exit_code" -eq 0 ] && [ "$FAIL_COUNT" -eq 0 ]; then
      rm -rf "$UAT_DIR" 2>/dev/null || true
    else
      echo "  UAT_DIR preserved for forensics: $UAT_DIR (exit=$exit_code, fail_count=$FAIL_COUNT)"
    fi
  fi
}
trap cleanup EXIT

start_claude() {
  tmux new-session -d -s "$SESSION" -x 200 -y 60 -c "$UAT_DIR"
  # Launch claude and accept the trust prompt.
  send_text "claude --dangerously-skip-permissions"
  sleep "$WAIT_TRUST"
  send_keys Enter    # confirm "Yes, trust this folder"
  sleep "$WAIT_SHORT"
  capture "00-boot.log"
}

stop_claude() {
  # /exit is cleaner than SIGINT for claude cli
  send_text "/exit"
  sleep "$WAIT_SHORT"
  capture "99-exit.log"
}

# Fresh claude session in the SAME UAT_DIR — used to test resume flow.
restart_claude() {
  stop_claude
  sleep 3
  send_text "claude --dangerously-skip-permissions"
  sleep "$WAIT_TRUST"
  send_keys Enter
  sleep "$WAIT_SHORT"
  capture "restart-boot.log"
}
