import type { EventBus } from "../../infra/event-bus.js";
import type { FlywheelEvent } from "../../infra/events.js";

export type AdapterType = "opentui";

/**
 * IWorkflowUI — interface for workflow UI adapters.
 *
 * Lifecycle: connect(eventBus) → start() → ... → stop() → disconnect()
 */
export interface IWorkflowUI {
  readonly adapterType: AdapterType;

  /** Connect to the event bus. */
  connect(eventBus: EventBus): void;

  /** Disconnect from the event bus. */
  disconnect(): void;

  /** Start the UI (rendering, etc.). */
  start(): void;

  /** Stop the UI. */
  stop(): void;

  /** Optional callback for approval decisions. */
  onApprovalDecision?: (approved: boolean, skip?: boolean) => void;
}
