import type { EventBus } from "../../events/event-bus";
import type { FlywheelEvent } from "../../events/types";
import type { AdapterType } from "./types";
import { BaseUIAdapter } from "./base";

/**
 * MockAdapter — connects to event bus, records events.
 *
 * Public `events` field (no getter — matches CodeMachine pattern).
 * `reset()`: clears events AND re-subscribes (prevents test isolation bug).
 */
export class MockAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "mock";

  /** All events received since last reset. */
  events: FlywheelEvent[] = [];

  protected handleEvent(event: FlywheelEvent): void {
    this.events.push(event);
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
