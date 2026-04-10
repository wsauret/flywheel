/**
 * BaseEventConsumer — abstract base for anything that consumes events from an EventBus.
 *
 * Pure infrastructure class with no TUI dependencies.
 * Lifecycle: connect(eventBus) -> start() -> ... -> stop() -> disconnect()
 *
 * - `connect()`: guards against double-connect — disconnects first if already connected.
 * - `disconnect()`: calls unsubscribe, nulls references.
 * - Subclasses implement `handleEvent(event)`.
 */

import type { EventBus, Unsubscribe } from "./event-bus.js";
import type { FlywheelEvent } from "./events.js";

export abstract class BaseEventConsumer {
  protected eventBus: EventBus | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private running = false;

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
    this.running = false;
  }

  /** Extension point for subclasses. HeadlessAdapter overrides for log stream I/O. */
  start(): void { this.running = true; }

  /** Extension point for subclasses. HeadlessAdapter overrides for log stream cleanup. */
  stop(): void { this.running = false; }

  isRunning(): boolean { return this.running; }

  isConnected(): boolean { return this.eventBus !== null; }

  /**
   * Handle a single FlywheelEvent. Subclasses should implement
   * event routing (e.g. exhaustive switch).
   */
  protected abstract handleEvent(event: FlywheelEvent): void;
}
