import { createEmit, type EventBus } from "../../src/infra/substrate/events/event-bus"
import type { FlywheelEventData, FlywheelEventType } from "../../src/infra/substrate/events/events"

export function emitTestEvent<T extends FlywheelEventType>(
  bus: EventBus,
  type: T,
  sessionId: string,
  data: FlywheelEventData<T>,
): void {
  createEmit(bus)<T>(type, { sessionId, data })
}
