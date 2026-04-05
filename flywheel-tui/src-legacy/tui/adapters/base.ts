import type { EventBus, Unsubscribe } from "../../events/event-bus";
import type { FlywheelEvent } from "../../events/types";
import type { AdapterType, IWorkflowUI } from "./types";

/**
 * BaseUIAdapter — abstract base for UI adapters.
 *
 * - `connect()`: guards against double-connect — disconnects first if already connected.
 * - `disconnect()`: calls unsubscribe, nulls references.
 * - Subclasses implement `handleEvent(event)` — use `assertNever` for exhaustiveness.
 */
export abstract class BaseUIAdapter implements IWorkflowUI {
  abstract readonly adapterType: AdapterType;

  protected eventBus: EventBus | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private running = false;

  onApprovalDecision?: (approved: boolean, skip?: boolean) => void;

  connect(eventBus: EventBus): void {
    // Guard against double-connect
    if (this.eventBus) {
      this.disconnect();
    }
    this.eventBus = eventBus;
    this.unsubscribe = eventBus.subscribe((event) => this.handleEvent(event));
  }

  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.eventBus = null;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  isConnected(): boolean {
    return this.eventBus !== null;
  }

  /**
   * Handle a single FlywheelEvent. Subclasses should use assertNever
   * in a switch default case for exhaustiveness.
   */
  protected abstract handleEvent(event: FlywheelEvent): void;
}
