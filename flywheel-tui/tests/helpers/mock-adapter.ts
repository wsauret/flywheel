import type { FlywheelEvent } from "../../src/infra/events";
import { assertNever } from "../../src/infra/events";
import type { AdapterType } from "../../src/tui/adapters/types";
import { BaseUIAdapter } from "../../src/tui/adapters/base";

/**
 * MockAdapter — connects to event bus, records events.
 *
 * Public `events` field (no getter — matches CodeMachine pattern).
 * `reset()`: clears events AND re-subscribes (prevents test isolation bug).
 *
 * Uses exhaustive switch for compile-time safety — adding a new event type
 * without a case here causes a compile-time error (matches OpenTUI/Headless pattern).
 */
export class MockAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "mock";

  /** All events received since last reset. */
  events: FlywheelEvent[] = [];

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      // Dispatcher events
      case "dispatcher:invoked":
      case "dispatcher:completed":
      case "dispatcher:failed":
      case "dispatcher:output":
      // Evaluator events
      case "evaluator:invoked":
      case "evaluator:completed":
      case "evaluator:failed":
      case "evaluator:revision-requested":
      case "evaluator:output":
      // Subprocess events
      case "subprocess:spawned":
      case "subprocess:completed":
      case "subprocess:failed":
      case "subprocess:retrying":
      case "subprocess:output":
      case "subprocess:injected":
      // Approval events
      case "approval:requested":
      case "approval:received":
      // Question events
      case "question:asked":
      case "question:replied":
      case "question:rejected":
      // Budget events
      case "budget:warning":
      case "budget:exhausted":
      // Queue lifecycle events
      case "queue:initialized":
      case "queue:completed":
      case "queue:failed":
      // Queue step events
      case "queue:step-started":
      case "queue:step-completed":
      case "queue:step-failed":
      // Queue mutation events
      case "queue:step-inserted":
      case "queue:step-removed":
        this.events.push(event);
        break;
      default:
        assertNever(event);
    }
  }

  /**
   * Clear events AND re-subscribe to prevent test isolation bugs.
   * Must be connected to an event bus.
   */
  reset(): void {
    this.events = [];
    if (this.eventBus) {
      // Disconnect and reconnect to get a fresh subscription
      const bus = this.eventBus;
      this.disconnect();
      this.connect(bus);
    }
  }
}
