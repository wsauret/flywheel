import type { FlywheelEvent } from "../../src/infra/events";
import type { EventBus, Unsubscribe } from "../../src/infra/event-bus";

/**
 * MockAdapter — connects to event bus, records events.
 * Implements WorkflowAdapter interface for test use.
 */
export class MockAdapter {
  events: FlywheelEvent[] = [];
  private eventBus: EventBus | null = null;
  private unsubscribe: Unsubscribe | null = null;

  connect(eventBus: EventBus): void {
    if (this.eventBus) this.disconnect();
    this.eventBus = eventBus;
    this.unsubscribe = eventBus.subscribe((event) => { this.events.push(event); });
  }

  start(): void {}
  stop(): void {}

  disconnect(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    this.eventBus = null;
  }

  reset(): void {
    this.events = [];
    if (this.eventBus) {
      const bus = this.eventBus;
      this.disconnect();
      this.connect(bus);
    }
  }
}
