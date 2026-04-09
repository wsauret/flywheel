import type { FlywheelEvent } from "./events";

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
   * Emit an event to all subscribers. Catches errors per listener
   * to prevent one bad listener from breaking others.
   */
  emit(event: FlywheelEvent): void {
    // Catch-all listeners
    for (const listener of this.catchAll) {
      try {
        listener(event);
      } catch (err) {
        console.error("[event-bus] catch-all listener error", event.type, err);
      }
    }
    // Type-specific listeners
    const typedSet = this.typed.get(event.type);
    if (typedSet) {
      for (const listener of typedSet) {
        try {
          listener(event);
        } catch (err) {
          console.error("[event-bus] typed listener error", event.type, err);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Generic typed emitter
// ---------------------------------------------------------------------------

/**
 * Type-safe event emitter. Payload shape is inferred from the event type string
 * via the FlywheelEvent discriminated union.
 *
 * If TypeScript says the payload type is `never`, the type string doesn't match
 * any FlywheelEvent — check for typos.
 */
export type EmitFn = <T extends FlywheelEvent["type"]>(
  type: T,
  payload: Omit<Extract<FlywheelEvent, { type: T }>, "type" | "timestamp">,
) => void

export function createEmit(bus: EventBus): EmitFn {
  return (type, payload) => {
    // Cast is safe: EmitFn's conditional type validates payload at call site.
    // TypeScript cannot structurally prove that { ...Omit<X, "type"|"timestamp">, type: T, timestamp: number }
    // satisfies the discriminated union FlywheelEvent because the spread erases discriminant narrowing.
    bus.emit({ ...payload, type, timestamp: Date.now() } as unknown as FlywheelEvent)
  }
}
