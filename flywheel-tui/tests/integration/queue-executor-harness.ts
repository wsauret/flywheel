// ---------------------------------------------------------------------------
// Queue Executor Integration Test Harness
// ---------------------------------------------------------------------------
//
// Wires a fully functional StepExecutor from:
//   - Real: queue (createQueue), persistence, event bus, accumulator, guardrails
//   - Mock: dispatcher, worker, evaluator, handoff reader, budget checker
//
// Each mock is configurable per-test via options. The harness creates temp
// directories for persistence and cleans up after each test.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueue, type Provenance } from "../../src/workflows/queue/queue";
import { createQueuePersistence } from "../../src/workflows/queue/persistence";
import { createContextAccumulator } from "../../src/workflows/queue/context-accumulator";
import { createGuardrails, type GuardrailOptions } from "../../src/workflows/queue/guardrails";
import { EventBus, createEmit, type EmitFn } from "../../src/infra/event-bus";
import { createStepExecutor } from "../../src/workflows/queue/executor";
import type {
  StepExecutorOptions,
  StepExecutor,
  WorkerOutput,
  EvalResult,
  DispatcherFn,
  WorkerFn,
  EvaluatorFn,
  HandoffReaderFn,
  PersistFn,
  StepContextAccumulator,
} from "../../src/workflows/queue/executor-types";
import type { OnStepCompletedHook } from "../../src/workflows/queue/shared/hooks";
import type { Step, Queue } from "../../src/workflows/queue/types";
import type { FlywheelEvent } from "../../src/infra/events";
import { ensureSessionDir } from "../../src/infra/paths";

// ---------------------------------------------------------------------------
// Step factory — builds Step objects with sensible defaults
// ---------------------------------------------------------------------------

let stepCounter = 0;

export function makeStep(overrides: Partial<Step> & { type?: Step["type"] } = {}): Step {
  stepCounter++;
  return {
    id: overrides.id ?? `step-${stepCounter}`,
    type: overrides.type ?? "work",
    title: overrides.title ?? `Step ${stepCounter}`,
    status: overrides.status ?? "pending",
    ...overrides,
  };
}

export function makeSteps(count: number, overrides?: Partial<Step>): Step[] {
  return Array.from({ length: count }, (_, i) =>
    makeStep({ title: `Step ${i + 1}`, ...overrides }),
  );
}

/** Reset the step counter between tests to get predictable IDs. */
export function resetStepCounter(): void {
  stepCounter = 0;
}

// ---------------------------------------------------------------------------
// Mock factories — configurable per-test
// ---------------------------------------------------------------------------

export interface MockDispatcherOptions {
  /** Override prompt for specific step IDs. */
  promptByStepId?: Record<string, string>;
  /** Return mutation requests for specific step IDs. */
  mutationsByStepId?: Record<string, StepExecutorOptions["guardrails"] extends null ? never : NonNullable<Awaited<ReturnType<DispatcherFn>>["mutationRequests"]>>;
  /** Step IDs where the dispatcher should throw an error. */
  failOnStepIds?: Set<string>;
  /** Track all calls for assertions. */
  calls?: Array<{ step: Step; context: Record<string, unknown> }>;
}

export function createMockDispatcher(opts: MockDispatcherOptions = {}): DispatcherFn {
  const calls = opts.calls ?? [];
  opts.calls = calls;

  return async (step, context) => {
    calls.push({ step, context });
    if (opts.failOnStepIds?.has(step.id)) {
      throw new Error(`Dispatcher transport unavailable for step: ${step.id}`);
    }
    return {
      prompt: opts.promptByStepId?.[step.id] ?? `Execute: ${step.title}`,
      evaluationCriteria: null,
      mutationRequests: opts.mutationsByStepId?.[step.id] ?? undefined,
    };
  };
}

export interface MockWorkerOptions {
  /** Step IDs that should throw an error. */
  failOnStepIds?: Set<string>;
  /** Handoff data to write per step ID. */
  handoffByStepId?: Record<string, Record<string, unknown>>;
  /** Default handoff data for all steps. */
  defaultHandoff?: Record<string, unknown>;
  /** Track all calls for assertions. */
  calls?: Array<{ step: Step; prompt: string }>;
  /** Delay per step (ms) — useful for abort/shutdown tests. */
  delayMs?: number;
  /** Per-step delay (ms) — by step ID. */
  delayByStepId?: Record<string, number>;
}

