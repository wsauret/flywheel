#!/usr/bin/env bash
#
# Queue Workflow E2E Tests
#
# Tests the queue-based execution system for all workflow templates via tmux.
# Validates: idle screen, /start wizard, workflow execution, /work with plan,
# narrow terminal, and headless mode.
#
# Usage:
#   ./tests/e2e/test-queue-workflows.sh              # run all tests
#   ./tests/e2e/test-queue-workflows.sh --test N      # run specific test (1-7)
#   ./tests/e2e/test-queue-workflows.sh --quick       # fast tests only (no API calls)
#
# Prerequisites: tmux, bun
#
# Note: Tests 1-5 (idle, narrow, wizard, headless, /work start) do NOT require
# API keys. Tests 6-7 (full workflow execution) require ANTHROPIC_API_KEY.
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION="queue-e2e"
LOG_FILE="$SCRIPT_DIR/queue-workflows.log"

# ── Test Results ──

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
PASS_COUNT=0
FAIL_COUNT=0

pass_assert() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  ✓ $1"
}

fail_assert() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  ✗ $1"
}

assert_contains() {
  if echo "$1" | grep -q "$2"; then
    pass_assert "${3:-Found: $2}"
  else
    fail_assert "${3:-Missing: $2}"
  fi
}

assert_not_contains() {
  if echo "$1" | grep -q "$2"; then
    fail_assert "${3:-Should not contain: $2}"
  else
    pass_assert "${3:-Correctly absent: $2}"
  fi
}

pass_test() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  log "=== PASS: $1 ==="
}

fail_test() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  log "=== FAIL: $1 — $2 ==="
}

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

capture() { tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo ""; }

cleanup_session() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

start_tui() {
  local width="${1:-120}" height="${2:-40}"
  cleanup_session
  sleep 0.5
  local env_prefix=""
  shift 2 2>/dev/null || true
  for arg in "$@"; do
    env_prefix="$env_prefix export $arg &&"
  done
  tmux new-session -d -s "$SESSION" -x "$width" -y "$height" \
    "cd $PROJECT_DIR && $env_prefix bin/flywheel"
  sleep 3
}

