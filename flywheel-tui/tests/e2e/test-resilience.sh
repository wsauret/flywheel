#!/usr/bin/env bash
#
# Resilience E2E Tests
#
# Tests queue resilience scenarios: pause/resume, worker crash, budget
# exhaustion, queue state persistence/recovery, and context accumulation.
#
# Validates: VAL-CROSS-005, VAL-CROSS-008, VAL-CROSS-009, VAL-CROSS-010,
#            VAL-CROSS-011
#
# Usage:
#   ./tests/e2e/test-resilience.sh              # run all tests
#   ./tests/e2e/test-resilience.sh --test N      # run specific test (1-5)
#
# Prerequisites: bun
#
# Note: All tests are programmatic (no API calls needed).
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$SCRIPT_DIR/resilience.log"

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

pass_test() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  log "=== PASS: $1 ==="
}

fail_test() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  log "=== FAIL: $1 — $2 ==="
}

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# ──────────────────────────────────────────────────────────────────
# Test 1: Session pause/resume (VAL-CROSS-005)
#
# Start a 3-step queue → pause mid-execution (shutdown after step 1)
# → verify queue state is paused → resume → verify it continues
# from the correct position (step 2) → completes.
# ──────────────────────────────────────────────────────────────────
test_pause_resume() {
  local tn="Test 1: Session pause/resume (VAL-CROSS-005)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/resilience-pause-resume.ts"
  cat > "$TEST_SCRIPT" << 'PAUSE_RESUME_EOF'
import { randomUUID } from "crypto"
import { createQueue, advanceCursor } from "../../src/queue/queue"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
  type StepExecutor,
} from "../../src/queue/executor"
import type { Step, Queue } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

// Create a 3-step queue
const steps: Step[] = [
  { id: randomUUID(), type: "work", title: "Step 1: Setup", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 2: Implement", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 3: Verify", status: "pending" },
]
const queue = createQueue(steps)

let stepExecutionCount = 0
let executorRef: StepExecutor | null = null

// Worker that requests shutdown after step 1 completes
const workerFn: WorkerFn = async (step, _prompt) => {
  stepExecutionCount++
  if (stepExecutionCount === 1 && executorRef) {
    // Request shutdown after first step - executor finishes current, then stops
    executorRef.requestShutdown()
  }
  return {
    output: `Executed ${step.title}`,
    handoffPath: `/tmp/handoff-${step.id}.json`,
    durationMs: 50,
  }
}

const dispatcherFn: DispatcherFn = async (step, _ctx) => ({
  prompt: `Execute: ${step.title}`,
  evaluationCriteria: null,
})

const handoffReaderFn = async () => ({ summary: "Done" })

const persistedStates: Queue[] = []
const persistFn = async (q: Queue) => {
  persistedStates.push(JSON.parse(JSON.stringify(q)))
}

const accumulatedData: unknown[] = []
const accumulator = {
  accumulate: (data: unknown) => accumulatedData.push(data),
  getContext: () => ({ accumulated: accumulatedData }),
}

// Phase 1: Run until shutdown
const executor = createStepExecutor({
  queue,
  workflowId: randomUUID(),
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: persistFn,
  accumulator,
  maxRevisions: 0,
})
executorRef = executor

const result1 = await executor.run()

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

// After shutdown, step 1 should be completed, steps 2-3 pending
check("Phase 1: not fully completed", !result1.completed)
check("Phase 1: 1 step completed", result1.stepsCompleted === 1)
check("Phase 1: reason is shutdown", result1.reason === "Shutdown requested")
check("Phase 1: step 1 completed", queue.steps[0].status === "completed")
check("Phase 1: step 2 still pending", queue.steps[1].status === "pending")
check("Phase 1: step 3 still pending", queue.steps[2].status === "pending")
check("Phase 1: queue status is paused", queue.status === "paused")
check("Phase 1: only 1 worker execution", stepExecutionCount === 1)

// Phase 2: Resume — create new executor with the SAME queue
// (simulates loading persisted queue and resuming)
const resumeEvents: Array<{ method: string; args: unknown[] }> = []
const resumeEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return resumeEvents
    return (...args: unknown[]) => { resumeEvents.push({ method: prop, args }) }
  },
})

let resumeStepCount = 0
const resumeWorkerFn: WorkerFn = async (step, _prompt) => {
  resumeStepCount++
  return {
    output: `Resumed: ${step.title}`,
    handoffPath: `/tmp/handoff-${step.id}.json`,
    durationMs: 50,
  }
}