export function createMockWorker(
  tmpDir: string,
  opts: MockWorkerOptions = {},
): WorkerFn {
  const calls = opts.calls ?? [];
  opts.calls = calls;

  return async (step, prompt) => {
    calls.push({ step, prompt });

    // Configurable delay
    const delay = opts.delayByStepId?.[step.id] ?? opts.delayMs ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Configurable failure
    if (opts.failOnStepIds?.has(step.id)) {
      throw new Error(`Worker crashed on step: ${step.id}`);
    }

    // Write handoff file
    const handoffData = opts.handoffByStepId?.[step.id]
      ?? opts.defaultHandoff
      ?? { output: `Result from ${step.title}` };
    const handoffPath = join(tmpDir, `handoff-${step.id}.json`);
    await Bun.write(handoffPath, JSON.stringify(handoffData));

    return {
      output: `Worker output for ${step.title}`,
      handoffPath,
      durationMs: delay || 10,
    };
  };
}

export interface MockEvaluatorOptions {
  /** Step IDs where evaluation should fail (returns passed=false). */
  failOnStepIds?: Set<string>;
  /** Number of times to fail before passing (per step ID). */
  failCountByStepId?: Record<string, number>;
  /** Step IDs where evaluator returns a transport error. */
  transportErrorOnStepIds?: Set<string>;
  /** Track all calls for assertions. */
  calls?: Array<{ step: Step; output: string; evaluationCriteria: unknown; handoffData: Record<string, unknown> | null }>;
}

export function createMockEvaluator(opts: MockEvaluatorOptions = {}): EvaluatorFn {
  const calls = opts.calls ?? [];
  opts.calls = calls;
  const failCounts = new Map<string, number>();

  return async (step, workerOutput, evaluationCriteria, handoffData) => {
    calls.push({ step, output: workerOutput, evaluationCriteria: evaluationCriteria ?? null, handoffData: handoffData ?? null });

    // Transport error
    if (opts.transportErrorOnStepIds?.has(step.id)) {
      return {
        passed: false,
        skipped: false,
        transportError: true,
        reason: "Transport error: connection refused",
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      };
    }

    // Configurable failure with count
    if (opts.failCountByStepId?.[step.id] !== undefined) {
      const current = failCounts.get(step.id) ?? 0;
      failCounts.set(step.id, current + 1);
      if (current < opts.failCountByStepId[step.id]) {
        return {
          passed: false,
          skipped: false,
          transportError: false,
          reason: `Evaluation failed (attempt ${current + 1})`,
          feedback: `Fix issues in attempt ${current + 1}`,
          suggestions: [`Suggestion for attempt ${current + 1}`],
          cyclesUsed: 1,
        };
      }
    }

    // Always-fail
    if (opts.failOnStepIds?.has(step.id)) {
      return {
        passed: false,
        skipped: false,
        transportError: false,
        reason: "Evaluation failed: quality check not met",
        feedback: "Improve the output",
        suggestions: ["Try harder"],
        cyclesUsed: 1,
      };
    }

    return {
      passed: true,
      skipped: false,
      transportError: false,
      reason: null,
      feedback: null,
      suggestions: [],
      cyclesUsed: 1,
    };
  };
}

