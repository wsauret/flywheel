import type { FlywheelEvent } from "./types";

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
        console.error(
          `[EventBus] Error in catch-all listener for ${event.type}:`,
          err,
        );
      }
    }
    // Type-specific listeners
    const typedSet = this.typed.get(event.type);
    if (typedSet) {
      for (const listener of typedSet) {
        try {
          listener(event);
        } catch (err) {
          console.error(
            `[EventBus] Error in typed listener for ${event.type}:`,
            err,
          );
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
  phaseStarted(workflowId: string, phaseIndex: number, phaseName: string): void;
  phaseCompleted(workflowId: string, phaseIndex: number): void;
  phaseFailed(workflowId: string, phaseIndex: number, reason: string): void;
  stepStarted(workflowId: string, phaseIndex: number, stepIndex: number, description: string): void;
  stepCompleted(workflowId: string, phaseIndex: number, stepIndex: number): void;
  stepFailed(workflowId: string, phaseIndex: number, stepIndex: number, reason: string): void;
  dispatcherInvoked(workflowId: string, phaseIndex: number, stepIndex: number): void;
  dispatcherCompleted(workflowId: string, decision: import("../schemas/dispatcher").DispatcherDecision): void;
  dispatcherFailed(workflowId: string, reason: string): void;
  evaluatorInvoked(workflowId: string, phaseIndex: number, stepIndex: number): void;
  evaluatorCompleted(workflowId: string, result: import("../schemas/evaluator").EvaluatorResult): void;
  evaluatorFailed(workflowId: string, reason: string): void;
  workerSpawned(workflowId: string, phaseIndex: number, stepIndex: number): void;
  workerCompleted(workflowId: string, result: import("../schemas/worker").WorkerResult): void;
  workerFailed(workflowId: string, failure: import("../schemas/worker").WorkerFailureReason): void;
  workerRetrying(workflowId: string, attempt: number, maxAttempts: number, reason: string): void;
  workerOutput(workflowId: string, stream: "stdout" | "stderr", data: string, engineId?: string): void;
  approvalRequested(workflowId: string, phaseIndex: number, stepIndex: number, description: string): void;
  approvalReceived(workflowId: string, approved: boolean, skipped: boolean): void;
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
    phaseStarted: (workflowId, phaseIndex, phaseName) =>
      bus.emit({ type: "phase:started", workflowId, phaseIndex, phaseName, timestamp: now() }),
    phaseCompleted: (workflowId, phaseIndex) =>
      bus.emit({ type: "phase:completed", workflowId, phaseIndex, timestamp: now() }),
    phaseFailed: (workflowId, phaseIndex, reason) =>
      bus.emit({ type: "phase:failed", workflowId, phaseIndex, reason, timestamp: now() }),
    stepStarted: (workflowId, phaseIndex, stepIndex, description) =>
      bus.emit({ type: "step:started", workflowId, phaseIndex, stepIndex, description, timestamp: now() }),
    stepCompleted: (workflowId, phaseIndex, stepIndex) =>
      bus.emit({ type: "step:completed", workflowId, phaseIndex, stepIndex, timestamp: now() }),
    stepFailed: (workflowId, phaseIndex, stepIndex, reason) =>
      bus.emit({ type: "step:failed", workflowId, phaseIndex, stepIndex, reason, timestamp: now() }),
    dispatcherInvoked: (workflowId, phaseIndex, stepIndex) =>
      bus.emit({ type: "dispatcher:invoked", workflowId, phaseIndex, stepIndex, timestamp: now() }),
    dispatcherCompleted: (workflowId, decision) =>
      bus.emit({ type: "dispatcher:completed", workflowId, decision, timestamp: now() }),
    dispatcherFailed: (workflowId, reason) =>
      bus.emit({ type: "dispatcher:failed", workflowId, reason, timestamp: now() }),
    evaluatorInvoked: (workflowId, phaseIndex, stepIndex) =>
      bus.emit({ type: "evaluator:invoked", workflowId, phaseIndex, stepIndex, timestamp: now() }),
    evaluatorCompleted: (workflowId, result) =>
      bus.emit({ type: "evaluator:completed", workflowId, result, timestamp: now() }),
    evaluatorFailed: (workflowId, reason) =>
      bus.emit({ type: "evaluator:failed", workflowId, reason, timestamp: now() }),
    workerSpawned: (workflowId, phaseIndex, stepIndex) =>
      bus.emit({ type: "worker:spawned", workflowId, phaseIndex, stepIndex, timestamp: now() }),
    workerCompleted: (workflowId, result) =>
      bus.emit({ type: "worker:completed", workflowId, result, timestamp: now() }),
    workerFailed: (workflowId, failure) =>
      bus.emit({ type: "worker:failed", workflowId, failure, timestamp: now() }),
    workerRetrying: (workflowId, attempt, maxAttempts, reason) =>
      bus.emit({ type: "worker:retrying", workflowId, attempt, maxAttempts, reason, timestamp: now() }),
    workerOutput: (workflowId, stream, data, engineId?) =>
      bus.emit({ type: "worker:output", workflowId, stream, data, timestamp: now(), ...(engineId !== undefined ? { engineId } : {}) }),
    approvalRequested: (workflowId, phaseIndex, stepIndex, description) =>
      bus.emit({ type: "approval:requested", workflowId, phaseIndex, stepIndex, description, timestamp: now() }),
    approvalReceived: (workflowId, approved, skipped) =>
      bus.emit({ type: "approval:received", workflowId, approved, skipped, timestamp: now() }),
  };
}