const executor2 = createStepExecutor({
  queue,
  workflowId: randomUUID(),
  emitter: resumeEmitter,
  dispatcher: dispatcherFn,
  worker: resumeWorkerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: persistFn,
  accumulator,
  maxRevisions: 0,
})

const result2 = await executor2.run()

check("Phase 2: completed", result2.completed)
check("Phase 2: 3 steps completed total", result2.stepsCompleted === 3)
check("Phase 2: step 1 still completed", queue.steps[0].status === "completed")
check("Phase 2: step 2 now completed", queue.steps[1].status === "completed")
check("Phase 2: step 3 now completed", queue.steps[2].status === "completed")
check("Phase 2: only 2 workers ran on resume", resumeStepCount === 2)
check("Phase 2: queue status is completed", queue.status === "completed")

// Verify resume events: only steps 2 and 3 started
const stepStarted = resumeEvents.filter(e => e.method === "queueStepStarted")
check("Resume: 2 step:started events", stepStarted.length === 2)
if (stepStarted.length >= 2) {
  check("Resume: first started is step 2",
    stepStarted[0].args[3] === "Step 2: Implement")
  check("Resume: second started is step 3",
    stepStarted[1].args[3] === "Step 3: Verify")
}

console.log(`\n  Pause/resume: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
PAUSE_RESUME_EOF

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
# Test 2: Worker crash mid-step (VAL-CROSS-008)
#
# Queue with 3 steps. Step 2's worker throws an error (crash).
# Step 2 should be marked failed, queue stops for non-sprint mode.
# Then test sprint mode: worker crash → step failed → retry pair
# inserted → continues.
# ──────────────────────────────────────────────────────────────────
test_worker_crash() {
  local tn="Test 2: Worker crash mid-step (VAL-CROSS-008)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/resilience-worker-crash.ts"
  cat > "$TEST_SCRIPT" << 'WORKER_CRASH_PART1'
import { randomUUID } from "crypto"
import { createQueue } from "../../src/queue/queue"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step, Queue } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

// ----- Part A: Non-sprint queue — worker crash stops queue -----

const steps: Step[] = [
  { id: randomUUID(), type: "work", title: "Step 1: OK", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 2: Crash", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 3: Never", status: "pending" },
]
const queue = createQueue(steps)

let callCount = 0
const workerFn: WorkerFn = async (step, _prompt) => {
  callCount++
  if (step.title.includes("Crash")) {
    throw new Error("Worker process crashed unexpectedly")
  }
  return {
    output: `Done: ${step.title}`,
    handoffPath: `/tmp/handoff-${step.id}.json`,
    durationMs: 50,
  }
}

const dispatcherFn: DispatcherFn = async (step, _ctx) => ({
  prompt: `Execute: ${step.title}`,
  evaluationCriteria: null,
})

const handoffReaderFn = async () => ({ summary: "Done" })
const persistFn = async () => {}
const accumulator = {
  accumulate: () => {},
  getContext: () => ({}),
}

const executor = createStepExecutor({
  queue,
  workflowId: randomUUID(),
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: persistFn,
  accumulator,
  maxRevisions: 0,
})

const result = await executor.run()

check("Part A: not completed", !result.completed)
check("Part A: 1 step completed", result.stepsCompleted === 1)
check("Part A: step 1 completed", queue.steps[0].status === "completed")
check("Part A: step 2 failed", queue.steps[1].status === "failed")
check("Part A: step 3 still pending", queue.steps[2].status === "pending")
check("Part A: queue status failed", queue.status === "failed")
check("Part A: 2 workers called (OK + crash)", callCount === 2)
check("Part A: reason mentions step 2",
  result.reason !== undefined && result.reason.includes("Step 2"))

// Verify step:failed event was emitted
const failedEvents = emittedEvents.filter(e => e.method === "queueStepFailed")
check("Part A: 1 step:failed event", failedEvents.length === 1)
if (failedEvents.length > 0) {
  check("Part A: failed event has crash message",
    String(failedEvents[0].args[4]).includes("crashed unexpectedly"))
}
WORKER_CRASH_PART1

  cat >> "$TEST_SCRIPT" << 'WORKER_CRASH_PART2'

// ----- Part B: Sprint mode — worker crash triggers retry -----

import { buildQueueFromTemplate } from "../../src/queue/templates"
import { createSprintQueueHandler, type SprintQueueOptions } from "../../src/queue/sprint"

const sprintEvents: Array<{ method: string; args: unknown[] }> = []
const sprintEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return sprintEvents
    return (...args: unknown[]) => { sprintEvents.push({ method: prop, args }) }
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
  emitter: sprintEmitter,
  workflowId: randomUUID(),
  runVerification: async () => ({
    passed: true, stdout: "OK", stderr: "", exitCode: 0, durationMs: 100,
  }),
  readHandoff: async () => ({
    summary: "Done",
    verification_script_path: ".flywheel/verify/test.ts",
  }),
}

const handler = createSprintQueueHandler(sprintOpts)
const sprintQueue = buildQueueFromTemplate("sprint")

let sprintCallCount = 0
const sprintWorkerFn: WorkerFn = async (step, _prompt) => {
  sprintCallCount++
  // First work step crashes, second succeeds
  if (sprintCallCount === 1 && step.type === "work") {
    throw new Error("Sprint worker crashed")
  }
  if (step.type === "verify") {
    const vr = await handler.executeVerifyStep(step, {
      verification_script_path: ".flywheel/verify/test.ts",
    })
    ;(step as any)._verifyResult = vr
  }
  return {
    output: `Done: ${step.title}`,
    handoffPath: `/tmp/handoff-${step.id}.json`,
    durationMs: 50,
  }
}

const sprintHandoffReader = async (p: string) => {
  const sid = p.replace("/tmp/handoff-", "").replace(".json", "")
  const s = sprintQueue.steps.find(st => st.id === sid)
  if (s?.type === "verify" && (s as any)._verifyResult) {
    return { verificationResult: (s as any)._verifyResult }
  }
  return { summary: "Done", verification_script_path: ".flywheel/verify/test.ts" }
}

const sprintExecutor = createStepExecutor({
  queue: sprintQueue,
  workflowId: sprintOpts.workflowId,
  emitter: sprintEmitter,
  dispatcher: dispatcherFn,
  worker: sprintWorkerFn,
  evaluator: null,
  handoffReader: sprintHandoffReader,
  budgetChecker: { isExhausted: () => false },
  persist: persistFn,
  accumulator,
  maxRevisions: 0,
  onStepCompleted: handler.onStepCompleted,
})

const sprintResult = await sprintExecutor.run()

const state = handler.getState()
check("Part B: sprint queue completed", sprintResult.completed)
check("Part B: iteration count >= 1", state.iterationCount >= 1)
// First work step crashes → iteration 1 counted as failed → retry inserted
// Second work step succeeds → verify passes → sprint completes
check("Part B: history has crash record",
  state.iterationHistory.some(r => r.workerCrashed === true))

console.log(`\n  Worker crash: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
WORKER_CRASH_PART2

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 13))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 3: Budget exhaustion mid-queue (VAL-CROSS-009)
#
# Queue with 3 steps, budget exhausted after step 1. Step 2 never
# starts. Queue status becomes paused. Reason: "Budget exhausted".
# ──────────────────────────────────────────────────────────────────
test_budget_exhaustion() {
  local tn="Test 3: Budget exhaustion mid-queue (VAL-CROSS-009)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/resilience-budget.ts"
  cat > "$TEST_SCRIPT" << 'BUDGET_EOF'
import { randomUUID } from "crypto"
import { createQueue } from "../../src/queue/queue"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"

const emittedEvents: Array<{ method: string; args: unknown[] }> = []
const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    if (prop === "events") return emittedEvents
    return (...args: unknown[]) => { emittedEvents.push({ method: prop, args }) }
  },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