export function createMockHandoffReader(tmpDir: string): HandoffReaderFn {
  return async (path) => {
    try {
      const file = Bun.file(path);
      const exists = await file.exists();
      if (!exists) return null;
      const text = await file.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Event collector — captures all events for assertions
// ---------------------------------------------------------------------------

export interface EventCollector {
  events: FlywheelEvent[];
  ofType<T extends FlywheelEvent["type"]>(type: T): Array<Extract<FlywheelEvent, { type: T }>>;
  clear(): void;
}

export function createEventCollector(bus: EventBus): EventCollector {
  const events: FlywheelEvent[] = [];
  bus.subscribe((event) => events.push(event));

  return {
    events,
    ofType<T extends FlywheelEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<FlywheelEvent, { type: T }> => e.type === type);
    },
    clear() {
      events.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness — wires everything together
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Number of steps to create. Default: 3. */
  stepCount?: number;
  /** Pre-built steps (overrides stepCount). */
  steps?: Step[];
  /** Pre-built queue (overrides steps/stepCount). */
  queue?: Queue;
  /** Mock dispatcher options. */
  dispatcher?: MockDispatcherOptions;
  /** Mock worker options. */
  worker?: MockWorkerOptions;
  /** Mock evaluator options. Null = no evaluator. */
  evaluator?: MockEvaluatorOptions | null;
  /** Raw evaluator function override (bypasses mock evaluator). */
  evaluatorFn?: EvaluatorFn;
  /** onStepCompleted hook. */
  onStepCompleted?: OnStepCompletedHook | null;
  /** Max revisions per step. Default: 0 (no revisions). */
  maxRevisions?: number;
  /** Guardrail options. Null = no guardrails. */
  guardrails?: GuardrailOptions | null;
  /** Session objective for dispatcher context. Default: "Test session objective". */
  sessionObjective?: string;
  /** Custom handoff reader (overrides default). */
  handoffReader?: HandoffReaderFn;
  /** Custom persist function (overrides default). */
  persistFn?: PersistFn;
  /** Custom persistAccumulatorState function (overrides default). */
  persistAccumulatorStateFn?: ((state: unknown) => void) | null;
}

export interface Harness {
  /** The step executor. */
  executor: StepExecutor;
  /** The queue being executed. */
  queue: Queue;
  /** Event bus for subscriptions. */
  bus: EventBus;
  /** Typed event emitter. */
  emit: EmitFn;
  /** Captured events. */
  events: EventCollector;
  /** Context accumulator. */
  accumulator: ReturnType<typeof createContextAccumulator>;
  /** Persistence (for loading persisted state). */
  persistence: ReturnType<typeof createQueuePersistence>;
  /** Temp directory (for assertions on handoff files). */
  tmpDir: string;
  /** Session ID. */
  sessionId: string;
  /** Mock dispatcher (with tracked calls). */
  dispatcherOpts: MockDispatcherOptions;
  /** Mock worker (with tracked calls). */
  workerOpts: MockWorkerOptions;
  /** Mock evaluator (with tracked calls). Null if no evaluator. */
  evaluatorOpts: MockEvaluatorOptions | null;
  /** Snapshots of queue state captured on every persist call. */
  persistCalls: Queue[];
  /** Cleanup function — call in afterEach. */
  cleanup(): void;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  // Temp directory for persistence + handoffs
  const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-test-"));
  const sessionId = `test-${Date.now()}`;

  // Ensure session directory exists for persistence
  ensureSessionDir(sessionId, tmpDir);

  // Real components
  const steps = opts.queue?.steps ?? opts.steps ?? makeSteps(opts.stepCount ?? 3);
  const queue = opts.queue ?? createQueue(steps);
  const bus = new EventBus();
  const emit = createEmit(bus);
  const events = createEventCollector(bus);
  const accumulator = createContextAccumulator();
  const persistence = createQueuePersistence({
    sessionId,
    baseDir: tmpDir,
    persistQueue: true,
  });
  const guardrails = opts.guardrails !== null
    ? createGuardrails(opts.guardrails ?? {})
    : null;

  // Mock components
  const dispatcherOpts: MockDispatcherOptions = opts.dispatcher ?? {};
  dispatcherOpts.calls = dispatcherOpts.calls ?? [];
  const dispatcher = createMockDispatcher(dispatcherOpts);

  const workerOpts: MockWorkerOptions = opts.worker ?? {};
  workerOpts.calls = workerOpts.calls ?? [];
  const worker = createMockWorker(tmpDir, workerOpts);

  const evaluatorOpts = opts.evaluator ?? null;
  if (evaluatorOpts) {
    evaluatorOpts.calls = evaluatorOpts.calls ?? [];
  }
  const evaluator = opts.evaluatorFn ?? (evaluatorOpts ? createMockEvaluator(evaluatorOpts) : null);

  // Persist function — track every call with a deep-cloned snapshot
  const persistCalls: Queue[] = [];
  const persist: PersistFn = opts.persistFn ?? (async (q: Queue) => {
    persistCalls.push(JSON.parse(JSON.stringify(q)));
    await persistence.save(q);
  });

  // Accumulator state persistence
  const persistAccumulatorState = opts.persistAccumulatorStateFn !== undefined
    ? opts.persistAccumulatorStateFn
    : ((state: unknown) => {
        persistence.saveAccumulatorState(state as import("../../src/workflows/queue/context-accumulator").AccumulatorState);
      });

  // Create executor
  const executor = createStepExecutor({
    queue,
    workflowId: `test-workflow-${Date.now()}`,
    sessionId,
    emit,
    dispatcher,
    worker,
    evaluator,
    handoffReader: opts.handoffReader ?? createMockHandoffReader(tmpDir),
    persist,
    accumulator,
    maxRevisions: opts.maxRevisions ?? 0,
    onStepCompleted: opts.onStepCompleted ?? null,
    guardrails,
    sessionObjective: opts.sessionObjective ?? "Test session objective",
    persistAccumulatorState,
  });

  function cleanup() {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  return {
    executor,
    queue,
    bus,
    emit,
    events,
    accumulator,
    persistence,
    tmpDir,
    sessionId,
    dispatcherOpts,
    workerOpts,
    evaluatorOpts,
    persistCalls,
    cleanup,
  };
}
