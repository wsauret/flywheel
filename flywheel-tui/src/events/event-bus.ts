import type { FlywheelEvent } from "./types";
import { Log } from "../utils/log";

const log = Log.create({ service: "event-bus" });

export type Listener = (event: FlywheelEvent) => void;
export type TypedListener<T extends FlywheelEvent["type"]> = (
  event: Extract<FlywheelEvent, { type: T }>
) => void;
export type Unsubscribe = () => void;

/**
 * Synchronous event bus (v1).
 *
 * Two subscriber types:
 * - catch-all: receives every event
 * - type-specific: receives only events of a given type
 *
 * Adapters must be O(1). Async emit may be needed for TUI adapter in Plan 2;
 * design interface to be swappable.
 */
export class EventBus {
  private catchAll = new Set<Listener>();
  private typed = new Map<FlywheelEvent["type"], Set<Listener>>();

  /**
   * Subscribe to all events. Returns an unsubscribe closure.
   */
  subscribe(listener: Listener): Unsubscribe {
    this.catchAll.add(listener);
    return () => {
      this.catchAll.delete(listener);
    };
  }

  /**
   * Subscribe to a specific event type. Returns an unsubscribe closure.
   */
  subscribeToType<T extends FlywheelEvent["type"]>(
    type: T,
    listener: TypedListener<T>,
  ): Unsubscribe {
    if (!this.typed.has(type)) {
      this.typed.set(type, new Set());
    }
    const set = this.typed.get(type)!;
    // Cast is safe because we only invoke with matching type
    const wrapped = listener as Listener;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  /**
   * Subscribe to the next event only (one-time).
   * Useful for lifecycle events.
   */
  once(listener: Listener): Unsubscribe {
    const unsub = this.subscribe((event) => {
      unsub();
      listener(event);
    });
    return unsub;
  }

  /**
   * Subscribe to the next event of a specific type only (one-time).
   */
  onceType<T extends FlywheelEvent["type"]>(
    type: T,
    listener: TypedListener<T>,
  ): Unsubscribe {
    const unsub = this.subscribeToType(type, ((event: FlywheelEvent) => {
      unsub();
      (listener as TypedListener<T>)(event as Extract<FlywheelEvent, { type: T }>);
    }) as TypedListener<T>);
    return unsub;
  }

  /**
   * Emit an event to all subscribers. Catches errors per listener
   * to prevent one bad listener from breaking others.
   */
  emit(event: FlywheelEvent): void {
    // Catch-all listeners
    for (const listener of this.catchAll) {
      try {
        listener(event);
      } catch (err) {
        log.error("catch-all listener error", { type: event.type, error: err instanceof Error ? err : String(err) });
      }
    }
    // Type-specific listeners
    const typedSet = this.typed.get(event.type);
    if (typedSet) {
      for (const listener of typedSet) {
        try {
          listener(event);
        } catch (err) {
          log.error("typed listener error", { type: event.type, error: err instanceof Error ? err : String(err) });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Named emitter facade
// ---------------------------------------------------------------------------

export interface FlywheelEmitter {
  workflowStarted(workflowId: string, planPath: string): void;
  workflowCompleted(workflowId: string): void;
  workflowFailed(workflowId: string, reason: string): void;
  workflowInterrupted(workflowId: string, reason: string): void;
  stepStarted(workflowId: string, stepIndex: number, description: string): void;
  stepCompleted(workflowId: string, stepIndex: number): void;
  stepFailed(workflowId: string, stepIndex: number, reason: string): void;
  dispatcherInvoked(workflowId: string, stepIndex: number): void;
  dispatcherCompleted(workflowId: string, decision: import("../schemas/dispatcher").DispatcherDecision): void;
  dispatcherFailed(workflowId: string, reason: string): void;
  dispatcherOutput(workflowId: string, stream: "stdout" | "stderr", data: string, engineName: string): void;
  evaluatorInvoked(workflowId: string, stepIndex: number): void;
  evaluatorCompleted(workflowId: string, result: import("../schemas/evaluator").EvaluatorResult): void;
  evaluatorFailed(workflowId: string, reason: string): void;
  evaluatorRevisionRequested(workflowId: string, stepIndex: number, revisionAttempt: number, maxRevisions: number, reason: string): void;
  evaluatorOutput(workflowId: string, stream: "stdout" | "stderr", data: string, engineName: string): void;
  workerSpawned(workflowId: string, stepIndex: number): void;
  workerCompleted(workflowId: string, result: import("../schemas/worker").WorkerResult): void;
  workerFailed(workflowId: string, failure: import("../schemas/worker").WorkerFailureReason): void;
  workerRetrying(workflowId: string, attempt: number, maxAttempts: number, reason: string): void;
  workerOutput(workflowId: string, stream: "stdout" | "stderr", data: string, engineId?: string): void;
  workerInjected(workflowId: string, message: string): void;
  approvalRequested(workflowId: string, stepIndex: number, description: string): void;
  approvalReceived(workflowId: string, approved: boolean, skipped: boolean): void;
  // Queue lifecycle events
  queueInitialized(workflowId: string, stepIds: string[]): void;
  queueCompleted(workflowId: string, stepsCompleted: number): void;
  queueFailed(workflowId: string, reason: string, stepsCompleted: number): void;
  // Queue step lifecycle events
  queueStepStarted(workflowId: string, stepId: string, stepType: string, stepTitle: string): void;
  queueStepCompleted(workflowId: string, stepId: string, stepType: string, stepTitle: string): void;
  queueStepFailed(workflowId: string, stepId: string, stepType: string, stepTitle: string, reason: string): void;
  // Queue mutation events
  queueStepInserted(workflowId: string, stepId: string, stepType: string, stepTitle: string, afterStepId: string): void;
  queueStepRemoved(workflowId: string, stepId: string, stepType: string, stepTitle: string): void;
}

function now(): string {
  return new Date().toISOString();
}

export function createFlywheelEmitter(bus: EventBus): FlywheelEmitter {
  return {
    workflowStarted: (workflowId, planPath) =>
      bus.emit({ type: "workflow:started", workflowId, planPath, timestamp: now() }),
    workflowCompleted: (workflowId) =>
      bus.emit({ type: "workflow:completed", workflowId, timestamp: now() }),
    workflowFailed: (workflowId, reason) =>
      bus.emit({ type: "workflow:failed", workflowId, reason, timestamp: now() }),
    workflowInterrupted: (workflowId, reason) =>
      bus.emit({ type: "workflow:interrupted", workflowId, reason, timestamp: now() }),
    stepStarted: (workflowId, stepIndex, description) =>
      bus.emit({ type: "step:started", workflowId, stepIndex, description, timestamp: now() }),
    stepCompleted: (workflowId, stepIndex) =>
      bus.emit({ type: "step:completed", workflowId, stepIndex, timestamp: now() }),
    stepFailed: (workflowId, stepIndex, reason) =>
      bus.emit({ type: "step:failed", workflowId, stepIndex, reason, timestamp: now() }),
    dispatcherInvoked: (workflowId, stepIndex) =>
      bus.emit({ type: "dispatcher:invoked", workflowId, stepIndex, timestamp: now() }),
    dispatcherCompleted: (workflowId, decision) =>
      bus.emit({ type: "dispatcher:completed", workflowId, decision, timestamp: now() }),
    dispatcherFailed: (workflowId, reason) =>
      bus.emit({ type: "dispatcher:failed", workflowId, reason, timestamp: now() }),
    dispatcherOutput: (workflowId, stream, data, engineName) =>
      bus.emit({ type: "dispatcher:output", workflowId, stream, data, engineName, timestamp: Date.now() }),
    evaluatorInvoked: (workflowId, stepIndex) =>
      bus.emit({ type: "evaluator:invoked", workflowId, stepIndex, timestamp: now() }),
    evaluatorCompleted: (workflowId, result) =>
      bus.emit({ type: "evaluator:completed", workflowId, result, timestamp: now() }),
    evaluatorFailed: (workflowId, reason) =>
      bus.emit({ type: "evaluator:failed", workflowId, reason, timestamp: now() }),
    evaluatorRevisionRequested: (workflowId, stepIndex, revisionAttempt, maxRevisions, reason) =>
      bus.emit({ type: "evaluator:revision-requested", workflowId, stepIndex, revisionAttempt, maxRevisions, reason, timestamp: Date.now() }),
    evaluatorOutput: (workflowId, stream, data, engineName) =>
      bus.emit({ type: "evaluator:output", workflowId, stream, data, engineName, timestamp: Date.now() }),
    workerSpawned: (workflowId, stepIndex) =>
      bus.emit({ type: "worker:spawned", workflowId, stepIndex, timestamp: now() }),
    workerCompleted: (workflowId, result) =>
      bus.emit({ type: "worker:completed", workflowId, result, timestamp: now() }),
    workerFailed: (workflowId, failure) =>
      bus.emit({ type: "worker:failed", workflowId, failure, timestamp: now() }),
    workerRetrying: (workflowId, attempt, maxAttempts, reason) =>
      bus.emit({ type: "worker:retrying", workflowId, attempt, maxAttempts, reason, timestamp: now() }),
    workerOutput: (workflowId, stream, data, engineId?) =>
      bus.emit({ type: "worker:output", workflowId, stream, data, timestamp: now(), ...(engineId !== undefined ? { engineId } : {}) }),
    workerInjected: (workflowId, message) =>
      bus.emit({ type: "worker:injected", workflowId, message, timestamp: now() }),
    approvalRequested: (workflowId, stepIndex, description) =>
      bus.emit({ type: "approval:requested", workflowId, stepIndex, description, timestamp: now() }),
    approvalReceived: (workflowId, approved, skipped) =>
      bus.emit({ type: "approval:received", workflowId, approved, skipped, timestamp: now() }),
    // Queue lifecycle events
    queueInitialized: (workflowId, stepIds) =>
      bus.emit({ type: "queue:initialized", workflowId, stepIds, timestamp: now() }),
    queueCompleted: (workflowId, stepsCompleted) =>
      bus.emit({ type: "queue:completed", workflowId, stepsCompleted, timestamp: now() }),
    queueFailed: (workflowId, reason, stepsCompleted) =>
      bus.emit({ type: "queue:failed", workflowId, reason, stepsCompleted, timestamp: now() }),
    // Queue step lifecycle events
    queueStepStarted: (workflowId, stepId, stepType, stepTitle) =>
      bus.emit({ type: "queue:step-started", workflowId, stepId, stepType, stepTitle, timestamp: now() }),
    queueStepCompleted: (workflowId, stepId, stepType, stepTitle) =>
      bus.emit({ type: "queue:step-completed", workflowId, stepId, stepType, stepTitle, timestamp: now() }),
    queueStepFailed: (workflowId, stepId, stepType, stepTitle, reason) =>
      bus.emit({ type: "queue:step-failed", workflowId, stepId, stepType, stepTitle, reason, timestamp: now() }),
    // Queue mutation events
    queueStepInserted: (workflowId, stepId, stepType, stepTitle, afterStepId) =>
      bus.emit({ type: "queue:step-inserted", workflowId, stepId, stepType, stepTitle, afterStepId, timestamp: now() }),
    queueStepRemoved: (workflowId, stepId, stepType, stepTitle) =>
      bus.emit({ type: "queue:step-removed", workflowId, stepId, stepType, stepTitle, timestamp: now() }),
  };
}
