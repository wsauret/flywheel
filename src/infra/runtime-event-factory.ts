import type { RuntimeEvent } from "./runtime-event-types.js"
import { parseRuntimeEventPayload } from "./runtime-event-types.js"

type DataFor<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>["data"]

export function createRuntimeEvent<T extends RuntimeEvent["type"]>(
  type: T,
  data: DataFor<T>,
): Extract<RuntimeEvent, { type: T }> {
  return parseRuntimeEventPayload(type, data)
}
