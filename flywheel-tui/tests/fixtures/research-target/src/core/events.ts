/**
 * EventBus — typed event emitter for task lifecycle events.
 *
 * Provides pub/sub for task queue events (enqueued, started, completed,
 * failed) and queue-level events (started, stopped, completed).
 */

export type TaskEventType =
  | "task:enqueued"
  | "task:started"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  | "queue:started"
  | "queue:completed"
  | "queue:stopped";

export interface TaskEvent {
  taskId?: string;
  taskName?: string;
  [key: string]: unknown;
}

type EventHandler = (data: TaskEvent) => void;

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  /**
   * Subscribe to an event type.
   */
  on(event: TaskEventType | string, handler: EventHandler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  /**
   * Unsubscribe a handler from an event type.
   */
  off(event: TaskEventType | string, handler: EventHandler): void {
    const existing = this.handlers.get(event);
    if (!existing) return;
    this.handlers.set(
      event,
      existing.filter((h) => h !== handler),
    );
  }

  /**
   * Emit an event to all subscribed handlers.
   */
  emit(event: TaskEventType | string, data: TaskEvent): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch {
        // Swallow handler errors to prevent event propagation failure
      }
    }
  }

  /**
   * Remove all handlers for all events.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get the count of handlers for a given event.
   */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}
