import type { RuntimeEvent } from "./runtime-event-types.js"

type DataFor<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>["data"]

/** Builds one in-process runtime event. The data type is the schema type of the
 *  event's definition, so the event is typed at construction and no decode
 *  runs; only a process boundary decodes an event. */
export function createRuntimeEvent<T extends RuntimeEvent["type"]>(
  type: T,
  data: DataFor<T>,
) {
  return { type, data }
}
