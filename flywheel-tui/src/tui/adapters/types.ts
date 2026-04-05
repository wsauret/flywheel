import type { EventBus } from "../../protocol/event-bus.js";
import type { FlywheelEvent } from "../../protocol/events.js";

export type AdapterType = "opentui" | "mock" | "headless";

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

  /** Whether the UI is actively rendering. */
  isRunning(): boolean;

  /** Whether the adapter is connected to an event bus. */
  isConnected(): boolean;

  /** Optional callback for approval decisions. */
  onApprovalDecision?: (approved: boolean, skip?: boolean) => void;
}
