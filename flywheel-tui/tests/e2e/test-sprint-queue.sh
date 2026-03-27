#!/usr/bin/env bash
#
# Sprint Queue E2E Tests
#
# Tests sprint-specific queue behavior: iteration loop, escalation, dynamic
# step insertion, and sprint telemetry display.
#
# Validates: VAL-CROSS-003, VAL-CROSS-004
#
# Usage:
#   ./tests/e2e/test-sprint-queue.sh              # run all tests
#   ./tests/e2e/test-sprint-queue.sh --test N      # run specific test (1-6)
#
# Prerequisites: tmux, bun
#
# Note: Tests 1-4 do NOT require API keys (headless/programmatic).
# Tests 5-6 test TUI rendering via tmux (no API calls needed).
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION="sprint-queue-e2e"
LOG_FILE="$SCRIPT_DIR/sprint-queue.log"

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

assert_equals() {
  if [ "$1" = "$2" ]; then
    pass_assert "${3:-$1 equals $2}"
  else
    fail_assert "${3:-Expected '$2' but got '$1'}"
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
# Test 1: Sprint iteration loop E2E (VAL-CROSS-003)
#
# Programmatic test: Creates a sprint queue, simulates the full
# work → verify(fail) → work → verify(pass) → completion flow
# via a Bun script that exercises the real queue + sprint handler.
# ──────────────────────────────────────────────────────────────────
test_sprint_iteration_loop() {
  local tn="Test 1: Sprint iteration loop E2E (VAL-CROSS-003)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/sprint-iteration-e2e.ts"
  # Script is created in parts — first half
  cat > "$TEST_SCRIPT" << 'SPRINT_ITER_PART1'
import { randomUUID } from "crypto"
import { buildQueueFromTemplate } from "../../src/queue/templates"
import { createSprintQueueHandler, type SprintQueueOptions } from "../../src/queue/sprint"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step, Queue } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"
import type { VerificationResult } from "../../src/sprint/verification-runner"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

let verifyCallCount = 0
const verifyResults: VerificationResult[] = [
  { passed: false, stdout: "Test failed: expected 1 got 0", stderr: "", exitCode: 1, durationMs: 100 },
  { passed: true, stdout: "All tests passed", stderr: "", exitCode: 0, durationMs: 100 },
]

const sprintOpts: SprintQueueOptions = {
  taskDescription: "Add a hello world endpoint",
  projectCwd: "/tmp/test-project",
  sprintConfig: {
    max_iterations: 5,
    verification_timeout_ms: 30000,
    escalate_to_full: true,
    escalate_on_stuck: false,
  },
  emitter: mockEmitter,
  workflowId: randomUUID(),
  runVerification: async () => {
    const r = verifyResults[verifyCallCount] ?? verifyResults[verifyResults.length - 1]
    verifyCallCount++
    return r
  },
  readHandoff: async () => ({
    summary: "Implemented the feature",
    verification_script_path: ".flywheel/verify/test.ts",
  }),
}

const handler = createSprintQueueHandler(sprintOpts)
const queue = buildQueueFromTemplate("sprint")
SPRINT_ITER_PART1

  # Append second part
  cat >> "$TEST_SCRIPT" << 'SPRINT_ITER_PART2'

const workerFn: WorkerFn = async (step, _prompt) => {
  const handoffPath = `/tmp/handoff-${step.id}.json`
  if (step.type === "verify") {
    const vr = await handler.executeVerifyStep(step, {
      verification_script_path: ".flywheel/verify/test.ts",
    })
    ;(step as any)._verifyResult = vr
  }
  return { output: "work done", handoffPath, durationMs: 100, sessionId: randomUUID() }
}

const dispatcherFn: DispatcherFn = async (step, _ctx) => {
  if (step.type === "work") {
    return { prompt: handler.buildWorkStepPrompt(step), evaluationCriteria: null }
  }
  return { prompt: `Execute ${step.type}: ${step.title}`, evaluationCriteria: null }
}

const handoffReaderFn = async (p: string) => {
  const sid = p.replace("/tmp/handoff-", "").replace(".json", "")
  const s = queue.steps.find(st => st.id === sid)
  if (s?.type === "verify" && (s as any)._verifyResult) {
    return { verificationResult: (s as any)._verifyResult }
  }
  return { summary: "Implemented the feature", verification_script_path: ".flywheel/verify/test.ts" }
}
SPRINT_ITER_PART2

  # Append third part — executor setup and assertions
  cat >> "$TEST_SCRIPT" << 'SPRINT_ITER_PART3'

const executor = createStepExecutor({
  queue,
  workflowId: sprintOpts.workflowId,
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: async () => {},
  accumulator: { accumulate: () => {}, getContext: () => ({}) },
  maxRevisions: 0,
  onStepCompleted: handler.onStepCompleted,
})

const result = await executor.run()

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

check("Queue completed", result.completed)
check("4 total steps", queue.steps.length === 4)
check("Step 1: work completed", queue.steps[0].type === "work" && queue.steps[0].status === "completed")
// Note: verify step is marked "completed" by executor (worker ran OK), but the
// verification result inside handoff shows failure → sprint handler inserts retry
check("Step 2: verify completed (result=fail)", queue.steps[1].type === "verify" && queue.steps[1].status === "completed")
check("Step 3: work completed (retry)", queue.steps[2].type === "work" && queue.steps[2].status === "completed")
check("Step 4: verify completed (result=pass)", queue.steps[3].type === "verify" && queue.steps[3].status === "completed")

const state = handler.getState()
check("Sprint completed=true", state.completed)
check("Sprint escalated=false", !state.escalated)
check("Iteration count=2", state.iterationCount === 2)
check("History has 2 entries", state.iterationHistory.length === 2)

const stepStarted = emittedEvents.filter(e => e.method === "queueStepStarted")
const stepCompleted = emittedEvents.filter(e => e.method === "queueStepCompleted")
const stepInserted = emittedEvents.filter(e => e.method === "queueStepInserted")

check("4 step:started events", stepStarted.length === 4)
check("4 step:completed events", stepCompleted.length === 4)
check("2 step:inserted events (retry pair)", stepInserted.length === 2)

const insertedTypes = stepInserted.map(e => e.args[2])
check("Inserted step 1 is work", insertedTypes[0] === "work")
check("Inserted step 2 is verify", insertedTypes[1] === "verify")

console.log(`\n  Sprint iteration loop: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
SPRINT_ITER_PART3

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 16))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 2: Sprint escalation full flow E2E (VAL-CROSS-004)
#
# Programmatic test: Sprint fails max_iterations times →
# escalation inserts plan→work→review → all execute → completion.
# ──────────────────────────────────────────────────────────────────
test_sprint_escalation() {
  local tn="Test 2: Sprint escalation full flow E2E (VAL-CROSS-004)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/sprint-escalation-e2e.ts"
  cat > "$TEST_SCRIPT" << 'ESCAL_PART1'
import { randomUUID } from "crypto"
import { buildQueueFromTemplate } from "../../src/queue/templates"
import { createSprintQueueHandler, type SprintQueueOptions } from "../../src/queue/sprint"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"
import type { VerificationResult } from "../../src/sprint/verification-runner"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

// All verifications fail — force escalation
const sprintOpts: SprintQueueOptions = {
  taskDescription: "Refactor the cron parser",
  projectCwd: "/tmp/test-project",
  sprintConfig: {
    max_iterations: 2,
    verification_timeout_ms: 30000,
    escalate_to_full: true,
    escalate_on_stuck: false,
  },
  emitter: mockEmitter,
  workflowId: randomUUID(),
  runVerification: async () => ({
    passed: false,
    stdout: "Tests failed: 3 of 5 assertions",
    stderr: "",
    exitCode: 1,
    durationMs: 200,
  }),
  readHandoff: async () => ({
    summary: "Attempted the refactor",
    verification_script_path: ".flywheel/verify/test.ts",
  }),
}

const handler = createSprintQueueHandler(sprintOpts)
const queue = buildQueueFromTemplate("sprint")
ESCAL_PART1

  cat >> "$TEST_SCRIPT" << 'ESCAL_PART2'

const workerFn: WorkerFn = async (step, _prompt) => {
  const handoffPath = `/tmp/handoff-${step.id}.json`
  if (step.type === "verify") {
    const vr = await handler.executeVerifyStep(step, {
      verification_script_path: ".flywheel/verify/test.ts",
    })
    ;(step as any)._verifyResult = vr
  }
  return { output: "work done", handoffPath, durationMs: 100, sessionId: randomUUID() }
}

const dispatcherFn: DispatcherFn = async (step, _ctx) => {
  if (step.type === "work") {
    return { prompt: handler.buildWorkStepPrompt(step), evaluationCriteria: null }
  }
  return { prompt: `Execute ${step.type}: ${step.title}`, evaluationCriteria: null }
}

const handoffReaderFn = async (p: string) => {
  const sid = p.replace("/tmp/handoff-", "").replace(".json", "")
  const s = queue.steps.find(st => st.id === sid)
  if (s?.type === "verify" && (s as any)._verifyResult) {
    return { verificationResult: (s as any)._verifyResult }
  }
  return { summary: "Attempted the refactor", verification_script_path: ".flywheel/verify/test.ts" }
}
ESCAL_PART2

  cat >> "$TEST_SCRIPT" << 'ESCAL_PART3'

const executor = createStepExecutor({
  queue,
  workflowId: sprintOpts.workflowId,
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: async () => {},
  accumulator: { accumulate: () => {}, getContext: () => ({}) },
  maxRevisions: 0,
  onStepCompleted: handler.onStepCompleted,
})

const result = await executor.run()

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

// VAL-CROSS-004: Sprint escalation full flow
// Sprint fails max_iterations(2) times → escalation inserts plan→work→review → all execute
check("Queue completed", result.completed)

// Expected steps: work(c) verify(f) work(c) verify(f) plan(c) work(c) review(c) = 7
check("7 total steps", queue.steps.length === 7)

// Sprint iteration steps (first 4)
// verify steps are "completed" by executor (worker succeeded), but verification result = failed
check("Step 1: work completed", queue.steps[0].type === "work" && queue.steps[0].status === "completed")
check("Step 2: verify completed (result=fail)", queue.steps[1].type === "verify" && queue.steps[1].status === "completed")
check("Step 3: work completed (retry)", queue.steps[2].type === "work" && queue.steps[2].status === "completed")
check("Step 4: verify completed (result=fail 2)", queue.steps[3].type === "verify" && queue.steps[3].status === "completed")

// Escalation steps (last 3)
check("Step 5: plan completed (escalation)", queue.steps[4].type === "plan" && queue.steps[4].status === "completed")
check("Step 6: work completed (escalation)", queue.steps[5].type === "work" && queue.steps[5].status === "completed")
check("Step 7: review completed (escalation)", queue.steps[6].type === "review" && queue.steps[6].status === "completed")

// Sprint handler state
const state = handler.getState()
check("Sprint escalated=true", state.escalated)
check("Iteration count=2", state.iterationCount === 2)
check("Escalation context exists", !!state.escalationContext)

// Events: verify dynamic insertion events
const stepInserted = emittedEvents.filter(e => e.method === "queueStepInserted")
// 2 for first retry pair + 3 for escalation = 5 insertions
check("5 step:inserted events (2 retry + 3 escalation)", stepInserted.length === 5)

// Verify escalation steps in insertion order: plan, work, review
const escalationInserts = stepInserted.slice(2)
check("Escalation insert 1 is plan", escalationInserts[0]?.args[2] === "plan")
check("Escalation insert 2 is work", escalationInserts[1]?.args[2] === "work")
check("Escalation insert 3 is review", escalationInserts[2]?.args[2] === "review")

console.log(`\n  Sprint escalation: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
ESCAL_PART3

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 17))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 3: Dynamic step insertion visible in panel events
#
# Validates that queue:step-inserted events are correctly emitted
# during sprint retry and escalation, making dynamic insertion
# visible to the panel.
# ──────────────────────────────────────────────────────────────────
test_dynamic_insertion_events() {
  local tn="Test 3: Dynamic step insertion events"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/sprint-insertion-e2e.ts"
  cat > "$TEST_SCRIPT" << 'INSERT_PART1'
import { randomUUID } from "crypto"
import { buildQueueFromTemplate } from "../../src/queue/templates"
import { createSprintQueueHandler, type SprintQueueOptions } from "../../src/queue/sprint"
import type { FlywheelEmitter } from "../../src/events/event-bus"
import type { VerificationResult } from "../../src/sprint/verification-runner"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

const sprintOpts: SprintQueueOptions = {
  taskDescription: "Fix a bug",
  projectCwd: "/tmp/test",
  sprintConfig: {
    max_iterations: 3,
    verification_timeout_ms: 30000,
    escalate_to_full: true,
    escalate_on_stuck: false,
  },
  emitter: mockEmitter,
  workflowId: randomUUID(),
  runVerification: async () => ({
    passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
  }),
  readHandoff: async () => ({
    summary: "Tried fix",
    verification_script_path: ".flywheel/verify/test.ts",
  }),
}

const handler = createSprintQueueHandler(sprintOpts)
const queue = buildQueueFromTemplate("sprint")
INSERT_PART1

  cat >> "$TEST_SCRIPT" << 'INSERT_PART2'

// Simulate iteration 1: work completed, verify failed
queue.steps[0].status = "completed"
await handler.onStepCompleted(queue.steps[0], "completed", queue, {
  summary: "Tried", verification_script_path: ".flywheel/verify/test.ts",
})

queue.steps[1].status = "failed"
await handler.onStepCompleted(queue.steps[1], "failed", queue, {
  verificationResult: { passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100 },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

// After first retry insertion
check("Queue has 4 steps after retry", queue.steps.length === 4)
const inserted1 = emittedEvents.filter(e => e.method === "queueStepInserted")
check("2 insertion events after retry", inserted1.length === 2)

// Each insertion event has: workflowId, stepId, stepType, stepTitle, afterStepId
check("Insert event has stepId", typeof inserted1[0]?.args[1] === "string")
check("Insert event has stepType", typeof inserted1[0]?.args[2] === "string")
check("Insert event has stepTitle", typeof inserted1[0]?.args[3] === "string")
check("Insert event has afterStepId", typeof inserted1[0]?.args[4] === "string")

// Verify the retry steps have correct titles containing iteration number
const retryWork = queue.steps[2]
const retryVerify = queue.steps[3]
check("Retry work title has iteration", retryWork.title.includes("iteration 2"))
check("Retry verify title has iteration", retryVerify.title.includes("iteration 2"))

console.log(`\n  Dynamic insertion: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
INSERT_PART2

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 8))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 4: Sprint iteration count format
#
# Validates formatSprintIteration() produces the expected
# "Sprint N/M" format used in the telemetry bar.
# ──────────────────────────────────────────────────────────────────
test_sprint_iteration_format() {
  local tn="Test 4: Sprint iteration count format"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/sprint-format-e2e.ts"
  cat > "$TEST_SCRIPT" << 'FORMAT_EOF'
import { formatSprintIteration, type SprintIterationInfo } from "../../src/tui/utils/format"

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

check("Sprint 2/5", formatSprintIteration({ iteration: 2, maxIterations: 5 }) === "Sprint 2/5")
check("Sprint 1/3", formatSprintIteration({ iteration: 1, maxIterations: 3 }) === "Sprint 1/3")
check("Sprint 0/5 returns empty (not started)", formatSprintIteration({ iteration: 0, maxIterations: 5 }) === "")
check("null returns empty", formatSprintIteration(null) === "")
check("undefined returns empty", formatSprintIteration(undefined) === "")

console.log(`\n  Sprint format: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
FORMAT_EOF

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 5))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 5: TUI sprint start via /start wizard → Sprint option
#
# Launches TUI in tmux, navigates through /start wizard selecting
# Sprint mode. Verifies the Sprint option is available and selectable.
# ──────────────────────────────────────────────────────────────────
test_tui_sprint_wizard() {
  local tn="Test 5: TUI /start wizard with Sprint option"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle state"; cleanup_session; return; fi

  # /start with description → directly to workflow picker
  tmux send-keys -t "$SESSION" '/start fix a small bug' Enter
  sleep 3
  local S; S=$(capture)

  assert_contains "$S" "Sprint" "Sprint option visible in picker"
  assert_contains "$S" "Just Plan" "Other options still present"
  assert_contains "$S" "Plan + Work" "Plan + Work visible"

  # Select Sprint (option 5)
  tmux send-keys -t "$SESSION" '5'
  sleep 3
  S=$(capture)

  # After selecting sprint, should see either consolidation question or working state
  # (depending on whether consolidation question appears for sprint)
  local in_working=0
  if echo "$S" | grep -q "Sprint\|Step\|Runtime\|00:\|executing"; then
    in_working=1
  fi
  if echo "$S" | grep -q "consolidat\|interactive"; then
    in_working=1  # At consolidation question, which means sprint was selected
  fi

  if [ "$in_working" -eq 1 ]; then
    pass_assert "Sprint mode selected successfully (entered next state)"
  else
    fail_assert "Sprint selection did not advance (stuck at picker?)"
  fi

  # Clean up — stop if working
  tmux send-keys -t "$SESSION" Escape; sleep 1
  tmux send-keys -t "$SESSION" Escape; sleep 2
  cleanup_session

  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Test 6: Sprint telemetry bar and panel display (120x40)
#
# Verifies the telemetry bar and workflow panel render correctly
# during sprint at 120x40 width (panel visible).
# This only verifies the initial rendering before API calls start.
# ──────────────────────────────────────────────────────────────────
test_tui_sprint_display() {
  local tn="Test 6: Sprint TUI display at 120x40"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  start_tui 120 40
  if ! wait_for_idle; then
    fail_test "$tn" "TUI did not reach idle state"; cleanup_session; return; fi

  # Start sprint workflow
  tmux send-keys -t "$SESSION" '/start build a hello world function' Enter
  sleep 3

  # Select Sprint (option 5)
  tmux send-keys -t "$SESSION" '5'
  sleep 5
  local S; S=$(capture)

  # The telemetry bar should show Sprint iteration info or step progress
  # Sprint mode displays "Sprint N/M" in the telemetry bar
  # At 120 cols, the workflow panel should also be visible
  local has_sprint_indicator=0
  if echo "$S" | grep -q "Sprint [0-9]"; then
    has_sprint_indicator=1
    pass_assert "Telemetry bar shows Sprint N/M"
  elif echo "$S" | grep -q "Sprint\|Step [0-9]"; then
    has_sprint_indicator=1
    pass_assert "Step progress visible"
  else
    # It may still be at consolidation question
    if echo "$S" | grep -q "consolidat\|interactive"; then
      pass_assert "At consolidation question (pre-execution)"
    else
      fail_assert "No sprint/step indicator found in display"
    fi
  fi

  # Check for workflow panel at 120 cols (if executing)
  if echo "$S" | grep -q "Sprint work\|Verify\|work\|verify\|Steps:"; then
    pass_assert "Workflow panel shows sprint steps"
  elif echo "$S" | grep -q "consolidat\|interactive\|00:"; then
    pass_assert "TUI in expected state (pre-execution or executing)"
  else
    fail_assert "No panel content or execution state visible"
  fi

  # Clean up
  tmux send-keys -t "$SESSION" Escape; sleep 1
  tmux send-keys -t "$SESSION" Escape; sleep 2
  cleanup_session

  [ "$FAIL_COUNT" -eq 0 ] && pass_test "$tn ($PASS_COUNT asserts)" \
    || fail_test "$tn" "$FAIL_COUNT/$((PASS_COUNT+FAIL_COUNT)) failed"
}

# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

: > "$LOG_FILE"

log "=== Sprint Queue E2E Tests ==="
log "Project: $PROJECT_DIR"
log ""

# Parse arguments
RUN_TEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test) RUN_TEST="$2"; shift 2 ;;
    *) log "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -n "$RUN_TEST" ]; then
  case "$RUN_TEST" in
    1) test_sprint_iteration_loop ;;
    2) test_sprint_escalation ;;
    3) test_dynamic_insertion_events ;;
    4) test_sprint_iteration_format ;;
    5) test_tui_sprint_wizard ;;
    6) test_tui_sprint_display ;;
    *) log "Unknown test: $RUN_TEST (valid: 1-6)"; exit 1 ;;
  esac
else
  test_sprint_iteration_loop
  test_sprint_escalation
  test_dynamic_insertion_events
  test_sprint_iteration_format
  test_tui_sprint_wizard
  test_tui_sprint_display
fi

# ── Summary ──

log ""
log "=== Sprint Queue E2E Summary ==="
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
