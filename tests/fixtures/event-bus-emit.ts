import { createEmit, type EventBus } from "../../src/infra/event-bus"
import type { FlywheelEventData, FlywheelEventType } from "../../src/infra/events"

export function emitTestEvent<T extends FlywheelEventType>(
  bus: EventBus,
  type: T,
  sessionId: string,
  data: FlywheelEventData<T>,
): void {
  createEmit(bus)<T>(type, { sessionId, data })
}