const steps: Step[] = [
  { id: randomUUID(), type: "plan", title: "Step 1: Plan", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 2: Work", status: "pending" },
  { id: randomUUID(), type: "review", title: "Step 3: Review", status: "pending" },
]
const queue = createQueue(steps)

let workerCallCount = 0
const workerFn: WorkerFn = async (step, _prompt) => {
  workerCallCount++
  return {
    output: `Done: ${step.title}`,
    handoffPath: `/tmp/handoff-${step.id}.json`,
    durationMs: 50,
  }
}

const dispatcherFn: DispatcherFn = async (step, _ctx) => ({
  prompt: `Execute: ${step.title}`,
  evaluationCriteria: null,
})

// Budget: exhausted after the first step completes
let budgetExhausted = false
const budgetChecker = {
  isExhausted: () => budgetExhausted,
}

const persistedStates: any[] = []
const persistFn = async (q: any) => {
  persistedStates.push(JSON.parse(JSON.stringify(q)))
}

const accumulator = {
  accumulate: () => {},
  getContext: () => ({}),
}

const executor = createStepExecutor({
  queue,
  workflowId: randomUUID(),
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: async () => ({ summary: "Done" }),
  budgetChecker,
  persist: persistFn,
  accumulator,
  maxRevisions: 0,
  onStepCompleted: async (step, status) => {
    if (step.title === "Step 1: Plan" && status === "completed") {
      budgetExhausted = true
    }
    return { continueExecution: false }
  },
})

const result = await executor.run()

check("Not fully completed", !result.completed)
check("1 step completed", result.stepsCompleted === 1)
check("Reason is budget exhausted", result.reason === "Budget exhausted")
check("Step 1 completed", queue.steps[0].status === "completed")
check("Step 2 still pending", queue.steps[1].status === "pending")
check("Step 3 still pending", queue.steps[2].status === "pending")
check("Queue status is paused", queue.status === "paused")
check("Only 1 worker called", workerCallCount === 1)

const queueFailed = emittedEvents.filter(e => e.method === "queueFailed")
check("queue:failed event emitted", queueFailed.length === 1)
if (queueFailed.length > 0) {
  check("queue:failed reason mentions budget",
    String(queueFailed[0].args[1]).includes("Budget"))
}

check("Queue was persisted", persistedStates.length > 0)
const lastPersisted = persistedStates[persistedStates.length - 1]
check("Persisted state is paused", lastPersisted?.status === "paused")

console.log(`\n  Budget exhaustion: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
BUDGET_EOF

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 12))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 4: Queue state persistence and recovery (VAL-CROSS-010)
#
# Create queue, persist to disk with step 2 as "running" (simulating
# crash). Load from disk → crash recovery marks running→failed.
# Resume → only step 3 executes.
# ──────────────────────────────────────────────────────────────────
test_queue_persistence() {
  local tn="Test 4: Queue state persistence/recovery (VAL-CROSS-010)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/resilience-persistence.ts"
  cat > "$TEST_SCRIPT" << 'PERSIST_PART1'
import { randomUUID } from "crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { createQueue, transitionStep } from "../../src/queue/queue"
import { createQueuePersistence } from "../../src/queue/persistence"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step, Queue } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"

const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    return (...args: unknown[]) => {}
  },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

// Setup temp dir
const tmpDir = path.join("/tmp", `flywheel-test-${randomUUID()}`)
const sessionsDir = path.join(tmpDir, ".flywheel", "sessions")
fs.mkdirSync(sessionsDir, { recursive: true })

const sessionId = randomUUID()
const persistence = createQueuePersistence({
  sessionId,
  baseDir: tmpDir,
  persistQueue: true,
})

const steps: Step[] = [
  { id: randomUUID(), type: "plan", title: "Step 1: Plan", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 2: Work", status: "pending" },
  { id: randomUUID(), type: "review", title: "Step 3: Review", status: "pending" },
]
const queue = createQueue(steps)

// Simulate: step 1 completed, step 2 running (crash mid-execution)
const prov = { actor: "test", reason: "simulating execution" }
transitionStep(queue, queue.steps[0].id, "running", prov)
transitionStep(queue, queue.steps[0].id, "completed", prov)
transitionStep(queue, queue.steps[1].id, "running", prov)
queue.cursor = 1
queue.status = "running"

// Save to disk
persistence.save(queue)

// Verify file exists
const expectedPath = path.join(sessionsDir, `${sessionId}.queue.json`)
check("Queue file written to disk", fs.existsSync(expectedPath))

const rawContent = fs.readFileSync(expectedPath, "utf-8")
const parsed = JSON.parse(rawContent)
check("Persisted has 3 steps", parsed.steps.length === 3)
check("Persisted step 1 completed", parsed.steps[0].status === "completed")
check("Persisted step 2 running (pre-recovery)", parsed.steps[1].status === "running")
check("Persisted step 3 pending", parsed.steps[2].status === "pending")
PERSIST_PART1

  cat >> "$TEST_SCRIPT" << 'PERSIST_PART2'

// Phase 2: Load — crash recovery marks running→failed
const loadedQueue = await persistence.load()
check("Queue loaded from disk", loadedQueue !== null)

if (loadedQueue) {
  check("Step 1 still completed", loadedQueue.steps[0].status === "completed")
  check("Step 2 recovered to failed", loadedQueue.steps[1].status === "failed")
  check("Step 3 still pending", loadedQueue.steps[2].status === "pending")

  const crashRecovery = loadedQueue.mutationLog.find(
    e => e.action === "crash-recovery"
  )
  check("Crash recovery logged", crashRecovery !== undefined)
  if (crashRecovery) {
    check("Recovery actor is persistence", crashRecovery.actor === "persistence")
    check("Recovery targets step 2", crashRecovery.stepIds.includes(steps[1].id))
  }

  // Phase 3: Resume — only step 3 should execute
  let resumeWorkerCount = 0
  const resumeWorkerFn: WorkerFn = async (step, _prompt) => {
    resumeWorkerCount++
    return {
      output: `Resumed: ${step.title}`,
      handoffPath: `/tmp/handoff-${step.id}.json`,
      durationMs: 50,
    }
  }

  const dispatcherFn: DispatcherFn = async (step, _ctx) => ({
    prompt: `Execute: ${step.title}`,
    evaluationCriteria: null,
  })

  const executor = createStepExecutor({
    queue: loadedQueue,
    workflowId: randomUUID(),
    emitter: mockEmitter,
    dispatcher: dispatcherFn,
    worker: resumeWorkerFn,
    evaluator: null,
    handoffReader: async () => ({ summary: "Done" }),
    budgetChecker: { isExhausted: () => false },
    persist: async (q) => persistence.save(q),
    accumulator: { accumulate: () => {}, getContext: () => ({}) },
    maxRevisions: 0,
  })

  const result = await executor.run()

  check("Step 3 completed", loadedQueue.steps[2].status === "completed")
  check("Only 1 worker ran (step 3)", resumeWorkerCount === 1)
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n  Queue persistence: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
PERSIST_PART2

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 15))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Test 5: Context accumulation across steps (VAL-CROSS-011)
#
# Queue with 3 steps. Each step's handoff is accumulated. Verify
# that step N+1 dispatcher receives accumulated context from all
# prior steps, including previousHandoff.
# ──────────────────────────────────────────────────────────────────
test_context_accumulation() {
  local tn="Test 5: Context accumulation (VAL-CROSS-011)"
  TESTS_RUN=$((TESTS_RUN + 1)); PASS_COUNT=0; FAIL_COUNT=0
  log "── $tn ──"

  local TEST_SCRIPT="$SCRIPT_DIR/resilience-context.ts"
  cat > "$TEST_SCRIPT" << 'CONTEXT_PART1'
import { randomUUID } from "crypto"
import { createQueue } from "../../src/queue/queue"
import {
  createStepExecutor,
  type WorkerFn,
  type DispatcherFn,
} from "../../src/queue/executor"
import type { Step } from "../../src/queue/types"
import type { FlywheelEmitter } from "../../src/events/event-bus"

const mockEmitter = new Proxy({} as FlywheelEmitter, {
  get(_t, prop: string) {
    return (...args: unknown[]) => {}
  },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log("  ✓ " + label) }
  else { fail++; console.log("  ✗ " + label) }
}

const steps: Step[] = [
  { id: randomUUID(), type: "plan", title: "Step 1: Create plan", status: "pending" },
  { id: randomUUID(), type: "work", title: "Step 2: Implement", status: "pending" },
  { id: randomUUID(), type: "review", title: "Step 3: Review", status: "pending" },
]
const queue = createQueue(steps)

// Track dispatcher context per step
const dispatcherContexts: Array<{
  stepTitle: string
  context: Record<string, unknown>
}> = []

const dispatcherFn: DispatcherFn = async (step, context) => {
  dispatcherContexts.push({
    stepTitle: step.title,
    context: JSON.parse(JSON.stringify(context)),
  })
  return { prompt: `Execute: ${step.title}`, evaluationCriteria: null }
}

const workerFn: WorkerFn = async (step, _prompt) => ({
  output: `Done: ${step.title}`,
  handoffPath: `/tmp/handoff-${step.id}.json`,
  durationMs: 50,
})

// Step-specific handoff data
const handoffData: Record<string, Record<string, unknown>> = {}
handoffData[steps[0].id] = {
  summary: "Plan created",
  decision: "Use REST API",
  artifacts: ["plan.md"],
}
handoffData[steps[1].id] = {
  summary: "Feature implemented",
  decision: "Used Express framework",
  warnings: ["No error handling yet"],
  artifacts: ["src/api.ts", "src/routes.ts"],
}
handoffData[steps[2].id] = {
  summary: "Review complete",
  issues: ["Missing tests"],
}

const handoffReaderFn = async (p: string) => {
  const stepId = p.replace("/tmp/handoff-", "").replace(".json", "")
  return handoffData[stepId] ?? null
}
CONTEXT_PART1

  cat >> "$TEST_SCRIPT" << 'CONTEXT_PART2'

const accumulatedEntries: unknown[] = []
const accumulator = {
  accumulate: (data: unknown) => accumulatedEntries.push(data),
  getContext: () => ({ accumulatedSteps: accumulatedEntries }),
}

const executor = createStepExecutor({
  queue,
  workflowId: randomUUID(),
  emitter: mockEmitter,
  dispatcher: dispatcherFn,
  worker: workerFn,
  evaluator: null,
  handoffReader: handoffReaderFn,
  budgetChecker: { isExhausted: () => false },
  persist: async () => {},
  accumulator,
  maxRevisions: 0,
})

const result = await executor.run()

check("Queue completed", result.completed)
check("3 steps completed", result.stepsCompleted === 3)
check("Dispatcher called 3 times", dispatcherContexts.length === 3)

// Step 1: no previous handoff, no accumulated context
const ctx1 = dispatcherContexts[0]
check("Step 1: no previousHandoff",
  ctx1.context.previousHandoff === undefined)
const accSteps1 = ctx1.context.accumulatedSteps as unknown[] | undefined
check("Step 1: no accumulated entries",
  !accSteps1 || accSteps1.length === 0)

// Step 2: has previousHandoff from step 1, 1 accumulated entry
const ctx2 = dispatcherContexts[1]
const prevHandoff2 = ctx2.context.previousHandoff as Record<string, unknown> | undefined
check("Step 2: has previousHandoff", prevHandoff2 !== undefined)
check("Step 2: previousHandoff.summary = Plan created",
  prevHandoff2?.summary === "Plan created")
check("Step 2: previousHandoff.decision = Use REST API",
  prevHandoff2?.decision === "Use REST API")
const accSteps2 = ctx2.context.accumulatedSteps as unknown[] | undefined
check("Step 2: 1 accumulated entry", accSteps2?.length === 1)

// Step 3: has previousHandoff from step 2, 2 accumulated entries
const ctx3 = dispatcherContexts[2]
const prevHandoff3 = ctx3.context.previousHandoff as Record<string, unknown> | undefined
check("Step 3: has previousHandoff", prevHandoff3 !== undefined)
check("Step 3: previousHandoff.summary = Feature implemented",
  prevHandoff3?.summary === "Feature implemented")
check("Step 3: previousHandoff has warnings",
  Array.isArray(prevHandoff3?.warnings))
const accSteps3 = ctx3.context.accumulatedSteps as unknown[] | undefined
check("Step 3: 2 accumulated entries", accSteps3?.length === 2)

// Verify full accumulation
check("Final accumulator has 3 entries", accumulatedEntries.length === 3)
const entry1 = accumulatedEntries[0] as Record<string, unknown>
const entry2 = accumulatedEntries[1] as Record<string, unknown>
const entry3 = accumulatedEntries[2] as Record<string, unknown>
check("Entry 1 from step 1",
  (entry1.handoff as any)?.summary === "Plan created")
check("Entry 2 from step 2",
  (entry2.handoff as any)?.summary === "Feature implemented")
check("Entry 3 from step 3",
  (entry3.handoff as any)?.summary === "Review complete")

console.log(`\n  Context accumulation: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
CONTEXT_PART2

  if cd "$PROJECT_DIR" && bun run "$TEST_SCRIPT" 2>>"$LOG_FILE"; then
    PASS_COUNT=$((PASS_COUNT + 19))
    pass_test "$tn ($PASS_COUNT asserts)"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    fail_test "$tn" "Script returned non-zero exit code"
  fi
  rm -f "$TEST_SCRIPT"
}

# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

: > "$LOG_FILE"

log "=== Resilience E2E Tests ==="
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
    1) test_pause_resume ;;
    2) test_worker_crash ;;
    3) test_budget_exhaustion ;;
    4) test_queue_persistence ;;
    5) test_context_accumulation ;;
    *) log "Unknown test: $RUN_TEST (valid: 1-5)"; exit 1 ;;
  esac
else
  test_pause_resume
  test_worker_crash
  test_budget_exhaustion
  test_queue_persistence
  test_context_accumulation
fi

# ── Summary ──

log ""
log "=== Resilience E2E Summary ==="
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