wait_for_idle() {
  local max_wait="${1:-15}" waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    local screen
    screen=$(capture)
    if echo "$screen" | grep -q "Type a / command"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ──────────────────────────────────────────────────────────────────
# Test 1: Idle screen renders correctly
# ──────────────────────────────────────────────────────────────────
test_idle_screen() {
  local tn="Test 1: Idle screen renders correctly"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle state"; cleanup_session; return; fi
  local S; S=$(capture)
  assert_contains "$S" "FLYWHEEL" "Branding header"
  assert_contains "$S" "v0.0.1" "Version display"
  assert_contains "$S" "███████" "ASCII logo rendered"
  assert_contains "$S" "plan.*execute.*iterate" "Logo tagline"
  assert_contains "$S" "/start" "/start listed"
  assert_contains "$S" "/work" "/work listed"
  assert_contains "$S" "/plan" "/plan listed"
  assert_contains "$S" "/review" "/review listed"
  assert_contains "$S" "/ship" "/ship listed"
  assert_contains "$S" "Sessions" "Session sidebar visible"
  assert_contains "$S" "Type a / command" "Command prompt visible"
  assert_contains "$S" "Esc" "Footer Esc shortcut"
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 2: Narrow terminal (80x40) — sidebar hidden, core works
# Validates: VAL-CROSS-006
# ──────────────────────────────────────────────────────────────────
test_narrow_terminal() {
  local tn="Test 2: Narrow terminal 80x40 (VAL-CROSS-006)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 80 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle at 80x40"; cleanup_session; return; fi
  local S; S=$(capture)
  assert_not_contains "$S" "Sessions" "Sidebar hidden at 80 cols"
  assert_contains "$S" "FLYWHEEL" "Branding visible at 80 cols"
  assert_contains "$S" "Type a / command" "Prompt visible at 80 cols"
  assert_contains "$S" "/start" "Help commands visible"
  assert_contains "$S" "███████" "ASCII logo at narrow width"
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 3: /start wizard — shows picker with 5 workflow options
# Validates: VAL-SHELL-007, VAL-SHELL-008
# ──────────────────────────────────────────────────────────────────
test_start_wizard() {
  local tn="Test 3: /start wizard (VAL-SHELL-007/008)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle"; cleanup_session; return; fi
  # /start with description skips description question
  tmux send-keys -t "$SESSION" '/start add a hello world endpoint' Enter
  sleep 3
  local S; S=$(capture)
  assert_contains "$S" "Just Plan" "Picker: Just Plan"
  assert_contains "$S" "Plan + Work" "Picker: Plan + Work"
  assert_contains "$S" "Plan + Work + Review" "Picker: Plan + Work + Review"
  assert_contains "$S" "Full Queue" "Picker: Full Queue"
  assert_contains "$S" "Sprint" "Picker: Sprint"
  # Dismiss with Escape (VAL-SHELL-012)
  tmux send-keys -t "$SESSION" Escape
  sleep 2
  S=$(capture)
  assert_contains "$S" "Type a / command" "Returns to idle after Escape"
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 4: /start without args asks description first
# Validates: VAL-SHELL-006
# ──────────────────────────────────────────────────────────────────
test_start_no_args() {
  local tn="Test 4: /start no args (VAL-SHELL-006)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle"; cleanup_session; return; fi
  tmux send-keys -t "$SESSION" '/start' Enter
  sleep 3
  local S; S=$(capture)
  # Should ask "What do you want to build?" or similar description prompt
  assert_contains "$S" "build\|descri\|What" "Asks for description"
  tmux send-keys -t "$SESSION" Escape
  sleep 2
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 5: /work with plan file path starts queue execution
# Validates: VAL-SHELL-033
# ──────────────────────────────────────────────────────────────────
test_work_with_plan() {
  local tn="Test 5: /work with plan path (VAL-SHELL-033)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle"; cleanup_session; return; fi
  tmux send-keys -t "$SESSION" '/work tests/fixtures/two-phase-plan.md' Enter
  sleep 5
  local S; S=$(capture)
  # Should transition to working state
  assert_not_contains "$S" "Type a / command" "Not in idle mode"
  assert_contains "$S" "Step\|step\|Runtime\|00:" "Working state indicators"
  # Stop the workflow
  tmux send-keys -t "$SESSION" Escape; sleep 2
  tmux send-keys -t "$SESSION" Escape; sleep 3
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 6: Headless mode — queue processes without TUI
# Validates: VAL-CROSS-007
# ──────────────────────────────────────────────────────────────────
test_headless_mode() {
  local tn="Test 6: Headless mode (VAL-CROSS-007)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  local HEADLESS_LOG="$SCRIPT_DIR/headless-test.log"
  rm -f "$HEADLESS_LOG"
  local HEADLESS_SCRIPT="$SCRIPT_DIR/headless-smoke.ts"
  cat > "$HEADLESS_SCRIPT" << 'HEADLESS_EOF'
import { HeadlessAdapter } from "../../src/tui/adapters/headless"
import { EventBus } from "../../src/events/event-bus"
import type { FlywheelEvent } from "../../src/events/types"

const messages: string[] = []
const adapter = new HeadlessAdapter({
  logger: (msg: string) => messages.push(msg),
  timestamps: false,
})

const bus = new EventBus()
adapter.connect(bus)
adapter.start()

const events: FlywheelEvent[] = [
  { type: "workflow:started", planPath: "/test/plan.md", workflowId: "t1", totalSteps: 2, planTitle: "Test" },
  { type: "queue:initialized", workflowId: "t1", stepIds: ["s1","s2"], stepCount: 2 },
  { type: "queue:step-started", workflowId: "t1", stepId: "s1", stepType: "plan", stepTitle: "Create plan" },
  { type: "worker:spawned", workflowId: "t1", stepIndex: 0, pid: 1234 },
  { type: "worker:output", workflowId: "t1", stepIndex: 0, data: "Working on plan...\n", stream: "stdout" },
  { type: "worker:completed", workflowId: "t1", stepIndex: 0, exitCode: 0, durationMs: 5000, tokenUsage: undefined },
  { type: "step:completed", workflowId: "t1", stepIndex: 0, durationMs: 5000 },
  { type: "queue:step-completed", workflowId: "t1", stepId: "s1", stepType: "plan", stepTitle: "Create plan" },
  { type: "queue:step-started", workflowId: "t1", stepId: "s2", stepType: "work", stepTitle: "Execute work" },
  { type: "worker:spawned", workflowId: "t1", stepIndex: 1, pid: 1235 },
  { type: "worker:completed", workflowId: "t1", stepIndex: 1, exitCode: 0, durationMs: 3000, tokenUsage: undefined },
  { type: "step:completed", workflowId: "t1", stepIndex: 1, durationMs: 3000 },
  { type: "queue:step-completed", workflowId: "t1", stepId: "s2", stepType: "work", stepTitle: "Execute work" },
  { type: "queue:completed", workflowId: "t1", stepsCompleted: 2, totalSteps: 2, durationMs: 8000 },
  { type: "workflow:completed", workflowId: "t1", phasesCompleted: 2, phasesTotal: 2, durationMs: 8000 },
]

for (const event of events) {
  bus.emit(event)
}

adapter.stop()
adapter.disconnect()

const output = messages.join("\n")
let pass = 0, fail = 0

function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

check("Adapter started", output.includes("Workflow adapter started"))
check("Queue initialized", output.includes("Queue initialized"))
check("Queue step started", output.includes("Queue step started"))
check("Worker output logged", output.includes("Working on plan"))
check("Queue step completed", output.includes("Queue step completed"))
check("Queue completed", output.includes("Queue completed"))
check("Workflow completed", output.includes("Workflow completed"))
check("Adapter stopped", output.includes("Workflow adapter stopped"))

console.log("\n  Headless: " + pass + " passed, " + fail + " failed")
process.exit(fail > 0 ? 1 : 0)
HEADLESS_EOF

  if cd "$PROJECT_DIR" && bun run "$HEADLESS_SCRIPT" 2>"$HEADLESS_LOG"; then
    pass_assert "Headless adapter processes all queue events"
    PASS_COUNT=$((PASS_COUNT + 8))
  else
    fail_assert "Headless adapter test failed"
    cat "$HEADLESS_LOG" >> "$LOG_FILE" 2>/dev/null || true
  fi
  rm -f "$HEADLESS_SCRIPT"
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 7: Narrow terminal /work execution (80x40)
# Validates: VAL-CROSS-006 execution works without panel
# ──────────────────────────────────────────────────────────────────
test_narrow_work() {
  local tn="Test 7: Narrow terminal /work execution (VAL-CROSS-006)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"
  start_tui 80 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle at 80x40"; cleanup_session; return; fi
  tmux send-keys -t "$SESSION" '/work tests/fixtures/two-phase-plan.md' Enter
  sleep 5
  local S; S=$(capture)
  # Should be in working state even at narrow width
  assert_not_contains "$S" "Type a / command" "Not in idle at 80x40"
  assert_contains "$S" "Runtime\|00:\|Step\|Executing" "Working indicators at 80x40"
  # Panel should NOT be visible at 80 cols (< 120 threshold)
  # We just verify execution is working (not stuck at idle)
  # Stop
  tmux send-keys -t "$SESSION" Escape; sleep 2
  tmux send-keys -t "$SESSION" Escape; sleep 3
  cleanup_session
  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

: > "$LOG_FILE"

log "=== Queue Workflow E2E Tests ==="
log "Project: $PROJECT_DIR"
log ""

# Parse arguments
RUN_TEST=""
QUICK_MODE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --test) RUN_TEST="$2"; shift 2 ;;
    --quick) QUICK_MODE=true; shift ;;
    *) log "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -n "$RUN_TEST" ]; then
  case "$RUN_TEST" in
    1) test_idle_screen ;;
    2) test_narrow_terminal ;;
    3) test_start_wizard ;;
    4) test_start_no_args ;;
    5) test_work_with_plan ;;
    6) test_headless_mode ;;
    7) test_narrow_work ;;
    *) log "Unknown test: $RUN_TEST (valid: 1-7)"; exit 1 ;;
  esac
else
  test_idle_screen
  test_narrow_terminal
  test_start_wizard
  test_start_no_args
  test_work_with_plan
  test_headless_mode
  test_narrow_work
fi

# ── Summary ──

log ""
log "=== Queue Workflow E2E Summary ==="
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
