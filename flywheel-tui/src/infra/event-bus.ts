import type { FlywheelEvent } from "./events";
import { Log } from "./log.js";

type Listener = (event: FlywheelEvent) => void;
type TypedListener<T extends FlywheelEvent["type"]> = (
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
const log = Log.create({ service: "event-bus" });

export class EventBus {
  private catchAll = new Set<Listener>();
  private typed = new Map<FlywheelEvent["type"], Set<Listener>>();

  subscribe(listener: Listener): Unsubscribe {
    this.catchAll.add(listener);
    return () => {
      this.catchAll.delete(listener);
    };
  }

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
        log.warn("catch-all listener error", { eventType: event.type, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    // Type-specific listeners
    const typedSet = this.typed.get(event.type);
    if (typedSet) {
      for (const listener of typedSet) {
        try {
          listener(event);
        } catch (err) {
          log.warn("typed listener error", { eventType: event.type, error: err instanceof Error ? err : new Error(String(err)) });
        }
      }
    }
  }
}

// Generic typed emitter

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

/** A no-op emit function for callers that don't need EventBus integration. */
export function createNoopEmit(): EmitFn {
  return (() => {}) as EmitFn
}

export function createEmit(bus: EventBus): EmitFn {
  return (type, payload) => {
    // Cast is safe: EmitFn's conditional type validates payload at call site.
    // TypeScript cannot structurally prove that { ...Omit<X, "type"|"timestamp">, type: T, timestamp: number }
    // satisfies the discriminated union FlywheelEvent because the spread erases discriminant narrowing.
    bus.emit({ ...payload, type, timestamp: Date.now() } as unknown as FlywheelEvent)
  }
}
